"""
The drive: which stage owns the bridge, and what one tick does to everything.

The facade over `machine`, `ramp`, `observer`, `detector` and `protect`.
Those five each answer for one thing and none of them decides a stage;
this file is where a verdict, a takeover and a fault become the same kind of event.

Modelled on what `foc-sig` does, not on what a drive looks like from outside.
A simulator that only looks right teaches the wrong reflexes.

No register names and no Modbus here.
A `Command` goes in and plant state comes out,
so a scenario can drive the model directly and assert on what it did.

Example:
  >>> plant = Plant()
  >>> plant.step(Command(target_hz=55, mode="foc", poles=6, init_hz=0.5), 0.05)
  >>> plant.vec
  'align'
"""

from .command import Command
from .detector import Detector
from .machine import FLYBACK_V, Machine
from .meter import Meters
from .observer import Observer
from .protect import Protect
from .ramp import Ramp
from .scope import Scope

#------------------------------------------------------------------------------------------- Stages

# Stages where a vector runs blind, read by the I/f ceiling and by the hold.
# Only `closed` is exempt from the ceiling.
BLIND_VEC = ("align", "catch", "forced")
# Verdicts, latched in place of a vector when the map cannot support one.
VERDICT_VEC = ("off", "obs", "shunt", "guard", "volts")
# Stages where the `Volt` table drives the bridge,
# so voltage is imposed and current is whatever the machine draws.
# Everywhere else the loops impose current and the voltage is whatever it takes to push it.
TABLE_VEC = VERDICT_VEC + ("catch",)

# What the current-vector estimator recovers of the truth.
# Every harmonic drags the `|I|^2`-weighted average down,
# and an open-loop table carries the most.
ESTIM_TABLE = 0.58
ESTIM_VECTOR = 0.85
ESTIM_FLOOR_A = 0.05
ESTIM_FLOOR_Hz = 0.5

# Foc:Flags, orthogonal to the stage.
FLAG_REGEN = 1
FLAG_LIMIT = 2
FLAG_SAT = 4

#-------------------------------------------------------------------------------------------- Plant

