"""
Register binding: ectra names on one side, plant units on the other.

The only module that knows what a register is called,
so `plant.py` stays a control problem and `client.py` stays transport.

Reads a register cache into a `Command`, writes plant state back out.
"""

import math

from sim import SimulatedClient
from .command import Command
from .machine import V_PEAK, wrap
from .names import (
  AUTH_KEYS, CURVE_GROUPS, CURVE_NAME, OWNED, REQUIRED, STANDING, TIERS,
)

# Line-to-line to phase, for the one nameplate constant given between phases.
SQRT3 = 1.7320508

#------------------------------------------------------------------------------------------ Binding

class Binding:
  """One register map, resolved once and read every tick."""
  def __init__(self, id_map:dict):
    self.id_map = id_map
    self.rid = {e["fullname"]: e["id"] for e in id_map.values()}
    self.curves = {g: self._curve(g) for g in CURVE_GROUPS}
    self.dark = self._dark()

  @staticmethod
  def match(id_map:dict) -> bool:
    names = {e["fullname"] for e in id_map.values()}
    return all(n in names for n in REQUIRED)

  def _curve(self, group:str) -> list:
    """`Group:<n>Hz` rows → `[(hz, reg_id, scale), ...]` sorted by frequency."""
    rows = []
    for e in self.id_map.values():
      if e["group"] != group: continue
      m = CURVE_NAME.match(e["name"])
      if m: rows.append((float(m.group(1)), e["id"], e.get("scale", 1.0) or 1.0))
    rows.sort()
    return rows

  def _dark(self) -> dict:
    """`{reg_id: sentinel}` for every reading the model cannot stand behind.
    Built once, because the answer does not change while the map does not."""
    out = {}
    for e in self.id_map.values():
      if e["rws"] != "R" or e["fullname"] in OWNED: continue
      null = e.get("null_raw")
      if null is not None: out[e["id"]] = null
    return out

  #--------------------------------------------------------------------------------------- Decoding

  def _eng(self, values:dict, name:str, fallback:float=0.0) -> float:
    rid = self.rid.get(name)
    if rid is None: return fallback
    # The parent already decodes sign and scale per type.
    # Reimplementing that here is exactly the duplication that drifts.
    return SimulatedClient._raw_to_eng(self.id_map[rid], values.get(rid, 0))

  def _label(self, values:dict, name:str, fallback:str) -> str:
    rid = self.rid.get(name)
    if rid is None: return fallback
    return self.id_map[rid].get("enum", {}).get(values.get(rid, 0), fallback)

  def _index(self, values:dict, name:str, fallback:int=0) -> int:
    """An enum as the number behind it, for the few read as a selector."""
    rid = self.rid.get(name)
    return fallback if rid is None else values.get(rid, fallback)

  def _points(self, values:dict, group:str) -> list:
    """A curve resolved against today's live register values."""
    return [(hz, values.get(rid, 0) / scale) for hz, rid, scale in self.curves[group]]

  def _rule_hz(self, values:dict, name:str, slot:str) -> float|None:
    """A `type=rule` register read through whichever unit slot matches `slot`.
    Scale is per-slot too, so slot 0 would be the wrong divisor for Hz."""
    rid = self.rid.get(name)
    if rid is None: return None
    entry = self.id_map[rid]
    units = entry.get("unit")
    if not isinstance(units, list): return None
    for i, u in enumerate(units):
      if str(u).lower() != slot.lower(): continue
      scales = entry.get("scale", 1.0)
      scale = scales[i] if isinstance(scales, list) and i < len(scales) else scales
      return values.get(rid, 0) / (scale or 1.0)
    return None

  def _ke_v_hz(self, values:dict, poles:float) -> float:
    """`Motor:Ke` is a nameplate constant: line-to-line RMS volts per MECHANICAL krpm.
    The plant works in phase RMS per ELECTRICAL Hz,
    so both conversions happen here, where the pole count lives."""
    ke = self._eng(values, "Motor:Ke", 0.0)
    if not ke: return 0.0
    return ke / (1000.0 / 60.0 * poles) / SQRT3

  def _resonance(self, values:dict, hz:float, rpm_hz:float, lo:float,
    hi:float) -> float:
    """`LINK_ResonanceEscape`: leave every configured band by its nearest edge.
    Overlapping bands are merged first, and an edge the speed limits reject is never chosen,
    so a band reaching under `Speed:Min` is left upward."""
    zones = []
    for i in (0, 1, 2):
      low = self._eng(values, f"Resonance:{i}Low", 0.0) * rpm_hz
      high = self._eng(values, f"Resonance:{i}High", 0.0) * rpm_hz
      if low and high and high > low: zones.append((low, high))
    if not zones: return hz
    zones.sort()
    merged = [zones[0]]
    for low, high in zones[1:]:
      if low <= merged[-1][1]: merged[-1] = (merged[-1][0], max(merged[-1][1], high))
      else: merged.append((low, high))
    for low, high in merged:
      if hz <= low or hz >= high: continue
      if hi and high > hi: return low
      if low < lo: return high
      return low if hz - low < high - hz else high
    return hz

  def _access(self, values:dict) -> str:
    """The level the written secret unlocks.
    The halves are `hex` registers holding one 32-bit key,
    so they are read raw and joined here."""
    high = values.get(self.rid.get("Auth:SecretHigh"), 0)
    low = values.get(self.rid.get("Auth:SecretLow"), 0)
    return AUTH_KEYS.get((high << 16) | low, "guest")

  #-------------------------------------------------------------------------------------- Read side

  def target_hz(self, values:dict, held_hz:float) -> float:
    """`Ctrl:Mode` names the unit `Ctrl:Setpoint` carries; resolve it to Hz."""
    mode = self._label(values, "Ctrl:Mode", "off")
    poles = max(1.0, self._eng(values, "Motor:PolePairs", 2.0))
    if mode == "off": return 0.0
    if mode == "ai": return held_hz # no analog source to sample here
    if mode == "Hz": return max(0.0, self._rule_hz(values, "Ctrl:Setpoint", "Hz") or 0.0)
    if mode == "rpm":
      return max(0.0, (self._rule_hz(values, "Ctrl:Setpoint", "rpm") or 0.0) * poles / 60.0)
    if mode == "%":
      ceiling = self._eng(values, "Speed:Max", 3000.0) * poles / 60.0 or 300.0
      return max(0.0, (self._rule_hz(values, "Ctrl:Setpoint", "%") or 0.0) / 100.0 * ceiling)
    return 0.0

  def command(self, values:dict, held_hz:float) -> Command:
    """The whole register cache as one tick of intent."""
    poles = max(1.0, self._eng(values, "Motor:PolePairs", 2.0))
    rpm_hz = poles / 60.0
    return Command(
      # The resonance escape is ifc's, applied to the setpoint before sig sees it,
      # so it belongs to the binding and the plant never learns of it.
      target_hz=self._resonance(values, self.target_hz(values, held_hz), rpm_hz,
        self._eng(values, "Speed:Min", 0.0) * rpm_hz,
        self._eng(values, "Speed:Max", 0.0) * rpm_hz),
      # The device arms on the MODE, not on the number:
      # a suppressed or below-floor command still counts as enabled.
      enabled=self._label(values, "Ctrl:Mode", "off") != "off",
      mode=self._label(values, "Drive:Mode", "vf"),
      poles=poles,
      motor_type=self._index(values, "Motor:Type", 1),
      rise=self._points(values, "Rise"),
      fall=self._points(values, "Fall"),
      volt=self._points(values, "Volt"),
      curr=self._points(values, "Curr"),
      catch_hz=self._eng(values, "If:CatchFreq", 0.0),
      damp_pct=self._eng(values, "If:Damp", 100.0),
      entry_hz=self._eng(values, "Foc:EntryFreq", 0.0),
      entry_timeout_s=self._eng(values, "Foc:EntryTimeout", 0.0),
      lock_err_deg=self._eng(values, "Foc:LockErr", 22.0),
      lock_speed_pct=self._eng(values, "Foc:LockSpeed", 25.0),
      entry_glide_ms=self._eng(values, "Foc:EntryGlide", 400.0),
      fallback_low_hz=self._eng(values, "If:FallbackFreq", 2.0),
      fallback_high_hz=self._eng(values, "If:FallbackHigh", 3.0),
      align_ms=self._eng(values, "Drive:AlignTime", 700.0),
      init_hz=self._eng(values, "Drive:InitFreq", 0.5),
      # The speed limits are a working window in rpm,
      # and the low end doubles as where a stop cuts:
      # the drive cuts rather than crawl the last of the way.
      speed_min_hz=self._eng(values, "Speed:Min", 0.0) * rpm_hz,
      speed_max_hz=self._eng(values, "Speed:Max", 0.0) * rpm_hz,
      boot_delay_s=self._eng(values, "System:BootDelay", 0.0) / 1000.0,
      coast_s=self._eng(values, "Brake:Coast", 90.0),
      rs_ohm=self._eng(values, "Motor:Rs", 0.0) / 1000.0,
      lq_h=self._eng(values, "Motor:Lq", 0.0) / 1e6,
      ke_v_hz=self._ke_v_hz(values, poles),
      phasemap=self._index(values, "Sense:PhaseMap", 0),
      shunt_ok=bool(self._eng(values, "Sense:ShuntRes", 1.0))
        and bool(self._eng(values, "Sense:ShuntGain", 1.0)),
      shape=self._index(values, "Pwm:Shape", 1),
      deadtime_ns=self._eng(values, "Pwm:Deadtime", 2500.0),
      dtcomp_pct=self._eng(values, "Obs:DtComp", 0.0),
      pll_bw_hz=self._eng(values, "Pll:Bw", 30.0),
      pll_damp=self._eng(values, "Pll:Damp", 0.71),
      obs_hp_hz=self._eng(values, "Obs:HpHz", 1.6),
      retry_hold_s=self._eng(values, "Foc:RetryHold", 0.0),
      iq_max_a=self._eng(values, "Foc:IqMax", 10.0),
      curr_bw_hz=self._eng(values, "Foc:CurrBw", 300.0),
      mod_ceil_pct=self._eng(values, "Foc:ModCeil", 78.0),
      spd_kp=self._eng(values, "SpeedCtrl:Kp", 0.0),
      spd_ki=self._eng(values, "SpeedCtrl:Ki", 0.0),
      curr_rms_a=self._eng(values, "Thresh:CurrRms", 0.0),
      curr_peak_a=self._eng(values, "Thresh:CurrPeak", 0.0),
      peak_count=self._eng(values, "Thresh:PeakCount", 0.0),
      temp_max_c=self._eng(values, "Thresh:Temp", 0.0),
      stall_curr_a=self._eng(values, "Thresh:StallCurr", 0.0),
      stall_freq_hz=self._eng(values, "Thresh:StallFreq", 0.0),
      ripple_max_v=self._eng(values, "Thresh:Ripple", 0.0),
      dc_min_v=self._eng(values, "Thresh:DcBusMin", 0.0),
      dc_max_v=self._eng(values, "Thresh:DcBusMax", 780.0),
      derate_temp_c=self._eng(values, "Speed:DerateTemp", 0.0),
      derate_curr_a=self._eng(values, "Speed:DerateCurr", 0.0),
      derate_hz=self._eng(values, "Speed:DerateLimit", 0.0) * rpm_hz,
      regen_band_v=self._eng(values, "Brake:RegenBand", 0.0),
      freeze_low_v=self._eng(values, "Freeze:VdcLow", 0.0),
      freeze_high_v=self._eng(values, "Freeze:VdcHigh", 0.0),
      freeze_hyst_v=self._eng(values, "Freeze:VdcHyst", 5.0),
      clear_fault=bool(values.get(self.rid.get("Fault:Clear"), 0)),
    )

  #----------------------------------------------------------------------------------------- Meters

  def _meters(self, put, plant, poles:float):
    """Every reading that follows from the operating point, on both tiers.

    A balanced machine puts the same RMS through all three phases,
    so the per phase registers and their average carry one number.
    `Estim:*` and `Foc:V*` are the exceptions:
    they publish vector amplitude and modulation percent, not phase RMS."""
    m = plant.machine
    # `Meas` is the slow trend, `MeasCtrl` the fast one the protections read.
    # They are two different filters over one snapshot,
    # so on the run they disagree by exactly as much as the drive is moving.
    for tier, t in zip(TIERS, (plant.meters.view, plant.meters.ctrl)):
      # These carry the CONTROL domain, not the estimator:
      # the ramp step, and the observer once the loop is closed.
      # Standstill and coast fall back on the shaft, so a rotor still turning stays visible.
      put(f"{tier}:Freq", t.freq)
      put(f"{tier}:Speed", t.freq * 60.0 / poles)
      put(f"{tier}:CurrAvg", t.curr)
      put(f"{tier}:PeakMax", t.peak)
      for phase in ("U", "V", "W"):
        put(f"{tier}:Curr{phase}", t.curr)
        put(f"{tier}:Peak{phase}", t.peak)
      put(f"{tier}:Temp", t.temp)
      put(f"{tier}:ExTemp", t.temp)
      put(f"{tier}:DcBus", t.vdc)
      put(f"{tier}:Flyback", t.flyback)
      put(f"{tier}:Ripple", t.ripple)
      put(f"{tier}:Power", t.power)
    sc = plant.scope
    put("Bus:Peak", sc.bus.v)
    put("Bus:Max", sc.bus_max)
    # Raw and filtered bus are one value here, so they cannot disagree.
    put("Bus:Lag", 0.0)
    put("Pwm:DutyPeak", sc.duty.v)
    # The measurement the drive does NOT overwrite,
    # so it can disagree with the command and say so.
    # Amplitudes, not phase RMS, on the `Estim:*` axes.
    put("Estim:Freq", plant.estim_hz)
    # The applied field angle, wrapped to the register's signed degrees.
    # Useful mostly at standstill, which is exactly when it stops moving.
    put("Estim:FieldAngle", math.degrees(wrap(plant.machine.load_angle)))
    put("Estim:Id", m.id * V_PEAK)
    put("Estim:Iq", m.iq * V_PEAK)
    put("Foc:Vd", sc.vd.read())
    put("Foc:Vq", sc.vq.read())

  #------------------------------------------------------------------------------------- Write side

  def telemetry(self, plant, values:dict) -> dict:
    """Plant state → `{reg_id: raw}` for the registers the plant owns,
    over a floor of sentinels for the readings it does not."""
    poles = max(1.0, self._eng(values, "Motor:PolePairs", 2.0))
    out = dict(self.dark)
    def put(name, eng):
      rid = self.rid.get(name)
      if rid is not None: out[rid] = SimulatedClient._to_raw(self.id_map[rid], eng)

    m, ramp, det, sc = plant.machine, plant.ramp, plant.det, plant.scope
    put("Feedback:RenderFreq", ramp.hz)
    put("Feedback:RenderSpeed", ramp.hz * 60.0 / poles)
    # The operator's command after the mode conversion and NOTHING else.
    # `render.c` keeps the limited value in a local and publishes this one,
    # so while the ramp parks at `Foc:EntryFreq` the render runs ABOVE the setpoint:
    # a negative gap is the signature of an approach in progress.
    put("Feedback:SetpointFreq", plant.target)
    put("Feedback:SetpointSpeed", plant.target * 60.0 / poles)
    put("Feedback:Volt", m.volt)
    put("Feedback:ModIndex", m.mod_index)
    put("Feedback:State", plant.state)
    put("Drive:Stage", plant.vec)
    self._meters(put, plant, poles)
    put("Freeze:State", ramp.freeze)
    put("Freeze:HoldCount", ramp.holds)
    put("Brake:RegenCount", m.regens)
    # All four are 320ms means on the device, taken on its 10ms grid,
    # which is what makes a reading mean the same thing at 20Hz and at 55Hz.
    put("Obs:OmegaHat", sc.omega.read())
    put("Obs:AngleErr", sc.theta.read())
    # Estimate minus ramp, both from THE SAME tick before the mean.
    # Computed, never declared: an operator who subtracts `Obs:OmegaHat`
    # from `Feedback:RenderFreq` has to land on the same number,
    # or the two readings teach him to trust neither.
    put("Obs:Bias", sc.bias.read())
    put("Sync:Err", sc.err.read())
    put("Sync:ErrPeak", sc.err_peak.v)
    put("Sync:Lock", det.lock)
    put("Sync:LockPeak", sc.lock_peak.v)
    put("Sync:Takeovers", det.takeovers)
    put("Sync:Fallbacks", det.fallbacks)
    put("Sync:ExitCause", det.exit_cause)
    put("Sync:ExitTime", det.exit_ms)
    put("Foc:TakeoverDelta", det.delta * 180.0 / 3.14159265)
    put("Foc:Flags", plant.flags)
    # "Zastosowany prad fazowy RMS: wektor w I/f albo iq w FOC".
    # Under the forced vector the whole magnitude is the applied current,
    # and reporting only its torque projection would read as a drive doing almost nothing.
    put("Foc:IqCmd", plant.iq_ref if plant.vec == "closed" else m.curr)
    if plant.vec == "guard":
      for name, value in zip(("GuardVd", "GuardId", "GuardIdRef"), plant.guard):
        put(f"Foc:{name}", value)
    put("Fault:Code", plant.fault or "ok")
    put("Fault:PeakEvents", plant.prot.peaks)
    for name, key in (("Freq", "freq"), ("Curr", "curr"), ("Vdc", "vdc"), ("Temp", "temp")):
      if key in plant.trip: put(f"Fault:{name}", plant.trip[key])
    put("Counter:Hours", plant.hours)
    # Nothing in the model defers a configuration, so the two revisions agree.
    # A reader watching for a gap must not find one that never closes.
    put("Link:ConfigTarget", 1)
    put("Link:ConfigApplied", 1)
    put("Auth:Access", self._access(values))
    for name, value in STANDING.items(): put(name, value)
    # `Fault:Clear` is a command register: consume it here,
    # or every later tick would re-clear a fault the moment it appeared.
    rid = self.rid.get("Fault:Clear")
    if rid is not None: out[rid] = 0
    return out
