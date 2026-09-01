"""
The machine, the bridge that feeds it and the shaft it turns.

Knows nothing of stages, ramps or takeover gates:
hand it a voltage or a current reference and it answers with what the iron does.

Nothing here settles algebraically.
The winding, the load angle and the shaft are integrated on a sub-step
far below the poll interval, so a step in the command produces a transient
and the rotor rings around its load angle instead of teleporting to it.
That ringing IS the V/f hunting the tuning guide describes,
and in the vector modes it is what `If:Damp` leans against.

The constants are the machine's own TRUTH, separate from the `Motor:*` an operator typed in.
A nameplate entered wrong bends the observer and the loops; it does not bend the iron.

Example:
  >>> m = Machine()
  >>> round(m.emf(50.0), 1)
  29.0
"""

from math import atan2, cos, exp, pi as PI, sin, sqrt
from .command import Command
from .curve import clamp, interp

#-------------------------------------------------------------------------------- The 1500W machine

# Electrical side, from the end-of-line measurement in `foc-tests/plant/pmsm.c`.
RS_ohm = 0.898
LQ_H = 0.00627
# Phase RMS volts per ELECTRICAL Hz, the unit the whole package works in.
#
# Taken from the shipped `Volt` table and NOT from `Motor:Ke`.
# Decompose the table and it is exact: `Volt(f) - 0.40 f = 13.00 V`
# at every one of the nineteen anchors from 20Hz to 360Hz, with a clean IR boost added below.
# A curve that lands on the same constant nineteen times was generated, not measured,
# and 0.40 V/Hz is the back-EMF slope it was generated for.
# The nameplate says 100.6 V/krpm, i.e. 0.5808,
# a machine whose back-EMF would OVERTAKE its own table above 140Hz.
# No working drive does that.
KE_V_Hz = 0.40
POLES = 6
# How this board's current channels are really wired.
# `Sense:PhaseMap` ships as `invV` because that IS the correct map here,
# so the guard stays silent until somebody changes it,
# which is what makes the guard worth reading.
PHASEMAP = 2
# The dead-time loss this bridge really has, as a percentage of nominal.
# Hidden from the register map on purpose: `Obs:DtComp` is the operator's guess at it,
# and closing the gap is what the whole observer stage of the guide is about.
DTCOMP_pct = 60.0

# The shaft. Neither number is copied from `foc-tests`:
# that bench turns a different impeller on a different rotor,
# three pole pairs and four times the flux.
# Both are anchored where the register defaults pin them.
#   `kf`: `Speed:Max` has to be reachable inside `Foc:IqMax`,
#     which puts about 1.3kW on the shaft at the top of the range.
#   `J`: `Brake:Coast` is 90s quoted at 50Hz,
#     and a shaft coasting down against this same load takes that long only at this inertia.
INERTIA_kgm2 = 0.056
VISCOUS_Nms = 1e-3
FAN_Nms2 = 2.3e-4
LOAD_Nm = 0.0 # constant torque on top of the fan, a scenario's to set

#-------------------------------------------------------------------------------------- Integration