class Plant:
  """The simulated drive. Mutable state, advanced one `step` at a time."""
  def __init__(self, machine:Machine=None):
    self.machine = machine or Machine()
    self.ramp = Ramp()
    self.obs = Observer()
    self.det = Detector()
    self.prot = Protect()
    self.meters = Meters()
    self.scope = Scope()
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device,
    so this is the only thing that clears them."""
    self.machine.reset()
    self.ramp.reset()
    self.det.reset()
    self.prot.reset()
    self.meters.reset()
    self.scope.reset()
    # Prime both tiers off the cold machine,
    # so a read that beats the first motor tick still gets an ambient stage and a charged link,
    # rather than zeros standing in for them.
    self.meters.update(0.0, 0.0, self.machine, FLYBACK_V)
    self._clear_run()
    self.hours = 0.0
    self._mode = None
    self._boot_s = 0.0
    self.trip = {}        # fault snapshot, latched where the run ended
    self.phase_deg = 0.0  # applied field angle, `phase_u`: zeroed at start, frozen at stop

  def _clear_run(self):
    """Everything one run owns.
    A commanded stop, a shutdown at the cutoff and a cleared fault all land here:
    the bridge is off and nothing is carried over.
    The SHAFT is not touched, because a spinning rotor keeps spinning."""
    self.machine.clear()
    self.ramp.clear()
    self.obs.reset()
    self.det.clear()
    self.prot.clear()
    self.vec = "idle" # idle | align | catch | forced | closed | fault | verdict
    self.fault = None
    self.target = 0.0
    self.flags = 0
    self.guard = (0.0, 0.0, 0.0)
    self._align_s = 0.0     # start window left; only the align stage freezes the field
    self._catch_at = 0.0    # frequency the catch waits for, 0 takes the live one
    self._coast_s = 0.0     # coast left before the drive may arm again
    self._was_table = True  # which quantity the last stage rendered
    self._sat = False       # last tick ran out of bridge, read by the ramp hold

  #------------------------------------------------------------------------------- Derived readings

  @property
  def coasting(self) -> bool:
    return self._coast_s > 0.0

  @property
  def table(self) -> bool:
    """Whether the `Volt` table is what drives the bridge right now."""
    return self.vec in TABLE_VEC

  @property
  def state(self) -> str:
    """What the drive reports about the motor, not about the vector core.
    `str` is the START WINDOW only: `RENDER_Run` promotes to `run` on a timer,
    so the device says `run` for the whole ramp, not just at the setpoint."""
    if self.coasting: return "coa"
    if self.vec in ("idle", "fault"): return "shd"
    return "str" if self._align_s > 0.0 else "run"

  @property
  def f_elec(self) -> float:
    """The frequency the windings see. Everything but a closed loop renders it;
    a closed loop rides the rotor."""
    return self.machine.wr if self.vec == "closed" else self.ramp.hz

  @property
  def estim_hz(self) -> float:
    """The current-vector measurement, independent of the observer and of nothing else:
    under the vector core the loops impose the angle, so it witnesses the vector;
    under a table the BEMF currents turn it, so it witnesses the rotor.
    Neither reads its own domain at face value."""
    if self.vec in ("idle", "fault"):
      # Bridge down. Whatever still turns is witnessed by its own BEMF currents,
      # the same ones that turn the vector under a table, so the same discount.
      spin = abs(self.machine.wr)
      return spin * ESTIM_TABLE if spin > ESTIM_FLOOR_Hz else 0.0
    if self.machine.curr < ESTIM_FLOOR_A: return 0.0
    if self.table: return abs(self.machine.wr) * ESTIM_TABLE
    return abs(self.f_elec) * ESTIM_VECTOR

  @property
  def report_hz(self) -> float:
    """What the measurement tiers publish while the drive runs:
    the control domain, never the estimator.
    Standstill and coast fall back on the shaft, so a rotor still turning stays visible."""
    if self.vec in ("idle", "fault"): return abs(self.machine.wr)
    if self.vec == "closed": return abs(self.obs.w)
    return self.ramp.hz

  @property
  def vd(self) -> float:
    """Flux axis as a share of the modulation, which is what the register carries:
    a percentage of the bridge, not volts."""
    return self._axis(0)

  @property
  def vq(self) -> float:
    """Torque axis, likewise."""
    return self._axis(1)

  def _axis(self, i:int) -> float:
    f = self.f_elec
    v = self.machine.applied(f)
    return 0.0 if v <= 0.0 else self.machine.vdq(f)[i] / v * self.machine.mod_index

  #------------------------------------------------------------------------------------------- Step

  def step(self, cmd:Command, dt:float):
    """One update of the whole drive, `dt` seconds long."""
    if cmd.clear_fault and self.fault:
      # A cleared fault is the bridge coming back, not the run resuming.
      # The coast still has to finish; the drive starts again if a setpoint stands.
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
      # Stopped, but the shaft may still be turning and the link still holds charge:
      # both keep draining.
      self._idle(cmd, dt)
      if self.fault: self._latch(cmd)
      return
    self.ramp.slew(cmd, dt, self.meters, self.vec in BLIND_VEC,
      self.det.close_done, self._align_s > 0.0, self._sat)
    if self._align_s > 0.0: self._align_s -= dt
    self._output(cmd, dt)
    self.obs.update(cmd, dt, self.machine, self.f_elec, self.vec)
    self._detect(cmd, dt)
    self._settle(cmd, dt)
    # `RENDER_Emergency` runs in the pass that tripped:
    # the bridge is down before the next tick,
    # so a clear can never land on a still-running fault.
    if self.fault:
      self._latch(cmd)
      return
    self._cutoff(cmd)

  def _idle(self, cmd:Command, dt:float):
    """Bridge off, but the world does not stop with it, and the boot deadline keeps running:
    an idle drive is exactly where the device spends it."""
    self.machine.coast(dt)
    self._settle(cmd, dt)

  def _settle(self, cmd:Command, dt:float):
    """The link, the senses and the protections:
    everything that follows from an operating point rather than deciding one."""
    running = self.vec not in ("idle", "fault")
    # Root-cause latch: a secondary trip during the coast (regen `hv+`)
    # must not overwrite the fault that started it, as `RENDER_Emergency` refuses to.
    if self.machine.bus(cmd, dt, self.f_elec, self.vec == "closed", running) \
      and not self.fault:
      self.fault = "hv+"
    self.machine.sense(dt, running)
    self.meters.update(dt, self.report_hz, self.machine, FLYBACK_V)
    self.scope.feed(dt, self)
    if self.vec == "guard": self.guard = self.machine.guard_point(cmd, self.ramp.hz)
    if self.vec in ("idle", "fault") or self.fault: return
    # Every threshold reads the fast tier,
    # because on the device that is the only layer a protection is allowed to see.
    # `spin` watches the FORCED vector only: align and catch have no baseline.
    self.fault = self.prot.check(cmd, dt, self.meters.ctrl, self.machine,
      self.ramp.hz, self.target, self.table, self.vec == "forced", self.estim_hz)

  def _coast(self, cmd:Command, dt:float):
    """The bridge is down.
    The rotor spins out under its own load
    and the drive parks in Shutdown only once the quoted coast has run,
    so a fault cleared early cannot re-arm into a turning machine.
    A fault landing mid-coast just stands as the code: the coast clock is never restarted."""
    self._coast_s = max(0.0, self._coast_s - dt)
    if not self.fault and not self.coasting: self.vec = "idle"
    self.machine.coast(dt)
    self._settle(cmd, dt)

  def _latch(self, cmd:Command):
    """The moment a run ends badly: keep the evidence, then drop everything."""
    self.trip = {"freq": self.ramp.hz, "curr": self.machine.curr,
      "vdc": self.machine.vdc, "temp": self.machine.temp}
    # `Brake:Coast` is quoted for 50Hz and scales with where the run ended.
    # Read before the wipe, applied after it, because the wipe clears both.
    ended, keep, remain = max(self.ramp.hz, 0.0), self.fault, self._coast_s
    self._clear_run()
    self.fault = keep
    self.vec = "fault"
    self._coast_s = max(remain, 0.05, cmd.coast_s * ended / 50.0)

  #--------------------------------------------------------------------------------- Start and mode

  def _verdict(self, cmd:Command) -> str|None:
    """Whether a vector may run at all, in the firmware's own terms and in its own order.
    `Motor:Rs` is the current loop's integral, so zero sheds the vector in every mode;
    `Motor:Ke` only feeds the observer, so `if` runs happily without it."""
    if cmd.mode == "vf": return "off"
    if not cmd.shunt_ok: return "shunt"
    # The ceiling answers before the observer does, as `render.c` orders it:
    # no voltage authority is a reason on its own, whatever the model knows.
    if cmd.mod_ceil_pct and cmd.mod_ceil_pct < 10.0: return "volts"
    if not cmd.rs_ohm: return "obs"
    if cmd.mode == "foc" and not cmd.ke_v_hz: return "obs"
    # A sense chain wired against the map cannot be told from a dead one
    # until current is asked for, which is what the start feed guard is for.
    if cmd.phasemap != self.machine.phasemap: return "guard"
    return None

  def _bus_ok(self, cmd:Command) -> bool:
    """The DC-bus window, with the bounds independent
    and an upper bound of zero disabling itself, as `RENDER_Setpoint` tests it."""
    vdc = self.machine.vdc
    return vdc >= cmd.dc_min_v and (not cmd.dc_max_v or vdc <= cmd.dc_max_v)

  def _boot(self, cmd:Command, dt:float):
    """`System:BootDelay` is spent waiting for the BUS, not for a command.

    The device polls `RENDER_Setpoint` on every link frame while `Ctrl:Mode` is not `off`,
    setpoint or no setpoint, and arms the deadline the first time it sees the bus in window.
    By the time an operator writes a speed it is long gone.
    Charging it at the start instead adds the whole delay to the first run of every session,
    which is not a stabilisation and is not what the register buys.
    Only a bus excursion re-arms it."""
    if not cmd.enabled: return
    if not self._bus_ok(cmd):
      self._boot_s = 0.0
      return
    self._boot_s = min(self._boot_s + dt, cmd.boot_delay_s)

  def _armed(self, cmd:Command) -> bool:
    """The gates every start shares, whatever drives the bridge afterwards."""
    if not self._bus_ok(cmd): return False
    if self._boot_s < cmd.boot_delay_s: return False
    if cmd.ripple_max_v and self.machine.ripple > cmd.ripple_max_v: return False
    return cmd.target_hz >= max(cmd.init_hz, cmd.speed_min_hz)

  def _start(self, cmd:Command):
    """The rotor is pulled to a known angle before rotation begins,
    because a random-angle catch is start-or-stall.
    `If:CatchFreq` starts on the V/f table and catches the vector there instead."""
    if self.vec != "idle" or not self._armed(cmd): return
    self.ramp.hz = cmd.init_hz
    self.phase_deg = 0.0
    self.scope.restart(self.machine.vdc)
    # Every start spends the align window in `Start`: `RENDER_Run` is a timer task,
    # so the ramp waits it out on the catch and verdict paths too.
    # Only the align STAGE freezes the field; the others render at `Drive:InitFreq`.
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
    """`Drive:Mode` acts on the LIVE run: a fan in a duct is not restarted to
    change how it is driven.

    `vf` sheds the vector and the table carries on at the current frequency.
    A forced vector only swaps takeover policy.
    Anything else re-enters through the catch, so the angle source never jumps."""
    if self._mode == cmd.mode: return
    prev, self._mode = self._mode, cmd.mode
    if prev is None or self.vec in ("idle", "fault"): return
    self.det.restart()
    verdict = self._verdict(cmd)
    if verdict: self.vec = verdict
    elif self.vec == "forced": pass # policy only, the forced vector runs on
    else:
      self.vec = "catch"    # from a table or a closed loop, re-enter by catch
      self._catch_at = 0.0  # live entry: the catch takes the CURRENT frequency

  def _cutoff(self, cmd:Command):
    """A commanded stop rides the `Fall` table down and cuts at the bottom,
    rather than crawling to zero: below the cutoff there is nothing left worth rendering,
    so the drive drops the bridge."""
    if self.target > 0.0 or self.vec == "idle": return
    if self.ramp.hz <= max(cmd.speed_min_hz, cmd.init_hz, 0.05): self._clear_run()

  #----------------------------------------------------------------------------------------- Output

  def _rebase(self):
    """Keep the physical vector continuous across a stage change.
    Whoever takes the bridge next renders a different quantity,
    so the angle has to be restated in its terms before the first sub-step of the new stage."""
    table = self.table
    if table != self._was_table: self.machine.rebase(table)
    self._was_table = table

  def _output(self, cmd:Command, dt:float):
    """One quantity is imposed and the other follows from the machine.

    A drive cannot hold voltage and current at once,
    so publishing both from their own tables would describe hardware that does not exist.
    Under the `Volt` table the bridge sets volts
    and the current is whatever the winding draws against its back-EMF;
    under a current vector the loops set amps
    and the voltage is whatever it takes to push them past that same back-EMF.

    Either way the machine integrates it.
    What arrives here is a job, not an answer,
    which is the only reason a step in the command looks like one."""
    self._rebase()
    m, hz = self.machine, self.ramp.hz
    closed = self.vec == "closed"
    # Align freezes the rendered angle, so the field waits and the rotor pulls into it.
    # A closed loop rides the observer,
    # so the field IS the rotor and the load angle stops being a free state.
    field = 0.0 if self._align_s > 0.0 and self.vec == "align" \
      else (m.wr if closed else hz)
    self.phase_deg = (self.phase_deg + 360.0 * field * dt) % 360.0
    if self.table: m.advance(cmd, dt, field, volts=m.table_volts(cmd, hz))
    elif closed:
      m.advance(cmd, dt, field, closed=True,
        ref=(m.flux_ref(cmd), m.speed_ref(cmd, hz, dt)))
    else: m.advance(cmd, dt, field, ref=(m.forced_mag(cmd, hz), 0.0))
    # Only the vector core is bound by the register's circle.
    # The table is bound by the bridge, and clamping it early would hide a starved table.
    ceiling = 100.0 if self.table else cmd.mod_ceil_pct
    sat = m.modulate(cmd, hz, ceiling)
    self._sat = sat
    self.flags = ((FLAG_REGEN if m.regen else 0)
      | (FLAG_LIMIT if not self.table and abs(m.iq) >= cmd.iq_max_a - 1e-6 else 0)
      | (FLAG_SAT if sat else 0))

  #--------------------------------------------------------------------------------------- Takeover

  def _detect(self, cmd:Command, dt:float):
    """Hand the elapsed time to the detector and apply what it decided.
    The stage transitions the detector cannot see belong here:
    a verdict voids the evidence, and align and catch both end in the forced vector."""
    if self.vec in VERDICT_VEC:
      self.det.lock = 0
      self.det.close_done = False
      return
    if self.vec == "align" and self._align_s <= 0.0: self.vec = "forced"
    # A catch armed by a start waits for its frequency;
    # one armed by a live mode change has no rising edge to wait for and takes the current one.
    if self.vec == "catch" and self.ramp.hz >= self._catch_at: self.vec = "forced"
    if self.vec == "align": return
    out = self.det.step(cmd, dt, self.obs, self.machine.slip, self.vec, self.ramp.hz)
    if out.hz is not None: self.ramp.hz = out.hz
    if out.vec == "closed": self.machine.takeover(cmd)
    if out.vec: self.vec = out.vec
    if out.fault: self.fault = out.fault
