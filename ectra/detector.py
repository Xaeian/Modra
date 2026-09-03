"""
The takeover FSM, on its own 10ms cadence, as `OBS_Track` runs it.

Runs in model time rather than in poll ticks, so the evidence bucket fills at the
pace the device fills it whatever the app's polling does.

It decides, it does not act: one pass returns a `Verdict` and the caller applies
it. Every test reads the observer's instantaneous discriminant and PLL speed,
which is what the device reads; the smoothed registers a poll sees are made
elsewhere and never gate anything.
"""

from dataclasses import dataclass
from math import pi as PI
from .command import Command
from .machine import wrap
from .observer import Observer

#------------------------------------------------------------------- Firmware constants, from obs.c

DET_s = 0.010
LOCK_FULL = 40
LOCK_DRAIN = 4
LOCK_MAX = 0xFF
UNLOCK_N = 8
LOW_N = 3
FRESH_N = 50
RESYNC_LIMIT = 3
RESYNC_DECAY_s = 4.0
BLIND_s = 5.0
TAKEOVER_GAP_Hz = 1.0

# `Sync:ExitCause`
EXIT = ("none", "low", "chatter", "high", "unlock", "weak", "config")

#------------------------------------------------------------------------------------------ Verdict

@dataclass
class Verdict:
  """What one pass decided. `None` anywhere means unchanged."""
  vec: str|None = None
  hz: float|None = None
  fault: str|None = None
  delta: float|None = None   # frame rotation at a takeover [rad]
  resync: bool = False       # the forced accumulator re-seeds from the observer

#----------------------------------------------------------------------------------------- Detector