# The sub-step everything runs on,
# well under both the winding's `L/R` of about 7ms and the rotor swing's period of roughly 130ms.
# Coarser than this and the swing aliases into a jump,
# which is the one thing the model must not do.
SUB_s = 1e-3
SUB_MAX = 600
# Past this the rotor is unambiguously out of step,
# so the angle wraps and the torque it makes averages to nothing.
SLIP_rad = PI
# `If:Damp`, as `FOC_Step` implements it.
# Not a torque: the drive cannot make torque the current cannot make,
# so it leans the CONTROL FRAME instead
# and lets the lean change where the vector lands on the rotor.
#
#   `damp_k = if_damp_pct * 120 / 100`, and the lean is `-damp_vel * damp_k`
#   clamped to +-1456 of 65536, i.e. +-8 degrees. A trim, by construction.
#
# The signal is the SWING VELOCITY of the applied q-voltage,
# taken as a slope over 64 PWM periods
# and high-passed so the working point never enters the lean.
# `vq` is position-dominated at working load angles,
# which is why the slope is what a damper must oppose.
# Radians of lean per radian per second of swing at `If:Damp = 100%`,
# sized so a vigorous pendulum reaches the clamp and a quiet one barely leans at all.
DAMP_GAIN_s = 0.09
DAMP_MAX_rad = 8.0 * PI / 180.0
# The working point the lean must not see.
# A ramp holds a standing slip,
# and a damper that leaned on THAT would be a torque term wearing a damper's name.
DAMP_HP_s = 0.05
# Eddy currents in the magnets and the sleeve:
# a WEAK induction cage with a low pull-out slip, which is what such losses physically are.
# Below `ROTOR_SLIP` the torque is a viscous drag on the slip;
# past it the curve rolls off as `1/slip`,
# so a field running over a standing rotor drags it by almost nothing
# and a starved machine cannot spin up like a cage motor.
# What the term is FOR is the pendulum:
# a passing ramp sheds the ring it picked up in one band before it reaches the next,
# so a commanded stop crosses the unstable band a parked drive cannot survive.
# The growth there outruns a damping this small, it just needs minutes to reach a protection.
ROTOR_DAMP_Nms = 5e-4  # Nm per electrical rad/s of slip, at small slip
ROTOR_SLIP_rads = 9.4  # electrical slip where the eddy torque peaks (1.5Hz)

#---------------------------------------------------------------------------------- Bridge and link

# Carrier the bridge switches at, and the shape factors the `Volt` table is read through:
# SVPWM reaches a given phase voltage at less modulation than a sine.
PWM_Hz = 10000.0
SHAPE_K = (1.0, 0.8660254, 0.873) # sine | svpwm | trapezoid

# Dead-time steals `td/T` of the bus from every phase along the sign of ITS OWN current.
# Over a period that square's fundamental is `4/pi` of it.
DEAD_FUND = 4.0 / PI
# What the bridge gives back: NOTHING.
# `RENDER_CalcMod` turns the `Volt` table straight into a modulation index
# in three lines with no dead-time term,
# and the only compensation anywhere in the firmware is the observer's flux feedforward,
# which never reaches a CCR and which `vf` never enters at all.
# The shipped table already carries the full drop: that is what its constant 13.00V offset IS,
# matching `(4/pi)(td/T)Vdc/sqrt2` to a fraction of a percent.
DEAD_COMP = 0.0

# Diode front end, from `bus.c`.
# The link charges from the mains only below the rectified level,
# so regenerated energy has nowhere to go and pumps the bus:
# the dynamic that took the bench from 610V to 864V in about 300ms.
BUS_VRECT_V = 590.0
BUS_C_F = 470e-6
# What the mains looks like behind the rectifier.
# NOT `foc-tests`' 2 ohm: that is a bench supply chosen to hold still.
# A diode front end charges in short pulses at the line peaks,
# so the averaged source is far softer, and the register defaults say how soft:
# `Freeze:VdcLow = 550` exists to stop acceleration on a sagging link,
# which only means something if rated load actually sags it.
# At this value rated power sits around 568V, twenty volts clear of that gate,
# and an overloaded bridge walks the bus into it.
BUS_RSRC_ohm = 10.0
# What hangs on the link even with the bridge off:
# the flyback control supply and the bleeder.
# Small, but it is the only way a pumped link comes back down once the machine stops braking:
# without it an `hv+` trip would park the bus over `Thresh:DcBusMax`
# and refuse to re-arm forever.
LINK_DRAIN_W = 10.0
# The pump guard arms this far under the ceiling outside a closed loop,
# where a slipping rotor pumps the bus just as hard under a voltage table.
BUS_MARGIN_V = 30.0

# RMS phase volts to vector peak: the `sqrt(2)` the firmware carries as 1448/1024.
V_PEAK = 1.4142136
# A machine with no constants entered would otherwise divide by zero.
R_FLOOR_ohm = 0.05

#------------------------------------------------------------------------------------------ Sensors

