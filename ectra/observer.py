"""
The rotor observer, as the drive computes it.

A voltage-model flux integrator with a leak (`Obs:HpHz`),
the active flux `psi_s - Lq i` pointing at the rotor,
a heterodyne discriminant `|psi| sin(theta - theta_hat)` normalised to the entered `Motor:Ke`,
and a second-order PLL (`Pll:Bw`, `Pll:Damp`)
that turns the discriminant into a speed and an angle.

It is fed what the device is fed: the voltage the CCRs carried,
less the dead-time share `Obs:DtComp` asks it to subtract along the phase-current signs,
and the currents the shunts saw.
What the bridge REALLY lost lives in `Machine`;
the gap between the two is what the observer gets wrong,
and every error it has follows from that gap and from the nameplate the operator entered.

Nothing here is a lag on the truth.
The speed is the PLL's own integrator and the angle its own accumulator,
so a takeover that hands them the bridge hands them exactly what they are,
ripple and bias included.
"""

from math import asin, atan, cos, log2, pi as PI, sin
from .command import Command
from .machine import PWM_Hz, V_PEAK, dead_ab, wrap

TWO_PI = 2.0 * PI
# The observer runs at the PWM rate; the leak shift is quantised on that grid
OBS_RATE_Hz = 10000.0
LEAK_SHIFT_MIN, LEAK_SHIFT_MAX = 6, 14
# PLL unlock floor and ceiling as Q15 sines: about 52° and 66°
UNLOCK_MIN, UNLOCK_MAX = 26000.0 / 32768.0, 30000.0 / 32768.0
# Leak compensation floor: under it the lead is a quarter turn of guesswork
LEAD_MIN_Hz = 1.0

#----------------------------------------------------------------------------------------- Observer

class Observer:
  """Flux estimate, discriminant, PLL speed and angle."""
  def __init__(self):
    self.configure(Command(), 590.0)
    self.reset(0.0)

  #-------------------------------------------------------------------------------------- Constants

  def configure(self, cmd:Command, vdc:float):
    """Every constant from the entered map, once per tick."""
    self.rs = max(0.0, cmd.rs_ohm)
    self.lq = max(0.0, cmd.lq_h)
    # Flux the loop normalises to, RMS scale: `Ke f / (2π f)`
    self.psi_nom = cmd.ke_v_hz / TWO_PI
    self.psi_min = self.psi_nom / 4.0
    self.valid = self.rs > 0.0 and self.psi_nom > 0.0
    fc = max(0.05, cmd.obs_hp_hz)
    shift = int(round(log2(OBS_RATE_Hz / (TWO_PI * fc))))
    shift = min(LEAK_SHIFT_MAX, max(LEAK_SHIFT_MIN, shift))
    self.tau = (2.0 ** shift) / OBS_RATE_Hz
    wn = TWO_PI * max(1.0, cmd.pll_bw_hz)
    zeta = max(0.05, cmd.pll_damp)
    self.kp = 2.0 * zeta * wn
    self.ki = wn * wn
    # Dead-time reconstruction: the operator's share of the nominal loss
    dtpu = max(0.0, cmd.deadtime_ns) * 1e-9 * PWM_Hz
    self.v_dt = max(0.0, cmd.dtcomp_pct) / 100.0 * dtpu * vdc / V_PEAK
    self.lock_sin = sin(min(89.9, max(0.0, cmd.lock_err_deg)) * PI / 180.0)
    self.unlock_sin = min(UNLOCK_MAX, max(UNLOCK_MIN, 2.0 * self.lock_sin))

  #------------------------------------------------------------------------------------------ State

  def reset(self, theta_seed:float, w_seed:float=0.0):
    """
    A reset and a speed seed:
    the angle from the render accumulator, the speed from the ramp step, the flux from nothing.
    """
    self.psi_a = self.psi_b = 0.0
    self.psi_ra = self.psi_rb = 0.0
    self.theta_hat = wrap(theta_seed)
    self.w_hat = w_seed
    self.err = 0.0
    self.err_hi = 0.0
    self.err_sum, self.err_n = 0.0, 0

  @property
  def hz(self) -> float:
    """The PLL speed as an electrical frequency, signed."""
    return self.w_hat / TWO_PI

  @property
  def err_deg(self) -> float:
    """The discriminant as the angle whose sine it is, the `Foc:LockErr` scale."""
    return asin(min(1.0, abs(self.err))) * 180.0 / PI

  @property
  def psi_l1(self) -> float:
    """L1 norm of the active flux, the flux-collapse plausibility the device uses."""
    return abs(self.psi_ra) + abs(self.psi_rb)

  @property
  def weak(self) -> bool:
    return self.psi_l1 < self.psi_min

  @property
  def lead(self) -> float:
    """
    The leak lead sitting in `theta_hat`, all of which comes off:
    the flux high-pass advances the angle by `atan(fc / f)`, the slower the rotor the more.
    """
    hz = abs(self.hz)
    if hz < LEAD_MIN_Hz: return 0.0
    fc = 1.0 / (TWO_PI * self.tau)
    return atan(fc / hz) * (1.0 if self.hz >= 0 else -1.0)

  @property
  def theta(self) -> float:
    """
    The rotor angle the drive believes: the estimate less its own leak lead.
    Every consumer reads it here, as in the drive.
    """
    return wrap(self.theta_hat - self.lead)

  def angle_vs(self, theta_applied:float) -> float:
    """
    `Obs:AngleErr` before smoothing: the angle the drive believes against the applied field [°].
    """
    return wrap(self.theta - theta_applied) * 180.0 / PI

  #------------------------------------------------------------------------------------------- Step

  def step(self, h:float, v_ab:tuple, i_ab:tuple, signs:tuple):
    """One sub-step of the observer."""
    if not self.valid: return
    d_a, d_b = dead_ab(signs, self.v_dt)
    va, vb = v_ab[0] - d_a, v_ab[1] - d_b
    ia, ib = i_ab
    k = h / self.tau
    self.psi_a += (va - self.rs * ia) * h - self.psi_a * k
    self.psi_b += (vb - self.rs * ib) * h - self.psi_b * k
    self.psi_ra = self.psi_a - self.lq * ia
    self.psi_rb = self.psi_b - self.lq * ib
    c, s = cos(self.theta_hat), sin(self.theta_hat)
    err = (self.psi_rb * c - self.psi_ra * s) / self.psi_nom
    # clamped to unity, so a railed flux cannot overflow the loop
    self.err = max(-1.0, min(1.0, err))
    self.err_hi = max(self.err_hi, abs(self.err))
    self.err_sum += asin(abs(self.err))
    self.err_n += 1
    self.w_hat += self.ki * self.err * h
    self.theta_hat = wrap(self.theta_hat + self.w_hat * h + self.kp * self.err * h)

  def tick_peak(self) -> float:
    """The largest |discriminant| since the last call, for the peak meter."""
    v, self.err_hi = self.err_hi, abs(self.err)
    return v

  def tick_err(self) -> float:
    """
    The discriminant as an angle [°], averaged over the sub-steps since the last call.
    The device samples it on a 10ms tick that jitters against the rotor;
    a model on an exact 10ms grid would alias a ripple at 50Hz onto one phase,
    so it takes the mean such a sampler converges to.
    """
    if not self.err_n: return self.err_deg
    v = self.err_sum / self.err_n * 180.0 / PI
    self.err_sum, self.err_n = 0.0, 0
    return v
