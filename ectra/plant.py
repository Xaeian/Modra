"""
The drive: which stage owns the bridge, and what one tick does to everything.

The facade over `Machine`, `Ramp`, `Observer`, `Detector` and `Protect`.
Those five each answer for one thing and none of them decides a stage;
this is where a verdict, a takeover and a fault become the same kind of event.

Modelled on what the drive does inside, not on what it looks like from outside:
the control frame is the ramp's angle in I/f and the observer's angle in closed loop,
the takeover rotates the references and the integrators by the angle between the two,
the entry seeds torque at the vector's magnitude, and the speed loop works on the PLL speed.
Whatever the observer gets wrong, the bridge does wrong with it -
that is the physics a failed takeover comes from.

No register names and no Modbus here.
A `Command` goes in and plant state comes out,
so a scenario can drive the model directly and assert on what it did.

Example:
  >>> from ectra.__main__ import command
  >>> plant = Plant()
  >>> plant.step(command("foc", 55.0), 0.05)
  >>> plant.vec
  'catch'
"""

from math import pi as PI, sqrt
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
# The thread cadence the targets and the speed loop run on: the render update,
# which bands with frequency on the device; one fixed value here
TARGETS_s = 0.025
# Reference slew toward the targets, per pass [A RMS]
REF_SLEW_A = 0.05
# The takeover seed never falls under this share of the entry vector
SEED_FLOOR = 0.25
# The start alignment's field rises over this share of `Drive:AlignTime` and stands for the rest
ALIGN_RISE = 0.67
# Voltage-authority bucket: 200ms of solid saturation fills it.
# Past half of it the loops count as out of voltage,
# so a vector grazing the ceiling does not flicker the ramp
SAT_BUCKET_s = 0.2

# What the current-vector estimator recovers of the truth
ESTIM_TABLE = 0.58
ESTIM_VECTOR = 0.67
ESTIM_FLOOR_A = 0.05
ESTIM_FLOOR_Hz = 0.5

FLAG_LIMIT = 1
FLAG_SAT = 2

#-------------------------------------------------------------------------------------------- Plant