# The power stage warms on what the bridge and the winding burn in it.
# No line here is a claim about a particular heatsink:
# each is one number away from a different one, which is the only way a model stays useful.
AMBIENT_C = 25.0
TEMP_RTH_CW = 0.8 # stage rise per watt of loss
TEMP_TAU_s = 300.0
SWITCH_LOSS_W = 12.0
RIPPLE_BASE_V = 1.5
RIPPLE_PER_A = 0.4
# Forward drop across a conducting leg.
# The bridge takes power off the link in proportion to CURRENT,
# not to the work the machine does,
# which is what makes a badly excited table cost bus volts:
# a reactive current does nothing in the shaft and still crosses the transistors.
VCE_V = 1.5
# Inside `Thresh:FlybackMin..Max`, or the drive would never leave standstill.
FLYBACK_V = 17.0
PEAK_FACTOR = 2.828 # sine phase RMS to peak-to-peak
# Where the board's own overcurrent comparator sits, as an AMPLITUDE.
# A hardware line on its own pin (`pin_shutdown`),
# so no register moves it and it protects the transistors rather than the motor:
# it has to clear the top of the `Thresh:CurrPeak` range with room to spare,
# or a legal setting could never arm.
PEAK_TRIP_A = 40.0
# What the start feed guard reports back.
# A crossed pair still measures current,
# and a single flipped channel partly cancels against its neighbour,
# so the two faults read differently;
# the volts are what the integral reached before the guard called it.
GUARD_SWAP = 0.45
GUARD_HALF = 0.5
GUARD_PUSH = 3.0

#------------------------------------------------------------------------------------------ Machine

