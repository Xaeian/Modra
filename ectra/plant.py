"""
The drive: which stage owns the bridge, and what one tick does to everything.

The facade over `machine`, `ramp`, `observer`, `detector` and `protect`. Those
five each answer for one thing and none of them decides a stage; this file is
where a verdict, a takeover and a fault become the same kind of event.

Modelled on what `foc-sig` does, not on what a drive looks like from outside: the
control frame is the ramp's angle in I/f and the observer's angle in closed loop,
the takeover rotates the references and the integrators by the angle between the
two, the entry seeds torque at the vector's magnitude and glides there, and the
speed loop works on the PLL speed. Whatever the observer gets wrong, the bridge
does wrong with it - that is the physics a failed takeover comes from.

No register names and no Modbus here. A `Command` goes in and plant state comes
out, so a scenario can drive the model directly and assert on what it did.

Example:
  >>> plant = Plant()
  >>> plant.step(Command(target_hz=55, mode="foc", poles=6, init_hz=0.5), 0.05)
  >>> plant.vec
  'align'
"""

from math import cos, pi as PI, sin, sqrt
from .command import Command
from .curve import clamp
from .detector import Detector
from .machine import FLYBACK_V, SUB_MAX, SUB_s, Machine, rotate, wrap
from .meter import Meters
from .observer import Observer
from .protect import Protect
from .ramp import Ramp
from .scope import Scope

TWO_PI = 2.0 * PI

#------------------------------------------------------------------------------------------- Stages

BLIND_VEC = ("align", "catch", "forced")
VERDICT_VEC = ("off", "obs", "shunt", "guard", "volts")
TABLE_VEC = VERDICT_VEC + ("catch",)
# The thread cadence `FOC_Targets` and the speed loop run on: the render update,
# which bands with frequency on the device; one fixed value here
TARGETS_s = 0.025
# Reference slew toward the targets outside the glide, per pass [A RMS]
REF_SLEW_A = 0.05

# What the current-vector estimator recovers of the truth
ESTIM_TABLE = 0.58
ESTIM_VECTOR = 0.67
ESTIM_FLOOR_A = 0.05
ESTIM_FLOOR_Hz = 0.5

FLAG_REGEN = 1
FLAG_LIMIT = 2
FLAG_SAT = 4

#-------------------------------------------------------------------------------------------- Plant