class Plant:
  """The simulated drive. Mutable state, advanced one `step` at a time."""
  def __init__(self, machine:Machine|None=None):
    self.machine = machine or Machine()
    self.ramp = Ramp()
    self.obs = Observer()
    self.det = Detector()
    self.prot = Protect()
    self.meters = Meters()
    self.scope = Scope()
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
    self.theta_render = 0.0 # the applied field angle [rad]
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
    self._sat_s = 0.0
    self._targets_s = 0.0
    self.id_ref = self.iq_ref = 0.0   # what the loops chase, control frame
    self.id_tgt = self.iq_tgt = 0.0   # where the references are headed
    self.spd_acc = 0.0                # speed-loop integrator [A]
    self.limit = False
    self._forced_mag = 0.0

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
    """The Park angle the loops used, what `Obs:AngleErr` is against."""
    return self.obs.theta if self.vec == "closed" else self.theta_render + self.machine.lean

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
    self.ramp.slew(cmd, dt, self.meters, self.vec in BLIND_VEC, self.vec == "closed",
      self.det.close_done, self._align_s > 0.0, self._sat)
    # The cut belongs to the ramp step, as in the drive
    self._cutoff(cmd)
    if self.vec == "idle":
      self._idle(cmd, dt)
      return
    if self._align_s > 0.0: self._align_s -= dt
    self.obs.configure(cmd, self.machine.vdc)
    self._output(cmd, dt)
    self._settle(cmd, dt)
    if self.fault: self._latch(cmd)

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
    """
    `Drive:Mode` acts on the LIVE run, a closed loop excepted:
    it keeps its mode to the stop, and the next start takes the new one.
    """
    if self._mode == cmd.mode or self.vec == "closed": return
    prev, self._mode = self._mode, cmd.mode
    if prev is None or self.vec in ("idle", "fault"): return
    self.det.restart()
    verdict = self._verdict(cmd)
    if verdict: self.vec = verdict
    elif self.vec == "forced": pass
    else:
      # From a table, re-enter by catch
      self.vec = "catch"
      self._catch_at = 0.0

  def _cutoff(self, cmd:Command):
    if self.target > 0.0 or self.vec == "idle": return
    if self.ramp.hz <= max(cmd.speed_min_hz, cmd.init_hz, 0.05): self._clear_run()

  #----------------------------------------------------------------------------------------- Output

  def _align_gain(self, cmd:Command) -> float:
    """Start-alignment field share: `0` → `1` over its rise, `1` after it and outside it."""
    if self._align_s <= 0.0: return 1.0
    align_s = cmd.align_ms / 1000.0
    held_s, rise_s = align_s - self._align_s, align_s * ALIGN_RISE
    return 1.0 if held_s >= rise_s else held_s / rise_s

  def _output(self, cmd:Command, dt:float):
    """
    The tick, walked in sub-steps:
    the bridge, the shaft, the observer and the detector all move inside it,
    in the order the ISR and the thread run them.
    """
    m = self.machine
    if self.vec == "align" and self._align_s <= 0.0: self.vec = "forced"
    if self.vec == "catch" and self.ramp.hz >= self._catch_at:
      # The catch: the references take the measured current, in the control frame
      self.vec = "forced"
      self.id_ref, self.iq_ref = rotate(m.id, m.iq, wrap(self.theta_render - m.theta_r))
    # A step of no length moves nothing and would divide the winding by zero
    if dt <= 0.0: return
    n = min(SUB_MAX, max(1, int(round(dt / SUB_s))))
    h = dt / n
    hz = self.ramp.hz
    gain = self._align_gain(cmd)
    for _ in range(n):
      table = self.table
      closed = self.vec == "closed"
      # The alignment holds the field still, whichever vector renders it
      field = 0.0 if self._align_s > 0.0 else hz
      if table:
        v_ab, i_ab = m.step_table(cmd, h, self.theta_render, m.table_volts(cmd, hz) * gain)
      elif closed:
        v_ab, i_ab = m.step_vector(cmd, h, self.obs.theta, (self.id_ref, self.iq_ref),
          forced=False)
      else:
        v_ab, i_ab = m.step_vector(cmd, h, self.theta_render,
          (self.id_ref, self.iq_ref), forced=self.vec == "forced")
      if not table: self._sat_s = clamp(self._sat_s + (h if m.sat else -h), 0.0, SAT_BUCKET_s)
      if self.vec not in VERDICT_VEC: self.obs.step(h, v_ab, i_ab, m.signs)
      if closed: self.theta_render = self.obs.theta
      else: self.theta_render = wrap(self.theta_render + TWO_PI * field * h)
      self._targets(cmd, h, hz)
      if self.vec != "align":
        out = self.det.step(cmd, h, self.obs, self.vec, hz, self.theta_render)
        if out.vec == "closed": self._takeover(out.delta)
        if out.vec: self.vec = out.vec
        if out.fault:
          self.fault = out.fault
          break
    m.finish_tick(cmd, hz, self.table, gain)
    ceiling = 100.0 if self.table else cmd.mod_ceil_pct
    sat = m.modulate(cmd, hz, ceiling)
    # The loops clip inside the sub-step, onto the ceiling only to within rounding,
    # so their own flag fills the bucket
    self._sat = sat if self.table else self._sat_s > SAT_BUCKET_s / 2.0
    self.flags = (FLAG_LIMIT if self.limit else 0) | (FLAG_SAT if sat or m.sat else 0)

  #--------------------------------------------------------------------------------------- Takeover

  def _takeover(self, delta:float):
    """
    The takeover and its seed:
    the references, as they are at the switch, rotate into the observer frame,
    and torque is seeded at the q-projection of the rotated pair:
    the torque the I/f vector carried.
    Its whole magnitude would step torque by `1/sin` of the load angle.
    The floor covers an observer reading the load angle low; the seed never brakes.
    """
    m = self.machine
    id0, iq0 = rotate(self.id_ref, self.iq_ref, -delta)
    m.lean = 0.0
    mag = max(abs(id0), abs(iq0)) + min(abs(id0), abs(iq0)) / 2.0
    seed = max(iq0, mag * SEED_FLOOR)
    self.id_ref, self.iq_ref = id0, iq0
    self.iq_tgt = seed
    self.id_tgt = 0.0
    self.spd_acc = seed

  def _targets(self, cmd:Command, h:float, hz:float):
    """The thread's pass: the speed loop and the slew of the references."""
    self._forced_mag = self.machine.forced_mag(cmd, hz) * self._align_gain(cmd)
    self._targets_s += h
    if self._targets_s < TARGETS_s: return
    dt, self._targets_s = self._targets_s, 0.0
    if self.vec != "closed":
      # Align and I/f: the table's current on the aligned axis, reached by the slew
      self.limit = False
      self.id_tgt, self.iq_tgt = self._forced_mag, 0.0
      self._slew()
      return
    err = hz - abs(self.obs.hz)
    kp, ki = cmd.spd_kp / 1000.0, cmd.spd_ki / 1000.0
    if self.ramp.freeze == "off": self.spd_acc += ki * err * dt
    self.spd_acc = clamp(self.spd_acc, -cmd.iq_max_a, cmd.iq_max_a)
    want = kp * err + self.spd_acc
    # Driving torque or none: a diode front-end has nowhere to put braking energy
    sat = clamp(want, 0.0, cmd.iq_max_a)
    self.spd_acc -= want - sat
    self.limit = want > cmd.iq_max_a
    self.iq_tgt = sat
    self.id_tgt = 0.0
    self._slew()

  def _slew(self):
    """The thread's reference slew toward the targets, one pass."""
    self.id_ref += clamp(self.id_tgt - self.id_ref, -REF_SLEW_A, REF_SLEW_A)
    self.iq_ref += clamp(self.iq_tgt - self.iq_ref, -REF_SLEW_A, REF_SLEW_A)
