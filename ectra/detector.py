"""
The takeover gate and the loss detectors, on their own 10ms cadence, as the drive runs them.

Runs in model time rather than in poll ticks,
so the evidence bucket fills at the pace the device fills it whatever the app's polling does.

It decides, it does not act: one pass returns a `Verdict` and the caller applies it.
Every test reads the observer's instantaneous discriminant and PLL speed.
The device's gate reads the same; its slip and spin tests average the speed over whole turns,
which this model does not.
The smoothed registers a poll sees are made elsewhere and never gate anything.
"""

from dataclasses import dataclass
from .command import Command
from .machine import wrap
from .observer import Observer

#------------------------------------------------------------------------------- Observer constants

DET_s = 0.010
LOCK_FULL = 40
LOCK_DRAIN = 4
LOCK_MAX = 0xFF
UNLOCK_N = 8
SLIP_N = 3
FRESH_N = 50

#------------------------------------------------------------------------------------------ Verdict

@dataclass
class Verdict:
  """What one pass decided. `None` anywhere means unchanged."""
  vec: str|None = None
  fault: str|None = None
  delta: float|None = None # frame rotation at a takeover [rad]

#----------------------------------------------------------------------------------------- Detector

class Detector:
  """Evidence bucket, the takeover gate and the debounced detectors that end a closed loop."""
  def __init__(self):
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device."""
    self.clear()
    self.takeovers = 0
    self.losses = 0
    # New run-ups from state B: the plant has no state B, so this stays 0
    self.restarts = 0
    self.exit_cause = "none"
    self.exit_ms = 0.0
    self.delta = 0.0 # `Foc:TakeoverDelta` [rad]

  def clear(self):
    """Everything one run owns."""
    self.lock = 0
    self.close_done = False
    self._det = 0.0
    self._unlock_n = self._slip_n = self._weak_n = 0
    self._fresh = 0
    self._entry_s = 0.0
    self._closed_s = 0.0

  def restart(self):
    """A live `Drive:Mode` change: approach state belongs to ONE attempt."""
    self._entry_s = 0.0
    self.close_done = False
    self.lock = 0

  #------------------------------------------------------------------------------------------- Step

  def step(
    self, cmd:Command, dt:float, obs:Observer, vec:str, hz:float, theta_render:float,
  ) -> Verdict:
    """Drain the elapsed time into 10ms ticks and report what they decided."""
    out = Verdict()
    self._det = min(self._det + dt, 1.0)
    while self._det >= DET_s:
      self._det -= DET_s
      self._tick(cmd, obs, out.vec or vec, hz, theta_render, out)
      if out.fault: return out
    return out

  def _tick(
    self, cmd:Command, obs:Observer, vec:str, hz:float, theta_render:float, out:Verdict,
  ):
    if not obs.valid:
      if vec == "closed": self._lost("config", out)
      return
    if vec == "closed": self._exits(cmd, obs, hz, out)
    else: self._gate(cmd, obs, hz, theta_render, out)

  #------------------------------------------------------------------------------------------ Entry

  def _gate(self, cmd:Command, obs:Observer, hz:float, theta_render:float, out:Verdict):
    """Takeover arms only in `foc`; `if` rides the forced vector for good."""
    # Signed as the drive signs it:
    # an estimate turning the other way is as far from the field as one standing still,
    # and a collapsed flux is no evidence at all
    speed_ok = abs(obs.hz - hz) < hz * max(0.0, cmd.lock_speed_pct) / 100.0
    locked_now = abs(obs.err) < obs.lock_sin
    sync_now = locked_now and speed_ok and not obs.weak
    # The loop closes at `Foc:EntryFreq` and nowhere else; `0` means no takeover
    freq_ok = cmd.entry_hz > 0 and hz >= cmd.entry_hz - 0.005
    enabled = cmd.mode == "foc" and cmd.lock_err_deg > 0
    if enabled and freq_ok and sync_now:
      self.lock = min(LOCK_MAX, self.lock + 1)
    elif not enabled or not freq_ok:
      self.lock = 0
    else:
      self.lock = max(0, self.lock - LOCK_DRAIN)
    if self.lock >= LOCK_FULL and sync_now and abs(obs.err) < obs.lock_sin / 2.0:
      self.delta = wrap(theta_render - obs.theta)
      out.vec = "closed"
      out.delta = self.delta
      self.takeovers += 1
      self.exit_cause = "none"
      self._fresh = FRESH_N
      self._unlock_n = self._slip_n = self._weak_n = 0
      self._closed_s = 0.0
      return
    self._entry_wait(cmd, hz, out)

  def _entry_wait(self, cmd:Command, hz:float, out:Verdict):
    """The wait at the entry frequency is bounded, and expiry is a fault."""
    if not (cmd.mode == "foc" and cmd.entry_hz and cmd.entry_timeout_s) \
      or self.close_done or hz < cmd.entry_hz - 0.005:
      self._entry_s = 0.0
      return
    self._entry_s += DET_s
    if self._entry_s >= cmd.entry_timeout_s: out.fault = "sync"

  #------------------------------------------------------------------------------------------- Loss

  def _exits(self, cmd:Command, obs:Observer, hz:float, out:Verdict):
    """Every detector watches the OBSERVER, never the ramp."""
    self._closed_s += DET_s
    w = abs(obs.hz)
    # Off the ramp: over it by `Foc:SlipMax`, or under half of it (the rotor stopped).
    # While the command walks the drive down, over the ramp is the rotor's own inertia
    # and the bus guards own it, or every ordinary stop would read as a loss
    falling = cmd.target_hz < hz
    over = cmd.slip_max_hz and not falling and w > hz + cmd.slip_max_hz
    self._slip_n = self._slip_n + 1 if over or w < hz / 2.0 else 0
    self._unlock_n = self._unlock_n + 1 if abs(obs.err) > obs.unlock_sin else 0
    self._weak_n = self._weak_n + 1 if obs.weak else 0
    if self._fresh:
      self._fresh -= 1
      if not self._fresh: self.close_done = True
    slip = self._slip_n >= SLIP_N
    unlocked = self._unlock_n >= UNLOCK_N
    weak = self._weak_n >= UNLOCK_N
    if not (slip or unlocked or weak): return
    self._lost("slip" if slip else "unlock" if unlocked else "weak", out)

  def _lost(self, cause:str, out:Verdict):
    """The one way out of closed: the cause and the episode length stay, the drive faults."""
    self.exit_cause = cause
    self.exit_ms = self._closed_s * 1000.0
    self.losses = min(self.losses + 1, 65534)
    out.fault = "sync"