class Plant:
  """The simulated drive. Mutable state, advanced one `step` at a time."""
  def __init__(self, machine:Machine=None, legacy:bool=False):
    self.machine = machine or Machine()
    self.ramp = Ramp()
    self.obs = Observer()
    self.det = Detector(legacy=legacy)
    self.prot = Protect()
    self.meters = Meters()
    self.scope = Scope()
    self.legacy = legacy
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device."""
    self.machine.reset()
    self.ramp.reset()
    self.det.reset()
    self.prot.reset()
    self.meters.reset()
    self.scope.reset()
    self.meters.update(0.0, 0.0, self.machine, FLYBACK_V)
    self.theta_render = 0.0   # `phase_u`: the applied field angle [rad]
    self._clear_run()
    self.hours = 0.0
    self._mode = None
    self._boot_s = 0.0
    self.trip = {}

  def _clear_run(self):
    """Everything one run owns. The SHAFT is not touched."""
    self.machine.clear()
    self.ramp.clear()
    self.obs.reset(self.theta_render)
    self.det.clear()
    self.prot.clear()
    self.vec = "idle"
    self.fault = None
    self.target = 0.0
    self.flags = 0
    self.guard = (0.0, 0.0, 0.0)
    self._align_s = 0.0
    self._catch_at = 0.0
    self._coast_s = 0.0
    self._sat = False
    self._targets_s = 0.0
    self.id_ref = self.iq_ref = 0.0   # what the loops chase, control frame
    self.id_tgt = self.iq_tgt = 0.0   # where the references are headed
    self.spd_acc = 0.0                # speed-loop integrator [A]
    self.glide = (0.0, 0.0)
    self.glide_s = 0.0
    self.glide_len = 0.0
    self.limit = False
    self.regen = False
    self._forced_mag = 0.0
    self._cmd_glide = 400.0

  #------------------------------------------------------------------------------- Derived readings

  @property
  def coasting(self) -> bool:
    return self._coast_s > 0.0

  @property
  def table(self) -> bool:
    return self.vec in TABLE_VEC

  @property
  def state(self) -> str:
    if self.coasting: return "coa"
    if self.vec in ("idle", "fault"): return "shd"
    return "str" if self._align_s > 0.0 else "run"

  @property
  def f_elec(self) -> float:
    """The frequency the windings see: the ramp, or the observer once closed."""
    return abs(self.obs.hz) if self.vec == "closed" else self.ramp.hz

  @property
  def theta_applied(self) -> float:
    """`Foc.dump.thf`: the Park angle the loops used, what `Obs:AngleErr` is against."""
    return self.obs.theta_hat if self.vec == "closed" else self.theta_render + self.machine.lean

  @property
  def estim_hz(self) -> float:
    if self.vec in ("idle", "fault"):
      spin = abs(self.machine.wr)
      return spin * ESTIM_TABLE if spin > ESTIM_FLOOR_Hz else 0.0
    if self.machine.curr < ESTIM_FLOOR_A: return 0.0
    if self.table: return abs(self.machine.wr) * ESTIM_TABLE
    return abs(self.f_elec) * ESTIM_VECTOR

  @property
  def report_hz(self) -> float:
    if self.vec in ("idle", "fault"): return abs(self.machine.wr)
    if self.vec == "closed": return abs(self.obs.hz)
    return self.ramp.hz

  @property
  def vd(self) -> float:
    return self._axis(self.machine.vd_c)

  @property
  def vq(self) -> float:
    return self._axis(self.machine.vq_c)

  def _axis(self, v:float) -> float:
    total = sqrt(self.machine.vd_c ** 2 + self.machine.vq_c ** 2)
    return 0.0 if total <= 0.0 else v / total * self.machine.mod_index

  #------------------------------------------------------------------------------------------- Step

  def step(self, cmd:Command, dt:float):
    """One update of the whole drive, `dt` seconds long."""
    if cmd.clear_fault and self.fault:
      self.fault = None
      self.trip = {}
      if not self.coasting: self.vec = "idle"
    if self.fault or self.coasting:
      self._coast(cmd, dt)
      return
    self.hours += dt / 3600.0
    self.target = cmd.target_hz
    self._boot(cmd, dt)
    self._mode_change(cmd)
    if cmd.target_hz > 0.0: self._start(cmd)
    if self.vec == "idle":
      self._idle(cmd, dt)
      if self.fault: self._latch(cmd)
      return
    self.ramp.slew(cmd, dt, self.meters, self.vec in BLIND_VEC,
      self.det.close_done, self._align_s > 0.0, self._sat)
    if self._align_s > 0.0: self._align_s -= dt
    self.obs.configure(cmd, self.machine.vdc)
    self._output(cmd, dt)
    self._settle(cmd, dt)
    if self.fault:
      self._latch(cmd)
      return
    self._cutoff(cmd)

  def _idle(self, cmd:Command, dt:float):
    self.machine.coast(dt)
    self._settle(cmd, dt)

  def _settle(self, cmd:Command, dt:float):
    """The link, the senses and the protections."""
    running = self.vec not in ("idle", "fault")
    if self.machine.bus(cmd, dt, self.f_elec, self.vec == "closed", running) \
      and not self.fault:
      self.fault = "hv+"
    self.machine.sense(dt, running)
    self.meters.update(dt, self.report_hz, self.machine, FLYBACK_V)
    self.scope.feed(dt, self)
    if self.vec == "guard": self.guard = self.machine.guard_point(cmd, self.ramp.hz)
    if self.vec in ("idle", "fault") or self.fault: return
    self.fault = self.prot.check(cmd, dt, self.meters.ctrl, self.machine,
      self.ramp.hz, self.target, self.table, self.vec == "forced", self.estim_hz)

  def _coast(self, cmd:Command, dt:float):
    self._coast_s = max(0.0, self._coast_s - dt)
    if not self.fault and not self.coasting: self.vec = "idle"
    self.machine.coast(dt)
    self._settle(cmd, dt)

  def _latch(self, cmd:Command):
    """The moment a run ends badly: keep the evidence, then drop everything."""
    self.trip = {"freq": self.ramp.hz, "curr": self.machine.curr,
      "vdc": self.machine.vdc, "temp": self.machine.temp}
    ended, keep, remain = max(self.ramp.hz, 0.0), self.fault, self._coast_s
    self._clear_run()
    self.fault = keep
    self.vec = "fault"
    self._coast_s = max(remain, 0.05, cmd.coast_s * ended / 50.0)

  #--------------------------------------------------------------------------------- Start and mode

  def _verdict(self, cmd:Command) -> str|None:
    if cmd.mode == "vf": return "off"
    if not cmd.shunt_ok: return "shunt"
    if cmd.mod_ceil_pct and cmd.mod_ceil_pct < 10.0: return "volts"
    if not cmd.rs_ohm: return "obs"
    if cmd.mode == "foc" and not cmd.ke_v_hz: return "obs"
    if cmd.phasemap != self.machine.phasemap: return "guard"
    return None

  def _bus_ok(self, cmd:Command) -> bool:
    vdc = self.machine.vdc
    return vdc >= cmd.dc_min_v and (not cmd.dc_max_v or vdc <= cmd.dc_max_v)

  def _boot(self, cmd:Command, dt:float):
    if not cmd.enabled: return
    if not self._bus_ok(cmd):
      self._boot_s = 0.0
      return
    self._boot_s = min(self._boot_s + dt, cmd.boot_delay_s)

  def _armed(self, cmd:Command) -> bool:
    if not self._bus_ok(cmd): return False
    if self._boot_s < cmd.boot_delay_s: return False
    if cmd.ripple_max_v and self.machine.ripple > cmd.ripple_max_v: return False
    return cmd.target_hz >= max(cmd.init_hz, cmd.speed_min_hz)

  def _start(self, cmd:Command):
    if self.vec != "idle" or not self._armed(cmd): return
    self.ramp.hz = cmd.init_hz
    self.theta_render = 0.0
    self.scope.restart(self.machine.vdc)
    self.obs.configure(cmd, self.machine.vdc)
    self.obs.reset(self.theta_render, TWO_PI * cmd.init_hz)
    self._align_s = cmd.align_ms / 1000.0
    verdict = self._verdict(cmd)
    if verdict:
      self.vec = verdict
    elif cmd.catch_hz:
      self.vec = "catch"
      self._catch_at = cmd.catch_hz
    else:
      self.vec = "align"

  def _mode_change(self, cmd:Command):
    """`Drive:Mode` acts on the LIVE run."""
    if self._mode == cmd.mode: return
    prev, self._mode = self._mode, cmd.mode
    if prev is None or self.vec in ("idle", "fault"): return
    self.det.restart()
    verdict = self._verdict(cmd)
    if verdict: self.vec = verdict
    elif self.vec == "forced": pass
    else:
      # From a table or a closed loop, re-enter by catch: the forced frame takes
      # the current field angle and the observer keeps whatever it had
      if self.vec == "closed": self.theta_render = self.obs.theta_hat
      self.vec = "catch"
      self._catch_at = 0.0

  def _cutoff(self, cmd:Command):
    if self.target > 0.0 or self.vec == "idle": return
    if self.ramp.hz <= max(cmd.speed_min_hz, cmd.init_hz, 0.05): self._clear_run()

  #----------------------------------------------------------------------------------------- Output

  def _output(self, cmd:Command, dt:float):
    """The tick, walked in sub-steps: the bridge, the shaft, the observer and the
    detector all move inside it, in the order the ISR and the thread run them."""
    m = self.machine
    if self.vec == "align" and self._align_s <= 0.0: self.vec = "forced"
    if self.vec == "catch" and self.ramp.hz >= self._catch_at: self.vec = "forced"
    # A step of no length moves nothing and would divide the winding by zero
    if dt <= 0.0: return
    n = min(SUB_MAX, max(1, int(round(dt / SUB_s))))
    h = dt / n
    hz = self.ramp.hz
    for _ in range(n):
      table = self.table
      closed = self.vec == "closed"
      aligning = self._align_s > 0.0 and self.vec == "align"
      field = 0.0 if aligning else hz
      if table:
        v_ab, i_ab = m.step_table(cmd, h, self.theta_render, m.table_volts(cmd, hz))
      elif closed:
        v_ab, i_ab = m.step_vector(cmd, h, self.obs.theta_hat, (self.id_ref, self.iq_ref),
          forced=False)
      else:
        v_ab, i_ab = m.step_vector(cmd, h, self.theta_render,
          (m.forced_mag(cmd, hz), 0.0), forced=self.vec == "forced")
      if self.vec not in VERDICT_VEC: self.obs.step(h, v_ab, i_ab, m.signs)
      if closed: self.theta_render = self.obs.theta_hat
      else: self.theta_render = wrap(self.theta_render + TWO_PI * field * h)
      self._targets(cmd, h, hz)
      if self.vec != "align":
        out = self.det.step(cmd, h, self.obs, self.vec, hz, self.theta_render)
        if out.hz is not None: hz = self.ramp.hz = out.hz
        if out.vec == "closed": self._takeover(out.delta)
        if out.resync:
          self.theta_render = wrap(self.obs.theta_hat + (0.0 if self.legacy else self.det.delta))
          self.glide_s = 0.0
        if out.vec: self.vec = out.vec
        if out.fault:
          self.fault = out.fault
          break
    m.finish_tick(cmd, hz, self.table)
    ceiling = 100.0 if self.table else cmd.mod_ceil_pct
    sat = m.modulate(cmd, hz, ceiling)
    self._sat = sat
    self.flags = ((FLAG_REGEN if self.regen else 0) | (FLAG_LIMIT if self.limit else 0)
      | (FLAG_SAT if sat or m.sat else 0))

  #--------------------------------------------------------------------------------------- Takeover

  def _takeover(self, delta:float):
    """`FOC_Takeover` + the seed of `FOC_Targets`: references and integrators
    rotate into the observer frame, torque is seeded at the entry vector's
    magnitude, motoring-signed, and the glide starts from the rotated pair."""
    m = self.machine
    id0, iq0 = rotate(self._forced_mag, 0.0, -delta)
    m.lean = 0.0
    mag = max(abs(id0), abs(iq0)) + min(abs(id0), abs(iq0)) / 2.0
    self.id_ref, self.iq_ref = id0, iq0
    self.iq_tgt = mag
    self.id_tgt = 0.0
    self.spd_acc = mag
    self.glide = (id0, iq0)
    self.glide_len = max(0.0, self._cmd_glide) / 1000.0
    self.glide_s = self.glide_len

  def _targets(self, cmd:Command, h:float, hz:float):
    """The thread's pass: the speed loop, the glide, the slew of the references."""
    self._cmd_glide = cmd.entry_glide_ms
    self._forced_mag = self.machine.forced_mag(cmd, hz)
    self._targets_s += h
    if self._targets_s < TARGETS_s: return
    dt, self._targets_s = self._targets_s, 0.0
    if self.vec != "closed":
      self.limit = self.regen = False
      return
    m = self.machine
    err = hz - abs(self.obs.hz)
    kp, ki = cmd.spd_kp / 1000.0, cmd.spd_ki / 1000.0
    if self.ramp.freeze == "off": self.spd_acc += ki * err * dt
    self.spd_acc = clamp(self.spd_acc, -cmd.iq_max_a, cmd.iq_max_a)
    want = kp * err + self.spd_acc
    sat = clamp(want, -cmd.iq_max_a, cmd.iq_max_a)
    self.spd_acc -= want - sat
    self.limit = want != sat
    # Braking-signed against the estimate: the valve on the target, once
    fade = self._fade(cmd)
    self.regen = sat < 0.0 and fade < 1.0
    self.iq_tgt = sat * fade if sat < 0.0 else sat
    self.id_tgt = 0.0
    if self.glide_s > 0.0:
      self.glide_s = max(0.0, self.glide_s - dt)
      k = 1.0 - self.glide_s / max(self.glide_len, 1e-6)
      self.id_ref = self.glide[0] + (self.id_tgt - self.glide[0]) * k
      self.iq_ref = self.glide[1] + (self.iq_tgt - self.glide[1]) * k
    else:
      self.id_ref += clamp(self.id_tgt - self.id_ref, -REF_SLEW_A, REF_SLEW_A)
      self.iq_ref += clamp(self.iq_tgt - self.iq_ref, -REF_SLEW_A, REF_SLEW_A)

  def _fade(self, cmd:Command) -> float:
    """`regen_fade_q15`: braking authority tapers as the raw bus nears its ceiling."""
    m = self.machine
    if not (cmd.regen_band_v and cmd.dc_max_v): return 1.0
    room = cmd.dc_max_v - m.vdc
    fade = clamp(room / cmd.regen_band_v, 0.0, 1.0)
    if fade < 1.0 and not m.regen:
      m.regens = min(0xFFFE, m.regens + 1)
    m.regen = fade < 1.0
    return fade
