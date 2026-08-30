"""
The takeover FSM, on its own 10ms cadence.

Runs in real time rather than in poll ticks, so the evidence bucket fills at the
pace the device fills it whatever the app's polling does.

It decides, it does not act: one pass returns a `Verdict` and the caller applies
it. That keeps the stage machine in one place and makes a takeover assertable
without a drive around it.
"""

from dataclasses import dataclass
from math import asin, pi as PI, sin
from .command import Command
from .curve import clamp
from .observer import Observer

#------------------------------------------------------------------- Firmware constants, from obs.c

# The detector counts TIME, not update ticks: a 10ms cadence, 400ms to enter.
# A disagreeing tick drains four, so entry needs a majority.
DET_s = 0.010
LOCK_FULL = 40
LOCK_DRAIN = 4
LOCK_MAX = 0xFF
# Exit debounces: one wobbling sample must not throw a takeover away.
UNLOCK_N = 8
LOW_N = 3
# Entry-chatter window. The approach hold is released by this, not by the switch.
FRESH_N = 50
# The unlock edge sits past any load angle, keeping hysteresis against LockErr.
# `OBS_UNLOCK_ERR/MAX` are a Q15 SINE, so the edges are their arcsines.
UNLOCK_MIN_deg = 52.51
UNLOCK_MAX_deg = 66.28
# Sync-loss ladder: fallbacks tolerated before the fault, and their decay pace.
RESYNC_LIMIT = 3
RESYNC_DECAY_s = 4.0
# Blind pushing above the band against a standing shaft, before the fault.
BLIND_s = 5.0
# The takeover band opens this far above the fallback floor, from shared.h.
TAKEOVER_GAP_Hz = 1.0

#------------------------------------------------------------------------------------------ Verdict

@dataclass
class Verdict:
  """What one pass decided. `None` anywhere means unchanged."""
  vec: str|None = None
  hz: float|None = None
  fault: str|None = None

#----------------------------------------------------------------------------------------- Detector

