"""
The frequency ramp: where the command is allowed to go, and how fast.

Owns the rendered frequency. Everything that can hold it back lives here too,
because a ramp that stops is the same mechanism as a ramp that moves, and the
operator has to be told which gate is standing on it.
"""

from .command import Command
from .curve import interp
from .meter import Meters

#--------------------------------------------------------------------------------------------- Ramp

class Ramp:
  """Rendered frequency, its ceiling, and every gate that can freeze it."""
  def __init__(self):
    self.reset()

  def reset(self):
    """Power-on. The episode counters are boot-sticky on the device, so this is
    the only thing that clears them."""
    self.clear()
    self.holds = 0

  def clear(self):
    """Everything one run owns."""
    self.hz = 0.0        # rendered electrical frequency, the field
    self.goal = 0.0      # where it may go, after every limit
    self.freeze = "off"  # off | hv- | hv+ | hold
    self._held = False   # ceiling-hold edge, so one hold counts once

  #---------------------------------------------------------------------------------------- Ceiling

  def _derate(self, cmd:Command, meters:Meters, ceiling:float) -> float:
    """A hot day means slower, not a fault. The limit slides from the command
    toward `Speed:DerateLimit` and gets there at the trip threshold, from
    temperature and from current independently, and the lower one wins.

    Reads the SLOW tier: a speed limit that chased the fast one would chase the
    load and the rotor swing with it."""
    view = meters.view
    for now, on, off in ((view.temp, cmd.derate_temp_c, cmd.temp_max_c),
      (view.curr, cmd.derate_curr_a, cmd.curr_rms_a)):
      if not on or not off or off <= on or now <= on: continue
      frac = min(1.0, (now - on) / (off - on))
      ceiling = min(ceiling, ceiling + (cmd.derate_hz - ceiling) * frac)
    return ceiling

  def _goal(self, cmd:Command, meters:Meters, close_done:bool) -> float:
    """The command after every limit, and in `foc` the entry frequency first,
    because the loop closes there and only then walks to the working point, up
    or down."""
    if cmd.target_hz <= 0.0: return 0.0
    goal = cmd.target_hz
    if cmd.speed_max_hz: goal = min(goal, cmd.speed_max_hz)
    goal = max(goal, min(cmd.speed_min_hz, cmd.target_hz))
    goal = self._derate(cmd, meters, goal)
    if cmd.mode == "foc" and cmd.entry_hz and cmd.lock_err_deg and not close_done:
      return cmd.entry_hz
    return goal

  #------------------------------------------------------------------------------------------- Step

  def slew(self, cmd:Command, dt:float, meters:Meters, blind:bool,
    close_done:bool, aligning:bool, sat:bool=False):
    """A rate is a tempo, so the table is read at where the drive is now, not at
    where it is going. Alignment holds the ramp at the starting frequency."""
    goal = self._goal(cmd, meters, close_done)
    # The I/f ceiling caps every blind vector, `foc` on its approach as much as
    # `if` at its working point. Only a closed loop is exempt.
    if cmd.max_freq_hz and blind: goal = min(goal, cmd.max_freq_hz)
    # No voltage authority: a blind vector pinned to the modulation ceiling
    # stops delivering its current, which slips the rotor and pumps the bus, so
    # the climb stops where the bridge ran out. Descending is still allowed.
    if blind and sat: goal = min(goal, self.hz)
    # Published even while the rotor is being pulled in, because the target
    # after every limit is known then and the distance left to it is the point.
    self.goal = goal
    if aligning: return
    up = goal > self.hz
    self._hold(cmd, goal, blind)
    if self._frozen(cmd, meters.ctrl, up): return
    rate = interp(cmd.rise if up else cmd.fall, self.hz)
    if rate is None:
      self.hz = goal
      return
    self.hz = min(goal, self.hz + rate * dt) if up else max(goal, self.hz - rate * dt)

  #------------------------------------------------------------------------------------------ Gates

  def _hold(self, cmd:Command, goal:float, blind:bool):
    """A blind vector stopped short of the command. A hold that blocks a CLIMB
    is an episode; sitting at a setpoint is not."""
    held = blind and cmd.target_hz > goal + 0.05 and self.hz >= goal - 0.05
    if held and not self._held: self.holds += 1
    self._held = held
    if held: self.freeze = "hold"
    elif self.freeze == "hold": self.freeze = "off"

  def _frozen(self, cmd:Command, ctrl, up:bool) -> bool:
    """Bus gates: a sagging bus may not accelerate, a pumped one may not
    decelerate. Release carries hysteresis, so a gate cannot chatter."""
    hyst = max(0.0, cmd.freeze_hyst_v)
    if up and cmd.freeze_low_v and (ctrl.vdc < cmd.freeze_low_v
      or (self.freeze == "hv-" and ctrl.vdc < cmd.freeze_low_v + hyst)):
      self.freeze = "hv-"
      return True
    if not up and cmd.freeze_high_v and (ctrl.vdc > cmd.freeze_high_v
      or (self.freeze == "hv+" and ctrl.vdc > cmd.freeze_high_v - hyst)):
      self.freeze = "hv+"
      return True
    if self.freeze in ("hv-", "hv+"): self.freeze = "off"
    return False

