"""
The two measurement tiers, `ctrl` and `view`.

Nothing outside reads the machine directly. Every threshold, every derating
decision and every register goes through a tier, because on the device they do:
the raw sample is filtered twice, fast for control and slow for presentation,
and the two genuinely disagree while anything is moving.

Publishing one instantaneous number on both tiers is what makes a model feel
stepped. A drive does not.
"""

#----------------------------------------------------------------------------------------- Cascades

# `MeasCfg:Window = 256` samples at 10kHz is a 25.6ms window, and the EMA shifts
# are exponents over it: `WindowCtrl = 1` is two windows, `WindowView = 7` is a
# hundred and twenty eight. Currents, peaks and ripple ride those.
WINDOW_s = 0.0256
CURR_CTRL_s = 2 * WINDOW_s
CURR_VIEW_s = 128 * WINDOW_s
# Scalars are filtered per sample instead: `ScalarCtrl = 5` is 32 samples,
# `ScalarView = 15` is a full 3.3 seconds.
SCALAR_CTRL_s = 32 / 10000.0
SCALAR_VIEW_s = 32768 / 10000.0
# Frequency is decimated BEFORE it is filtered: one report per
# `MeasCfg:FreqReport = 4` windows, and only then the EMA shift. So the fast
# tier is `2^1` reports and the slow one `2^2`, which is four times the lag a
# reader gets from the current cascade.
REPORT_s = 4 * WINDOW_s
FREQ_CTRL_s = 2 * REPORT_s
FREQ_VIEW_s = 4 * REPORT_s

# Which cascade each reading rides.
CURRENTS = ("curr", "peak", "ripple")
SCALARS = ("temp", "vdc", "flyback", "power")
FREQS = ("freq",)

#--------------------------------------------------------------------------------------------- Tier

class Tier:
  """One filtered view of the machine. `ctrl` is what the protections and the
  loops read, `view` is the trend behind derating and the display."""
  def __init__(self, curr_s:float, scalar_s:float, freq_s:float):
    self.tau = {}
    for k in CURRENTS: self.tau[k] = curr_s
    for k in SCALARS: self.tau[k] = scalar_s
    for k in FREQS: self.tau[k] = freq_s
    self.reset()

  def reset(self):
    self.v = {}

  def update(self, dt:float, source:dict):
    """One EMA step per reading. A tier with no history takes the first sample
    whole, so a fresh drive does not spend a filter length climbing out of zero."""
    for k, x in source.items():
      prev = self.v.get(k)
      tau = self.tau.get(k, 0.0)
      self.v[k] = x if prev is None or tau <= 0.0 else prev + (x - prev) * dt / (tau + dt)

  def __getattr__(self, k:str) -> float:
    # Only reached for names the instance does not carry, so the readings stay
    # `tier.curr` instead of `tier.v["curr"]` at every call site. A channel this
    # tier knows but has not been fed yet reads zero rather than raising: the
    # first Modbus read can land before the motor thread's first tick, and a
    # transport is not the place to discover that.
    box = self.__dict__
    v = box.get("v") or {}
    if k in v: return v[k]
    if k in (box.get("tau") or {}): return 0.0
    raise AttributeError(k)

#------------------------------------------------------------------------------------------- Meters

class Meters:
  """Both tiers, fed from one snapshot so they can never describe different
  instants of the same machine."""
  def __init__(self):
    self.ctrl = Tier(CURR_CTRL_s, SCALAR_CTRL_s, FREQ_CTRL_s)
    self.view = Tier(CURR_VIEW_s, SCALAR_VIEW_s, FREQ_VIEW_s)
    self.reset()

  def reset(self):
    self.ctrl.reset()
    self.view.reset()

  def update(self, dt:float, freq:float, m, flyback:float):
    """`m` is the machine; the snapshot is taken once and handed to both."""
    source = {
      "freq": freq, "curr": m.curr, "peak": m.peak, "ripple": m.ripple,
      "temp": m.temp, "vdc": m.vdc, "flyback": flyback, "power": m.power,
    }
    self.ctrl.update(dt, source)
    self.view.update(dt, source)