class Detector:
  """Evidence bucket, the takeover gate and the debounced ways back out."""
  def __init__(self):
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device, so this is
    the only thing that clears them."""
    self.clear()
    self.takeovers = 0
    self.fallbacks = 0

  def clear(self):
    """Everything one run owns."""
    self.lock = 0
    self.close_done = False  # approach released, ramp free to the setpoint
    self._det = 0.0          # detector time carried between steps
    self._unlock_n = 0
    self._low_n = 0
    self._high_n = 0
    self._fresh = 0          # entry-chatter ticks left
    self._resync = 0
    self._resync_s = 0.0
    self._blind_s = 0.0
    self._entry_s = 0.0      # time spent waiting at the entry frequency

  def restart(self):
    """A live `Drive:Mode` change. Approach state belongs to ONE attempt: a
    deadline armed before the switch would fire the moment `foc` came back, and
    a `close_done` left from an earlier success would skip the approach."""
    self._entry_s = 0.0
    self.close_done = False
    self.lock = 0

  #------------------------------------------------------------------------------------------- Step

  def step(self, cmd:Command, dt:float, obs:Observer, slip:bool, vec:str,
    hz:float) -> Verdict:
    """Drain the elapsed time into 10ms ticks and report what they decided."""
    out = Verdict()
    self._det = min(self._det + dt, 1.0)
    while self._det >= DET_s:
      self._det -= DET_s
      self._tick(cmd, obs, slip, out.vec or vec, hz, out)
      if out.fault: return out
      if out.hz is not None: hz = out.hz
    if self._resync:
      self._resync_s += dt
      if self._resync_s >= RESYNC_DECAY_s:
        self._resync_s = 0.0
        self._resync -= 1
    return out

  def _tick(self, cmd:Command, obs:Observer, slip:bool, vec:str, hz:float,
    out:Verdict):
    """One 10ms tick: the gate and bucket while forced, the debounced exits
    while closed."""
    if vec == "closed": self._exits(cmd, obs, hz, out)
    else: self._gate(cmd, obs, slip, hz, out)

  #------------------------------------------------------------------------------------------ Entry

  def _gate(self, cmd:Command, obs:Observer, slip:bool, hz:float, out:Verdict):
    """Takeover arms only in `foc`; `if` rides the forced vector for good."""
    # Observer against the APPLIED ramp, never against the setpoint. Parked at
    # the entry frequency the two agree, which is what lets the gate open.
    speed_err = abs(obs.w - hz) / max(hz, 1.0) * 100
    # Entry only: the band is read while forced and nowhere else, which is what
    # lets a closed loop descend below the entry frequency to its working point.
    freq_ok = hz > cmd.fallback_low_hz + TAKEOVER_GAP_Hz
    if cmd.entry_hz and hz < cmd.entry_hz - 0.05: freq_ok = False
    enabled = cmd.mode == "foc" and cmd.lock_err_deg > 0

    if enabled and freq_ok and obs.crest < cmd.lock_err_deg \
      and speed_err < cmd.lock_speed_pct:
      self.lock = min(LOCK_MAX, self.lock + 1)
    elif not enabled or not freq_ok:
      # Outside the band the evidence is void, not weak: an inhibited drive must
      # not keep a bucket that enters the moment the band opens.
      self.lock = 0
    else:
      self.lock = max(0, self.lock - LOCK_DRAIN)
    # The bucket proves agreement over the whole window, so it is the CREST that
    # has to stay inside the gate. The switch itself lands on a trough, where
    # the frame rotates least, so that is what the half-gate measures.
    if self.lock >= LOCK_FULL and obs.trough < trough_edge(cmd):
      out.vec = "closed"
      self.takeovers += 1
      self._fresh = FRESH_N
      self._unlock_n = self._low_n = self._high_n = 0
      return
    self._blind(cmd, obs, slip, hz, freq_ok, out)
    self._entry_wait(cmd, hz, out)

  def _blind(self, cmd:Command, obs:Observer, slip:bool, hz:float, freq_ok:bool,
    out:Verdict):
    """Pushing above the takeover band against a shaft that is not turning can
    never become a takeover, so the drive stops pushing instead of grinding on.
    The test is the ESTIMATE itself, not its distance from the ramp: a lagging
    estimate is a slow rotor, a near-zero one is a standing one."""
    stalled = obs.w < hz * max(0.0, cmd.lock_speed_pct) / 100.0
    if cmd.mode == "foc" and freq_ok and (stalled or slip):
      self._blind_s += DET_s
      if self._blind_s >= BLIND_s: out.fault = "sync"
    elif self._blind_s:
      self._blind_s = max(0.0, self._blind_s - DET_s)

  def _entry_wait(self, cmd:Command, hz:float, out:Verdict):
    """The wait at the entry frequency is bounded, and expiry is a fault rather
    than a release: a drive that cannot close says so, instead of running on the
    forced vector because a clock ran out. The deadline runs from arrival."""
    if not (cmd.mode == "foc" and cmd.entry_hz and cmd.entry_timeout_s) \
      or self.close_done or hz < cmd.entry_hz - 0.05:
      self._entry_s = 0.0
      return
    self._entry_s += DET_s
    if self._entry_s >= cmd.entry_timeout_s: out.fault = "sync"

  #------------------------------------------------------------------------------------------- Exit

  def _exits(self, cmd:Command, obs:Observer, hz:float, out:Verdict):
    """Both exits watch the OBSERVER, never the ramp. The ramp is the drive's
    own command, so comparing it with itself could not witness an estimate
    running away, which is the failure these exist to catch."""
    self._low_n = self._low_n + 1 if obs.w < cmd.fallback_low_hz else 0
    over = cmd.fallback_high_hz and obs.w > hz + cmd.fallback_high_hz
    self._high_n = self._high_n + 1 if over else 0
    unlock_deg = clamp(unlock_edge(cmd), UNLOCK_MIN_deg, UNLOCK_MAX_deg)
    self._unlock_n = self._unlock_n + 1 if obs.crest > unlock_deg else 0
    if self._fresh:
      self._fresh -= 1
      # Released by the settle window, not by the switch tick. The entry
      # transient owns the chatter window, and a descent begun inside it would
      # meet the high-side exit with a live sync-loss ladder.
      if not self._fresh: self.close_done = True

    low = self._low_n >= LOW_N
    high = self._high_n >= LOW_N
    if not (low or high or self._unlock_n >= UNLOCK_N): return
    # A hysteresis return on the way down is normal deceleration and stays
    # silent, but a low exit inside the entry window is chatter: it joins the
    # ladder, so a bounce loop cannot run forever.
    if not low or self._fresh:
      self._resync += 1
      self._resync_s = 0.0
      if self._resync >= RESYNC_LIMIT:
        out.fault = "sync"
        return
    # The forced accumulator resumes from the observer wherever that is
    # plausible, so the ramp lands on the real speed instead of teleporting.
    if not high and obs.w >= cmd.fallback_low_hz: out.hz = obs.w
    out.vec = "forced"
    self.fallbacks += 1
    self.lock = 0
    self._unlock_n = self._low_n = self._high_n = 0

#------------------------------------------------------------------------------------------ Helpers

def _sine(deg:float) -> float:
  """The discriminator is a cross product, so every threshold reaches it as a
  Q15 SINE. `staged.lock_q15 = sinf(lock_err)` is where the firmware does it."""
  return sin(min(abs(deg), 90.0) * PI / 180.0)

def unlock_edge(cmd:Command) -> float:
  """Twice the gate width, doubled on the sine and not on the degrees."""
  return asin(min(1.0, 2.0 * _sine(cmd.lock_err_deg))) * 180.0 / PI

def trough_edge(cmd:Command) -> float:
  """Half of it, halved the same way. `err_lock_q15 / 2` is half a SINE, so the
  angle it admits is `asin(sin(LockErr) / 2)`. At the shipped 22 degrees that is
  a fifth of a degree below `LockErr / 2` and nobody would notice; at 60 it is
  four degrees and the naive halving would open a gate the device keeps shut."""
  return asin(min(1.0, _sine(cmd.lock_err_deg) / 2.0)) * 180.0 / PI
