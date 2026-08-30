"""
The rotor observer: what the estimator makes of the machine.

Two errors reach it, and `tuning.md` points at both. A wrong `Motor:Ke` scales
the flux the model divides by, so the SPEED comes out proportionally wrong. A
wrong `Obs:DtComp` leaves a standing voltage error in the reconstruction, so the
ANGLE comes out wrong, and by a share of the back-EMF, which is why the error
eases with speed and why a takeover is declared up at `Foc:EntryFreq` rather
than wherever the ramp happens to be.

What the gate samples is an ENVELOPE, not a level: the rotor rings around its
load angle, and how deep the troughs go decides whether a takeover can land.
"""

from math import atan2, pi as PI
from .command import Command
from .machine import DEAD_FUND, PWM_Hz, V_PEAK, Machine

#------------------------------------------------------------------------------------ Model shaping

# How hard a mis-set `Obs:DtComp` bends the estimated angle. The naive ratio of
# the voltage error to the back-EMF understates it, because the flux integrator
# leaks (`Obs:HpHz`) and turns a standing voltage error into a standing angle.
# This lands in `Obs:AngleErr` and in `Obs:Bias`; it does NOT gate the takeover.
ERR_GAIN = 1.2
# And what that standing angle costs the speed the PLL comes out with, which is
# why `Obs:Bias` reads the dead-time error at all and not only a wrong `Motor:Ke`.
BIAS_Hz_deg = 0.05
# A real estimator never reaches zero angle error.
ERR_FLOOR_deg = 1.5
# The estimate lags the shaft, and that lag is what `Foc:LockSpeed` gates.
ROTOR_TAU_s = 0.15
# Ripple on the discriminant, from the switching period: the notches dead-time
# cuts into the reconstructed voltage land on every PWM edge. This is the trough
# `foc.md` says the switch waits for, and it is there in every stage.
RIPPLE_deg = 4.0
# What a standing dead-time miss leaves IN THE RESIDUAL. The loop nulls the bias
# itself, so all that survives is the harmonic it cannot follow: sixth order at
# `1/h^2`, a fraction of a degree even at a gross miss.
HARMONIC = 0.06
# How much of the rotor's mechanical swing outruns a `Pll:Bw`-limited loop. The
# swing is a few Hz against a thirty Hz loop, so most of it is tracked out.
PLL_LAG = 0.25

# Stages where the estimator watches a vector it did not place, so the physical
# load angle stands between the two. It is REPORTED and never gated.
FORCED_VEC = ("align", "catch", "forced")

#----------------------------------------------------------------------------------------- Observer

class Observer:
  """Speed estimate, mean angle error and the swing around it."""
  def __init__(self):
    self.reset()

  def reset(self):
    self.w = 0.0      # speed estimate, what the gate compares
    self.err = 0.0    # PLL residual: what the gate discriminates on
    self.field = 0.0  # observer against the applied field: reported, not gated
    self.ring = 0.0   # the swing around the residual the gate actually samples

  @property
  def crest(self) -> float:
    """Top of the swing, what a tick has to fit inside the gate."""
    return self.err + self.ring

  @property
  def trough(self) -> float:
    """Bottom of it, where the switch is allowed to land."""
    return max(0.0, self.err - self.ring)

  def skew(self, cmd:Command, m:Machine, f:float) -> float:
    """Signed angle error the dead-time miss leaves in the reconstruction."""
    dtpu = max(0.0, cmd.deadtime_ns) * 1e-9 * PWM_Hz
    miss = (cmd.dtcomp_pct - m.dtcomp_true) / 100.0
    dv = miss * DEAD_FUND * dtpu * m.vdc / V_PEAK
    return ERR_GAIN * atan2(dv, max(m.emf(f), 1.0)) * 180.0 / PI

  def update(self, cmd:Command, dt:float, m:Machine, f:float, vec:str):
    """One pass of the estimator at the frequency the windings see.

    Two angles come out of here and they are NOT the same quantity.

    `err` is what the takeover gate reads: the discriminant the PLL forms
    against its OWN flux estimate, `|psi_r| sin(theta_flux - theta_hat)`, with
    the loop that nulls it in the next line of `obs.c`. A standing bias in the
    estimate is exactly what a loop like that removes, so neither the dead-time
    miss nor the load angle reaches it - only the harmonic it cannot follow.

    `field` is the observer against the APPLIED field, which is what carries the
    load angle and the dead-time bias. The device computes it at the moment of
    takeover and hands it to `FOC_Takeover` to rotate the references by; it
    never compares it with anything. Publishing it as `Obs:AngleErr` is the
    whole reason `foc.md` warns to judge `Obs:DtComp` by `Obs:Bias` instead of
    by zeroing this one."""
    skew = self.skew(cmd, m, f)
    scale = m.ke / cmd.ke_v_hz if cmd.ke_v_hz else 1.0
    self.w += (m.wr * scale + BIAS_Hz_deg * skew - self.w) * dt / (ROTOR_TAU_s + dt)
    tau = 1.0 / (2 * PI * max(1.0, cmd.pll_bw_hz))
    seen = abs(skew) + (abs(m.delta) * 180.0 / PI if vec in FORCED_VEC else 0.0)
    self.field += (seen - self.field) * dt / (tau + dt)
    self.err += (ERR_FLOOR_deg - self.err) * dt / (tau + dt)
    # The swing is measured, not modelled: whatever the rotor actually rang
    # through this tick, less the part a loop this fast tracks out.
    swing = 0.0 if vec == "closed" else PLL_LAG * m.swing
    self.ring = RIPPLE_deg + HARMONIC * abs(skew) + swing
