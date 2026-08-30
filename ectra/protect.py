"""
The protection layers, in the order `protect.md` stacks them.

Each layer backs up the ones above it, and each runs on its own 10ms time base
rather than on the ramp's cadence, so the trip delay is the same clock time at
any output frequency.

Reports, never acts: `check` returns a fault code and the caller decides what a
fault does to the bridge.
"""

from .command import Command
from .detector import DET_s
from .machine import Machine

#----------------------------------------------------------------------------------------- Debounce

# `PROTECT_TRIP_N` on the 10ms tick: an overload has to HOLD for a second. The
# boost at the bottom of a voltage table is real current and the ramp passes
# through it on every start, so an instant trip would refuse to run.
TRIP_s = 1.0
STALL_s = 1.5
# The under-fluxed stall slips beneath the current envelope: the field climbs
# and the current vector does not rotate. `PROTECT_EST_RENDER_HZ` is the field
# floor, `PROTECT_EST_STAND_HZ` what still counts as a standing shaft.
EST_RENDER_Hz = 10.0
EST_STAND_Hz = 3.0
# `spin` is not a band. `PROTECT_SPIN_REF_HZ` is where the loss baseline is
# LATCHED, on the one crossing a start makes; `PROTECT_SPIN_ARM_HZ` is the floor
# the check then runs ABOVE, for as long as the drive stays there. Reading the
# two as a window would arm the guard exactly where the device disarms it.
SPIN_REF_Hz = 15.0
SPIN_ARM_Hz = 40.0
# A re-entry above this has no baseline to latch, so the guard stands down for
# that episode: post-fallback health belongs to the lock machinery.
SPIN_LATCH_Hz = SPIN_REF_Hz + 10.0
SPIN_s = 1.5 # `PROTECT_SPIN_N` 150 on the 10ms tick
# The increment the bench measured per product variant, over the latched loss.
SPIN_STEP_W = {1: 60.0, 2: 160.0, 3: 300.0}

#------------------------------------------------------------------------------------------ Protect

class Protect:
  """Debounced thresholds, the stall and spin witnesses, and the hardware line."""
  def __init__(self):
    self.reset()

  def reset(self):
    self.peaks = 0 # `Fault:PeakEvents`, boot-sticky like the device's
    self.clear()

  def clear(self):
    """`PROTECT_Reset`: the debounce counters and the spin baseline die with
    the run. A cause that persists into the next run earns a FULL debounce
    again; a carried counter would re-trip on the first over-threshold tick,
    eating the clear that was meant to give the drive another try."""
    self._over_s = {} # how long each threshold has been exceeded
    self._spin_latched = False
    self._spin_armed = False
    self._spin_ref_w = 0.0

  def _hold(self, key:str, over:bool, dt:float, limit:float) -> bool:
    """A threshold has to HOLD before it trips."""
    self._over_s[key] = self._over_s.get(key, 0.0) + dt if over else 0.0
    return self._over_s[key] >= limit

  def check(self, cmd:Command, dt:float, ctrl, m:Machine, hz:float,
    target:float, table:bool, forced:bool, estim_hz:float=0.0) -> str|None:
    """One pass over every layer, reading the FAST tier and never the machine
    behind it: a threshold that saw the unfiltered value would answer the rotor
    swing instead of the operating point. The hardware line goes first, because
    it pre-empts even the PWM interrupt on the device."""
    if self._comparator(cmd, dt, m): return "peak"
    if self._hold("irms", bool(cmd.curr_rms_a) and ctrl.curr > cmd.curr_rms_a,
      dt, TRIP_s): return "irms"
    if self._hold("imax", bool(cmd.curr_peak_a) and ctrl.peak / 2.0 > cmd.curr_peak_a,
      dt, TRIP_s): return "imax"
    if self._hold("temp", bool(cmd.temp_max_c) and ctrl.temp > cmd.temp_max_c,
      dt, TRIP_s): return "temp"
    if self._hold("hv-", bool(cmd.dc_min_v) and ctrl.vdc < cmd.dc_min_v,
      dt, TRIP_s): return "hv-"
    if self._stall(cmd, dt, ctrl, hz, target, table, estim_hz): return "stall"
    if self._spin(cmd, dt, ctrl, hz, forced): return "spin"
    return None

  def _comparator(self, cmd:Command, dt:float, m:Machine) -> bool:
    """The board's own line, independent of the whole measurement chain and of
    every register: it guards the transistors, so it sits far above any setting
    an operator can reach. Its counter drains one detector tick per quiet tick,
    so single spikes fade between attempts and only bursts denser than the drain
    ever add up."""
    over = m.peak / 2.0 > m.peak_trip
    ticks = max(1, int(dt / DET_s))
    self.peaks = min(0xFFFF, self.peaks + ticks) if over else max(0, self.peaks - ticks)
    return bool(cmd.peak_count) and self.peaks >= cmd.peak_count

  def _stall(self, cmd:Command, dt:float, ctrl, hz:float, target:float,
    table:bool, estim_hz:float) -> bool:
    """A rotor that never left standstill, and only where a table drives the
    bridge: under the loops the current says the same thing turning or held, so
    there `spin` and `sync` are the witnesses. Only while ACCELERATING, because
    high current on a held or falling ramp is braking into inertia, regeneration
    or a frozen bus, and none of those is a standing rotor.

    Two branches, as `protect.c` has them. The current branch catches the rotor
    the boost is cooking; the estimate branch catches the under-fluxed stall
    that slips BENEATH the current envelope - the field past its floor while
    the current vector never turns, whatever the amps say."""
    rising = table and cmd.stall_freq_hz and hz < target
    armed = rising and cmd.stall_curr_a and hz < cmd.stall_freq_hz
    if self._hold("stall", bool(armed) and ctrl.curr > cmd.stall_curr_a, dt, STALL_s):
      return True
    est = rising and hz >= EST_RENDER_Hz and estim_hz < EST_STAND_Hz
    return self._hold("stall_est", bool(est), dt, STALL_s)

  def _spin(self, cmd:Command, dt:float, ctrl, hz:float, forced:bool) -> bool:
    """The shaft is not following the forced field.

    `stall` is blind here by construction, because a regulated current reads the
    same with the rotor turning or standing, and the observer seeds from the
    very ramp it would have to judge. Shaft power is the one witness left: a fan
    that is not turning takes losses only, and losses are flat over frequency.

    So the baseline is LATCHED on the single crossing of the reference band that
    a start makes, and the level is then compared for as long as the drive runs
    above the arm floor. No rising ramp anywhere: a decoupled rotor at a steady
    setpoint is exactly the case this exists for, and `protect.md` saying
    otherwise is the doc drifting from `protect.c`."""
    if not forced or hz < SPIN_REF_Hz:
      self._over_s["spin"] = 0.0
      self._spin_latched = False
      return False
    if not self._spin_latched:
      self._spin_latched = True
      self._spin_armed = hz < SPIN_LATCH_Hz
      self._spin_ref_w = ctrl.power
    if not self._spin_armed or hz < SPIN_ARM_Hz:
      self._over_s["spin"] = 0.0
      return False
    step = SPIN_STEP_W.get(int(cmd.motor_type), SPIN_STEP_W[1])
    return self._hold("spin", ctrl.power < self._spin_ref_w + step, dt, SPIN_s)