class Machine:
  """Iron, shaft and link. Integrated, not solved."""
  def __init__(self, rs:float=RS_ohm, lq:float=LQ_H, ke:float=KE_V_Hz,
    poles:int=POLES, phasemap:int=PHASEMAP, dtcomp:float=DTCOMP_pct,
    peak_trip:float=PEAK_TRIP_A, inertia:float=INERTIA_kgm2,
    viscous:float=VISCOUS_Nms, fan:float=FAN_Nms2, load_nm:float=LOAD_Nm):
    self.rs = rs
    self.lq = lq
    self.ke = ke
    self.poles = poles
    self.phasemap = phasemap
    self.dtcomp_true = dtcomp
    self.peak_trip = peak_trip
    # A fan gives energy back to nothing,
    # so a scenario that wants to see the bus pumped hangs a flywheel here instead.
    self.inertia = inertia
    self.viscous = viscous
    self.fan = fan
    self.load_nm = load_nm
    self.reset()

  def reset(self):
    """Power-on: shaft stopped, link charged, stage cold."""
    self.clear()
    self.wm = 0.0    # MECHANICAL speed [rad/s]
    self.vdc = BUS_VRECT_V
    self.temp = AMBIENT_C
    self.regens = 0  # `Brake:RegenCount`, boot-sticky like the device's

  def clear(self):
    """Bridge off. Currents and the angle go;
    the SHAFT is not touched, because a spinning rotor keeps spinning."""
    self.id = 0.0       # rotor-frame currents, phase RMS
    self.iq = 0.0
    self.delta = 0.0    # applied vector ahead of the rotor flux [rad]
    self.slip = False   # out of step: the field runs on without the rotor
    self.volt = 0.0
    self.mod_index = 0.0
    self.speed_i = 0.0
    self.glide_s = 0.0  # `Foc:EntryGlide` left to run
    self.glide = (0.0, 0.0)
    self.regen = False  # braking currently faded by a high link
    self.damp_dc = 0.0  # the standing slip the damper high-passes away
    self.lean = 0.0     # `If:Damp`'s current frame tilt [rad]
    self._envelope()

  def _envelope(self, lo:float=0.0, hi:float=0.0, curr:float=0.0):
    """What the tick swung through.
    A reader that samples a ringing quantity at one arbitrary instant learns nothing about it."""
    self.delta_lo = lo
    self.delta_hi = hi
    self.curr_hi = curr

  #--------------------------------------------------------------------------------------- Readings

  @property
  def wr(self) -> float:
    """Rotor speed as an ELECTRICAL frequency, the domain everything else uses."""
    return self.wm * self.poles / (2.0 * PI)

  @property
  def curr(self) -> float:
    """Phase current RMS, exactly what a meter on the wire reads."""
    return sqrt(self.id ** 2 + self.iq ** 2)

  @property
  def peak(self) -> float:
    """Peak-to-peak, taken across the whole tick so a swing is not missed."""
    return max(self.curr, self.curr_hi) * PEAK_FACTOR

  @property
  def power(self) -> float:
    """Apparent power, the VA proxy `measure.md` defines: no cos phi in it."""
    return 3.0 * self.volt * self.curr

  @property
  def ripple(self) -> float:
    """Bus ripple grows with what the bridge draws out of the link."""
    return RIPPLE_BASE_V + RIPPLE_PER_A * self.curr

  @property
  def swing(self) -> float:
    """Half the load angle's excursion over the tick, in degrees.
    This is the ringing the takeover gate has to fit inside `Foc:LockErr`."""
    return (self.delta_hi - self.delta_lo) / 2.0 * 180.0 / PI

  #--------------------------------------------------------------------------------------- Geometry

  def react(self, f:float) -> float:
    """Phase reactance at this electrical frequency."""
    return 2.0 * PI * abs(f) * self.lq

  def emf(self, f:float) -> float:
    """Back-EMF at this speed, phase RMS."""
    return self.ke * abs(f)

  def kt(self) -> float:
    """Shaft torque per amp of phase RMS, from the power balance `3 E I = T w`."""
    return 3.0 * self.poles * self.ke / (2.0 * PI)

  def tload(self, wm:float) -> float:
    """What the load asks of the shaft at this mechanical speed."""
    return self.load_nm + self.viscous * wm + self.fan * wm * abs(wm)

  def vdq(self, f:float) -> tuple:
    """The voltage the bridge has to stand up to hold the current it is holding:
    back-EMF, the resistive drop along it and the reactive drop across it."""
    x = self.react(f)
    return self.rs * self.id - x * self.iq, self.rs * self.iq + x * self.id + self.emf(f)

  def applied(self, f:float) -> float:
    """Its magnitude, phase RMS."""
    vd, vq = self.vdq(f)
    return sqrt(vd ** 2 + vq ** 2)

  def dead_v(self, cmd:Command) -> float:
    """Phase RMS volts the bridge keeps for itself, net of what it gives back."""
    dtpu = max(0.0, cmd.deadtime_ns) * 1e-9 * PWM_Hz
    return (1.0 - DEAD_COMP) * DEAD_FUND * dtpu * self.vdc / V_PEAK

  def table_volts(self, cmd:Command, hz:float) -> float:
    """What the winding actually sees off the `Volt` table."""
    return max(0.0, (interp(cmd.volt, hz, to_zero=True) or 0.0) - self.dead_v(cmd))

  def modulate(self, cmd:Command, f:float, ceiling:float) -> bool:
    """The applied vector against what the bus can render, so it moves with the rail:
    the same voltage modulates deeper on a sagging bus.
    Returns whether the ceiling is what the operator is looking at.

    The voltage is then restated from the modulation that survived the clamp.
    `Feedback:Volt` is the phase voltage OF THE APPLIED modulation,
    not of the one that was asked for,
    so a table richer than the bridge can render has to show up in both registers,
    or they contradict each other."""
    shape = SHAPE_K[int(clamp(cmd.shape, 0, len(SHAPE_K) - 1))]
    per_volt = V_PEAK * shape * 2.0 / max(1.0, self.vdc) * 100.0
    mod = 0.0 if f <= 0.0 else self.volt * per_volt
    self.mod_index = min(ceiling, mod)
    if mod > ceiling: self.volt = self.mod_index / per_volt
    return mod >= ceiling

  #------------------------------------------------------------------------------------- References

  def forced_mag(self, cmd:Command, hz:float) -> float:
    """The magnitude a forced vector carries, off the `Curr` table and under `Foc:IqMax`.
    It rides the FORCED frame's d-axis,
    so the rotor hangs behind it by whatever the load asks for."""
    return min(interp(cmd.curr, hz, to_zero=True) or 0.0, cmd.iq_max_a)

  def flux_ref(self, cmd:Command) -> float:
    """A surface-magnet PMSM closes on zero flux current."""
    return 0.0

  def fade(self, cmd:Command) -> float:
    """How much braking torque `Brake:RegenBand` still allows.

    It is applied ONCE, to the torque target, and never to the ramp:
    a rate is not a torque,
    and fading one would make the limit depend on how often the ramp happens to be called.
    The band is what a bus trip is traded against,
    so it has to bite where the energy is actually made."""
    if not (cmd.regen_band_v and cmd.dc_max_v): return 1.0
    if self.vdc <= cmd.dc_max_v - cmd.regen_band_v:
      self.regen = False
      return 1.0
    if not self.regen:
      self.regens = min(0xFFFE, self.regens + 1)
      self.regen = True
    return max(0.0, (cmd.dc_max_v - self.vdc) / cmd.regen_band_v)

  def speed_ref(self, cmd:Command, hz:float, dt:float) -> float:
    """Closed FOC closes the speed loop on the SHAFT, not on the ramp,
    so its gains have something to act on."""
    err = hz - self.wr
    kp, ki = cmd.spd_kp / 1000.0, cmd.spd_ki / 1000.0
    want = kp * err + self.speed_i + ki * err * dt
    iq = clamp(want, -cmd.iq_max_a, cmd.iq_max_a)
    # Back-calculation: the integral gives back exactly what the clamp refused,
    # so it lets go the moment the loop comes off the limit,
    # instead of holding the drive at full current all the way to the setpoint and beyond.
    self.speed_i = clamp(self.speed_i + ki * err * dt + (iq - want),
      -cmd.iq_max_a, cmd.iq_max_a)
    # Braking wilts inside the regen band: the drive gives back less energy per second,
    # so it stops slower instead of tripping the link.
    return iq * self.fade(cmd) if iq < 0.0 else iq

  def rebase(self, volts:bool):
    """Move the load angle onto whatever the next stage renders.

    `delta` is the angle of the APPLIED vector, and the modes apply different quantities:
    a table imposes voltage, a forced vector imposes current.
    The two sit nearly a quadrant apart at the same operating point,
    so a handover that kept the old number would step the physical vector
    and answer with a current spike the real drive never sees."""
    if volts:
      vd, vq = self.vdq(self.wr)
      self.delta = atan2(vq, vd) if (vd or vq) else PI / 2.0
    else:
      self.delta = atan2(self.iq, self.id) if (self.id or self.iq) else 0.0
    self._envelope(self.delta, self.delta, self.curr)

  def takeover(self, cmd:Command):
    """The switch into closed loop.
    `Foc:EntryGlide` walks the references from the vector I/f was already carrying
    to the ones the closed loop wants,
    so the dq trajectory is a straight segment and the current does not step."""
    self.glide = (self.id, self.iq)
    self.glide_s = max(0.0, cmd.entry_glide_ms) / 1000.0

  #------------------------------------------------------------------------------------ Integration

  def advance(self, cmd:Command, dt:float, field_hz:float, volts:float=None,
    ref:tuple=None, closed:bool=False):
    """One outer tick, walked in sub-steps.

    `volts` drives the winding off a voltage table and lets the current fall out of the machine.
    `ref` imposes a current and lets the voltage fall out of the bridge;
    a forced vector rides its own frame, so the rotor picks the angle,
    while a closed loop names both axes in the rotor frame."""
    if dt <= 0.0: return
    n = min(SUB_MAX, max(1, int(round(dt / SUB_s))))
    h = dt / n
    lo = hi = self.delta
    crest = self.curr
    curr_gain = 1.0 - exp(-h * 2.0 * PI * max(1.0, cmd.curr_bw_hz))
    # A voltage table has no control frame to lean,
    # so V/f hunting stays undamped exactly as the tuning guide says it is.
    gain = 0.0 if volts is not None else DAMP_GAIN_s * max(0.0, cmd.damp_pct) / 100.0
    half = h / 2.0
    for _ in range(n):
      # Leapfrog: half a turn of the angle, then the currents and the torque at that midpoint,
      # then the speed, then the other half.
      # A whole-step scheme leaves the voltage projection lagging the angle by half a step,
      # and against a swing damped to under one percent of critical
      # that lag reads as negative damping:
      # the ring would grow until a protection answered an artefact of the arithmetic.
      self.delta += half * 2.0 * PI * (field_hz - self.wr)
      slew = 2.0 * PI * (field_hz - self.wr)
      # `If:Damp` leans the frame the loops render into,
      # so the current lands at a different angle on the rotor.
      # High-passed, so only the SWING leans it,
      # and clamped to a trim, so it can bleed an oscillation and can never carry load:
      # past pull-out the vector still makes only `kt |I|`.
      self.damp_dc += (slew - self.damp_dc) * h / (DAMP_HP_s + h)
      self.lean = clamp(gain * (slew - self.damp_dc), -DAMP_MAX_rad, DAMP_MAX_rad)
      if volts is None: self._loops(cmd, h, curr_gain, ref, closed, self.lean)
      else: self._winding(h, volts)
      eddy = ROTOR_DAMP_Nms * slew / (1.0 + (slew / ROTOR_SLIP_rads) ** 2)
      torque = self.kt() * self.iq + eddy
      self.wm = max(0.0, self.wm + h * (torque - self.tload(self.wm)) / self.inertia)
      self.delta += half * 2.0 * PI * (field_hz - self.wr)
      if abs(self.delta) > SLIP_rad:
        self.slip = True
        self.delta -= 2.0 * PI * (1.0 if self.delta > 0 else -1.0)
      lo, hi = min(lo, self.delta), max(hi, self.delta)
      crest = max(crest, self.curr)
    # Back in step once the whole tick stayed inside the pull-out angle.
    if hi - lo < PI / 2.0 and max(abs(lo), abs(hi)) < PI / 2.0: self.slip = False
    self._envelope(lo, hi, crest)
    self.volt = (interp(cmd.volt, field_hz, to_zero=True) or 0.0) if volts is not None \
      else self.applied(self.wr) + self.dead_v(cmd)

  def coast(self, dt:float):
    """Bridge off. No current to make torque with,
    so the shaft carries on against its own load alone and the drive watches it slow down."""
    self.id = self.iq = 0.0
    self._envelope()
    if dt <= 0.0: return
    n = min(SUB_MAX, max(1, int(round(dt / SUB_s))))
    h = dt / n
    for _ in range(n):
      self.wm = max(0.0, self.wm - h * self.tload(self.wm) / self.inertia)

  def _winding(self, h:float, volts:float):
    """Stator equation in the rotor frame.
    The applied vector sits `delta` ahead of the flux,
    so the load angle is the only thing that turns volts into torque,
    and the `L/R` of the winding is what keeps current off a step.

    Solved exactly over the sub-step rather than stepped.
    The cross terms are a rotation at the electrical speed,
    and no explicit scheme carries a rotation without gaining or losing amplitude;
    at 300Hz that error would swamp the physics it is supposed to show."""
    a = self.rs / self.lq
    we = 2.0 * PI * self.wr
    vd, vq = volts * cos(self.delta), volts * sin(self.delta) - self.emf(self.wr)
    den = a * a + we * we
    # Where the winding is heading, which is the algebraic operating point.
    sd = (a * vd / self.lq + we * vq / self.lq) / den
    sq = (a * vq / self.lq - we * vd / self.lq) / den
    ed, eq = self.id - sd, self.iq - sq
    decay, c, sn = exp(-a * h), cos(we * h), sin(we * h)
    self.id = sd + decay * (c * ed + sn * eq)
    self.iq = sq + decay * (c * eq - sn * ed)

  def _loops(self, cmd:Command, h:float, gain:float, ref:tuple, closed:bool,
    tilt:float=0.0):
    """Closed current loops at their own bandwidth rather than as an instant jump:
    `Foc:CurrBw` is the only knob over that response,
    so a slow setting has to show up as a slow current."""
    if closed:
      idr, iqr = ref
      if self.glide_s > 0.0:
        # One factor on both axes, so the dq trajectory is a straight segment
        # and does not turn the vector on its way to the target.
        self.glide_s = max(0.0, self.glide_s - h)
        k = 1.0 - self.glide_s / (max(cmd.entry_glide_ms, 1.0) / 1000.0)
        idr = self.glide[0] + (idr - self.glide[0]) * k
        iqr = self.glide[1] + (iqr - self.glide[1]) * k
    else:
      # The forced vector lies on its own frame's d-axis, `delta` ahead of the flux,
      # so in the rotor frame the load angle is what splits it.
      lean = self.delta + tilt
      idr, iqr = ref[0] * cos(lean), ref[0] * sin(lean)
    self.id += (idr - self.id) * gain
    self.iq += (iqr - self.iq) * gain

  #-------------------------------------------------------------------------------- Link and senses

  def bridge_loss(self, running:bool) -> float:
    """What the bridge burns: conduction with the current,
    switching roughly fixed while the PWM runs.
    It comes off the link and lands in the heatsink, so it belongs to both accounts."""
    return 3.0 * VCE_V * self.curr + SWITCH_LOSS_W if running else 0.0

  def bus(self, cmd:Command, dt:float, f:float, closed:bool, running:bool) -> bool:
    """The DC link behind a diode bridge.
    It charges from the mains only while it sits below the rectified level,
    so what the machine gives back on a braking ramp has nowhere to go
    and lifts the rail instead.

    Returns whether the pump guard tripped.
    Inside a closed loop the regen fade has already cut braking to zero,
    so any further rise means another source;
    outside one a slipping rotor pumps the bus just as hard under a voltage table,
    and the guard keeps a margin for it."""
    if dt <= 0.0: return False
    vd, vq = self.vdq(f)
    # Real power, so the sign is the direction the energy travels.
    # Braking makes it negative and the link has to take the charge.
    i_inv = (3.0 * (vd * self.id + vq * self.iq)
      + self.bridge_loss(running) + LINK_DRAIN_W) / max(self.vdc, 1.0)
    if self.vdc < BUS_VRECT_V:
      # The source is stiff next to a poll interval, so settle it exactly,
      # rather than stepping a time constant three orders of magnitude below `dt`.
      aim = BUS_VRECT_V - i_inv * BUS_RSRC_ohm
      self.vdc += (aim - self.vdc) * min(1.0, dt / (BUS_RSRC_ohm * BUS_C_F))
    else:
      self.vdc -= i_inv * dt / BUS_C_F
    self.vdc = max(100.0, self.vdc)
    if not cmd.dc_max_v: return False
    return self.vdc > cmd.dc_max_v - (0.0 if closed else BUS_MARGIN_V)

  def sense(self, dt:float, running:bool):
    """The one reading that carries its own history.
    What the stage burns goes into it and leaves slowly;
    everything shaped for a register leaves through `scope.py` instead."""
    loss = 3.0 * self.rs * self.curr ** 2 + self.bridge_loss(running)
    aim = AMBIENT_C + TEMP_RTH_CW * loss
    self.temp += (aim - self.temp) * dt / (TEMP_TAU_s + dt)

  def guard_point(self, cmd:Command, hz:float) -> tuple:
    """What the start feed guard caught: the volts the d-axis asked for,
    the current that answered, and what it asked of it.

    The answer has to be READABLE, because that is the whole diagnosis.
    Near zero is a blind channel, wiring or slot, and no mapping cures it.
    Negative is reversed polarity.
    Positive but short of the reference is a crossed pair.
    A guard that always reported zero would teach only the first of the three.

    `Sense:PhaseMap` is bit-composed: bit0 negates U, bit1 negates V,
    bit2 swaps the corrected pair, so the wrong bits say which fault the map is inventing."""
    want = self.forced_mag(cmd, max(hz, 0.0))
    wrong = int(cmd.phasemap) ^ int(self.phasemap)
    seen = want
    if wrong & 0b100: seen *= GUARD_SWAP  # crossed: real current, wrong axis
    flipped = (wrong & 0b001 != 0) + (wrong & 0b010 != 0)
    if flipped == 1: seen *= -GUARD_HALF  # one channel backwards, partly cancels
    elif flipped == 2: seen *= -1.0       # both backwards, a clean reversal
    # The guard trips because the integral pushed volts at a current that never came,
    # so the volts it caught are well past what the winding needs.
    return GUARD_PUSH * (self.rs * want + self.dead_v(cmd)), seen, want
