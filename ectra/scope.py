"""
Publication layer: how a fast value reaches a slow register.

Mirrors the drive's own meters.
Sources push their natural quantity in at their natural rate;
this decides the shape a Modbus reader sees, and it is the only thing that does.

Three shapers, as the device has them:
`Env` is instant attack and steady decay, `Mean` is an exponential average,
and the one maximum, `bus_max`, is latched until the reset at every start.
"""

from math import asin, pi as PI

#-------------------------------------------------------------------------------------------- Rates

# An envelope carries `value << 5` and decays `decay` accumulator units per feed,
# so a channel falls `decay / 32` of its own unit per feed.
ERR_PEAK_degs = 21.875
# `Obs:OmegaRipple` falls 2Hz/s around a center that is `w_hat` through a `2^9`-tick mean
RIPPLE_PEAK_Hzs = 2.0
RIPPLE_CENTER_s = 0.0512
# Every mean feeds on the fixed 10ms grid with `shift 5`
MEAN_s = 0.32

#------------------------------------------------------------------------------------------ Shapers

class Env:
  """Instant attack, steady decay, never below the live feed."""
  def __init__(self, rate:float):
    self.rate = rate
    self.v = 0.0

  def feed(self, x:float, dt:float):
    self.v = x if x >= self.v else max(x, self.v - self.rate * dt)

  def reset(self, v:float=0.0):
    self.v = v

class Mean:
  """Exponential average. Takes the first sample whole."""
  def __init__(self, tau:float=MEAN_s):
    self.tau = tau
    self.v = None

  def feed(self, x:float, dt:float):
    self.v = x if self.v is None else self.v + (x - self.v) * dt / (self.tau + dt)

  def read(self) -> float:
    return 0.0 if self.v is None else self.v

  def reset(self):
    self.v = None

#-------------------------------------------------------------------------------------------- Scope

class Scope:
  """Every shaped reading the drive publishes, in one place."""
  def __init__(self):
    self.err_peak = Env(ERR_PEAK_degs)
    self.theta = Mean()   # `Obs:AngleErr`
    self.err = Mean()     # `Sync:Err`
    self.bias = Mean()    # `Obs:Bias`
    self.omega = Mean()   # `Obs:OmegaHat`
    self.center = Mean(RIPPLE_CENTER_s)
    self.ripple = Env(RIPPLE_PEAK_Hzs) # `Obs:OmegaRipple`
    self.vd = Mean()
    self.vq = Mean()
    self.bus_max = 0.0
    self.reset()

  def reset(self):
    for ch in (self.err_peak, self.ripple): ch.reset()
    for ch in (self.theta, self.err, self.bias, self.omega, self.center, self.vd, self.vq):
      ch.reset()
    self.bus_max = 0.0

  def restart(self, vdc:float):
    """The peak reset at every start."""
    self.bus_max = vdc

  def feed(self, dt:float, plant):
    """One pass over every channel, from one instant of the plant."""
    m, o = plant.machine, plant.obs
    self.bus_max = max(self.bus_max, m.vdc)
    # The gate reads the discriminant tick by tick;
    # the peak meter must not miss the sub-step that refused it, so it takes the tick's maximum
    peak = asin(min(1.0, o.tick_peak())) * 180.0 / PI
    self.err_peak.feed(peak, dt)
    self.theta.feed(o.angle_vs(plant.theta_applied), dt)
    self.err.feed(o.tick_err(), dt)
    self.bias.feed(o.hz - plant.ramp.hz, dt)
    self.omega.feed(abs(o.hz), dt)
    self.center.feed(o.hz, dt)
    self.ripple.feed(abs(o.hz - self.center.read()), dt)
    self.vd.feed(plant.vd, dt)
    self.vq.feed(plant.vq, dt)
