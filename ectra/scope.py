"""
Publication layer: how a fast value reaches a slow register.

Mirrors `foc-sig/diag/scope.c`. Sources push their natural quantity in at their
natural rate; this decides the shape a Modbus reader sees, and it is the only
thing that does. Scattering that decision across the modules that produce the
values is how a peak ends up decaying at one pace in one register and another
pace in the next.

Three shapers, as the device has them:

- `Env` is instant attack and steady decay, never below the live feed. A meter a
  one-second poll cannot miss.
- `Max` is latched until an explicit reset, the forensic value around a fault.
- `Mean` is an exponential average for tuning signals that swing.
"""

from math import pi as PI, sin

#-------------------------------------------------------------------------------------------- Rates

# `SCOPE_Env_t` carries `value << 5` and decays `decay` accumulator units per
# feed, so a channel falls `decay / 32` of its own unit per feed. The feed rates
# differ per channel and that is the whole subtlety: bus and duty ride the 10kHz
# ISR, the takeover meters ride the 10ms detector.
#   bus:   decay 3 at 10kHz over [V x10]
#   duty:  decay 1 at 10kHz over CCR counts, `ARR` 3200 for full scale
#   err:   decay 700 at 100Hz over [deg x100]
#   lock:  decay 6 at 100Hz over raw bucket ticks
BUS_PEAK_Vs = 93.75
DUTY_PEAK_pcts = 9.77
ERR_PEAK_degs = 21.875
LOCK_PEAK_ticks = 18.75

# Every mean feeds on the fixed 10ms grid with `shift 5`, so a reading means the
# same thing at 20Hz and at 55Hz. That is also why the registers carrying these
# say `srednia z 320ms` and why tuning against them is stable.
MEAN_s = 0.32

# `err_deg = (err_n * 5730) >> 15` converts the Q15 SINE the discriminator holds
# as if it were the angle itself. True below about ten degrees and increasingly
# short above: a real 40 degrees publishes as 37, a real 60 as 50. The gate is
# unaffected, because it compares sines with sines, but a reader who trusts the
# register at a large error is reading a compressed number.
def small_angle(deg:float) -> float:
  """Degrees as the device publishes them."""
  return sin(min(abs(deg), 90.0) * PI / 180.0) * 180.0 / PI

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
  """Exponential average. Takes the first sample whole, so a fresh drive does
  not spend a filter length climbing out of zero."""
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
    self.duty = Env(DUTY_PEAK_pcts)
    self.bus = Env(BUS_PEAK_Vs)
    self.err_peak = Env(ERR_PEAK_degs)
    self.lock_peak = Env(LOCK_PEAK_ticks)
    self.theta = Mean()   # `Obs:AngleErr`
    self.err = Mean()     # `Sync:Err`, the gate's own discriminant
    self.bias = Mean()    # `Obs:Bias`
    self.omega = Mean()   # `Obs:OmegaHat`
    self.vd = Mean()
    self.vq = Mean()
    self.bus_max = 0.0
    self.reset()

  def reset(self):
    """Power-on."""
    for ch in (self.duty, self.bus, self.err_peak, self.lock_peak): ch.reset()
    for ch in (self.theta, self.err, self.bias, self.omega, self.vd, self.vq): ch.reset()
    self.bus_max = 0.0

  def restart(self, vdc:float):
    """`SCOPE_MaxReset` at every start: `Bus:Max` answers for the run that is
    beginning, not for everything the link has seen since power-on."""
    self.bus_max = vdc

  def feed(self, dt:float, plant):
    """One pass over every channel. Taken from one instant of the plant, so no
    two registers can describe different moments of the same machine."""
    m, o = plant.machine, plant.obs
    self.bus.feed(m.vdc, dt)
    self.bus_max = max(self.bus_max, m.vdc)
    self.duty.feed(m.mod_index, dt)
    # The gate compares the crest, so that is what the peak meter witnesses.
    self.err_peak.feed(small_angle(o.crest), dt)
    self.lock_peak.feed(float(plant.det.lock), dt)
    # Two different angles, and the device keeps them apart: `Obs:AngleErr` is
    # the observer against the applied field, `Sync:Err` is the gate's own
    # discriminant. Feeding both from one number is what makes a reader think
    # the load angle gates a takeover.
    self.theta.feed(small_angle(o.field), dt)
    self.err.feed(small_angle(o.err), dt)
    self.bias.feed(o.w - plant.ramp.hz, dt)
    self.omega.feed(o.w, dt)
    self.vd.feed(plant.vd, dt)
    self.vq.feed(plant.vq, dt)