class Detector:
  """Evidence bucket, the takeover gate and the debounced ways back out."""
  def __init__(self, legacy:bool=False):
    # `legacy` reproduces 0.11.4: no hold after an exit, no speed copy on a
    # high exit, re-entry at the bare observer angle
    self.legacy = legacy
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device."""
    self.clear()
    self.takeovers = 0
    self.fallbacks = 0
    self.exit_cause = "none"
    self.exit_ms = 0.0
    self.delta = 0.0         # `Foc:TakeoverDelta` [rad]

  def clear(self):
    """Everything one run owns."""
    self.lock = 0
    self.close_done = False
    self._det = 0.0
    self._unlock_n = self._low_n = self._high_n = self._weak_n = 0
    self._fresh = 0
    self._resync = 0
    self._resync_s = 0.0
    self._blind_s = 0.0
    self._entry_s = 0.0
    self._hold_s = 0.0       # `Foc:RetryHold` left to run
    self._closed_s = 0.0

  def restart(self):
    """A live `Drive:Mode` change: approach state belongs to ONE attempt."""
    self._entry_s = 0.0
    self.close_done = False
    self.lock = 0

  #------------------------------------------------------------------------------------------- Step

  def step(self, cmd:Command, dt:float, obs:Observer, vec:str, hz:float,
    theta_render:float) -> Verdict:
    """Drain the elapsed time into 10ms ticks and report what they decided."""
    out = Verdict()
    self._det = min(self._det + dt, 1.0)
    while self._det >= DET_s:
      self._det -= DET_s
      self._tick(cmd, obs, out.vec or vec, hz, theta_render, out)
      if out.fault: return out
      if out.hz is not None: hz = out.hz
    if self._resync:
      self._resync_s += dt
      if self._resync_s >= RESYNC_DECAY_s:
        self._resync_s = 0.0
        self._resync -= 1
    return out

  def _tick(self, cmd:Command, obs:Observer, vec:str, hz:float, theta_render:float,
    out:Verdict):
    if not obs.valid:
      if vec == "closed": self._leave(cmd, "config", obs, out, copy=False)
      self._blind_s = 0.0
      return
    if vec == "closed": self._exits(cmd, obs, hz, out)
    else: self._gate(cmd, obs, hz, theta_render, out)

  #------------------------------------------------------------------------------------------ Entry

  def _gate(self, cmd:Command, obs:Observer, hz:float, theta_render:float, out:Verdict):
    """Takeover arms only in `foc`; `if` rides the forced vector for good."""
    speed_ok = abs(abs(obs.hz) - hz) < hz * max(0.0, cmd.lock_speed_pct) / 100.0
    locked_now = abs(obs.err) < obs.lock_sin
    freq_ok = hz > cmd.fallback_low_hz + TAKEOVER_GAP_Hz
    if cmd.entry_hz and hz < cmd.entry_hz - 0.005: freq_ok = False
    enabled = cmd.mode == "foc" and cmd.lock_err_deg > 0
    held = self._hold_s > 0.0
    if held: self._hold_s = max(0.0, self._hold_s - DET_s)
    if enabled and freq_ok and locked_now and speed_ok and not held:
      self.lock = min(LOCK_MAX, self.lock + 1)
    elif not enabled or not freq_ok or held:
      self.lock = 0
    else:
      self.lock = max(0, self.lock - LOCK_DRAIN)
    if self.lock >= LOCK_FULL and abs(obs.err) < obs.lock_sin / 2.0:
      self.delta = wrap(theta_render - obs.theta_hat)
      out.vec = "closed"
      out.delta = self.delta
      self.takeovers += 1
      self.exit_cause = "none"
      self._fresh = FRESH_N
      self._unlock_n = self._low_n = self._high_n = self._weak_n = 0
      self._closed_s = 0.0
      return
    self._blind(cmd, obs, hz, freq_ok, out)
    self._entry_wait(cmd, hz, out)

  def _blind(self, cmd:Command, obs:Observer, hz:float, freq_ok:bool, out:Verdict):
    """Pushing above the band against a standing shaft or a collapsed flux can
    never become a takeover, so the drive stops pushing instead of grinding on."""
    stalled = abs(obs.hz) < hz * max(0.0, cmd.lock_speed_pct) / 100.0
    if cmd.mode == "foc" and freq_ok and (stalled or obs.weak):
      self._blind_s += DET_s
      if self._blind_s >= BLIND_s: out.fault = "sync"
    elif self._blind_s:
      self._blind_s = max(0.0, self._blind_s - DET_s)

  def _entry_wait(self, cmd:Command, hz:float, out:Verdict):
    """The wait at the entry frequency is bounded, and expiry is a fault."""
    if not (cmd.mode == "foc" and cmd.entry_hz and cmd.entry_timeout_s) \
      or self.close_done or hz < cmd.entry_hz - 0.005:
      self._entry_s = 0.0
      return
    self._entry_s += DET_s
    if self._entry_s >= cmd.entry_timeout_s: out.fault = "sync"

  #------------------------------------------------------------------------------------------- Exit

  def _exits(self, cmd:Command, obs:Observer, hz:float, out:Verdict):
    """Both exits watch the OBSERVER, never the ramp."""
    self._closed_s += DET_s
    w = abs(obs.hz)
    self._low_n = self._low_n + 1 if w < cmd.fallback_low_hz else 0
    over = cmd.fallback_high_hz and w > hz + cmd.fallback_high_hz
    self._high_n = self._high_n + 1 if over else 0
    self._unlock_n = self._unlock_n + 1 if abs(obs.err) > obs.unlock_sin else 0
    self._weak_n = self._weak_n + 1 if obs.weak else 0
    if self._fresh:
      self._fresh -= 1
      if not self._fresh: self.close_done = True
    low = self._low_n >= LOW_N
    high = self._high_n >= LOW_N
    unlocked = self._unlock_n >= UNLOCK_N
    weak = self._weak_n >= UNLOCK_N
    if not (low or high or unlocked or weak): return
    cause = ("chatter" if self._fresh else "low") if low else "high" if high \
      else "unlock" if unlocked else "weak"
    if not low or self._fresh:
      if not self._resync: self._resync_s = 0.0
      self._resync += 1
      if self._resync >= RESYNC_LIMIT:
        out.fault = "sync"
        self.exit_cause = cause
        self.exit_ms = self._closed_s * 1000.0
        return
    self._leave(cmd, cause, obs, out, copy=not (high and self.legacy))

  def _leave(self, cmd:Command, cause:str, obs:Observer, out:Verdict, copy:bool):
    """Closed to forced: name the cause, hold the gate, hand the ramp the speed."""
    self.exit_cause = cause
    self.exit_ms = self._closed_s * 1000.0
    self._hold_s = 0.0 if self.legacy else max(0.0, cmd.retry_hold_s)
    w = abs(obs.hz)
    if copy and w >= cmd.fallback_low_hz: out.hz = w
    out.vec = "forced"
    out.resync = True
    self.fallbacks += 1
    self.lock = 0
    self._unlock_n = self._low_n = self._high_n = self._weak_n = 0
