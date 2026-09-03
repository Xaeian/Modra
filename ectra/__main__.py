"""
Scenario trace of the plant, as fast as the CPU allows.

`py -m ectra [vf|if|foc] [Hz] [s]` runs the drive at the 1500W map defaults, the
drive already enabled and past its boot delay, and prints a line on every edge:
stage, state, freeze, fault, takeover, fallback. The last line is the balance.
Nothing here is scripted: every edge is the integrated machine answering the
command, so a model change is verified by diffing two runs.
"""

import sys
from .command import Command
from .machine import Machine
from .plant import Plant

#----------------------------------------------------------------------------------------- Defaults

# The 1500W tables as `regs.csv` ships them
VOLT = [(2, 19.4), (5, 17.4), (10, 18.0), (15, 19.5), (20, 21.0), (25, 23.0), (30, 25.0),
  (35, 27.0), (40, 29.0), (45, 31.0), (50, 33.0), (55, 35.0), (60, 37.0), (70, 41.0),
  (80, 45.0), (90, 49.0), (100, 53.0), (120, 61.0), (140, 69.0), (170, 81.0), (200, 93.0),
  (250, 113.0), (300, 133.0), (360, 157.0)]
CURR = [(2, 2.42), (5, 2.26), (10, 1.667), (15, 1.12), (20, 0.948), (25, 0.763), (30, 0.778),
  (35, 0.902), (40, 1.095), (45, 1.354), (50, 1.67), (55, 2.001), (60, 2.258), (70, 2.584),
  (80, 2.789), (90, 2.997), (100, 3.136), (120, 3.136), (140, 3.136), (170, 3.136),
  (200, 3.136), (250, 3.871), (300, 4.5), (360, 4.5)]
RISE = [(5, 1.38), (10, 1.35), (20, 1.4), (30, 1.5), (40, 1.55), (50, 1.65), (60, 1.7),
  (80, 1.85), (100, 2.0), (140, 2.3), (200, 2.5), (300, 2.5)]
FALL = [(5, 1.65), (10, 1.65), (20, 1.8), (30, 2.1), (40, 2.25), (50, 2.4), (60, 2.55),
  (80, 3.0), (100, 3.3), (140, 4.05), (200, 4.5), (300, 4.5)]

STEP_s = 0.01

def command(mode:str, hz:float) -> Command:
  """The map defaults of the 1500W drive, `Motor:*` as typed, not as the iron is."""
  return Command(target_hz=hz, mode=mode, enabled=True, motor_type=1, poles=6.0,
    rise=RISE, fall=FALL, volt=VOLT, curr=CURR,
    rs_ohm=0.9, lq_h=6.3e-3, ke_v_hz=0.5808, phasemap=2, shape=1, shunt_ok=True,
    deadtime_ns=2500.0, dtcomp_pct=0.0, obs_hp_hz=1.6, pll_bw_hz=50.0, pll_damp=1.0,
    damp_pct=100.0, catch_hz=12.5, init_hz=0.8, align_ms=700.0, boot_delay_s=0.0,
    speed_min_hz=25.0, speed_max_hz=165.0, coast_s=90.0, clear_fault=False,
    entry_hz=40.0, entry_timeout_s=120.0, entry_glide_ms=400.0, retry_hold_s=3.0,
    lock_err_deg=40.0, lock_speed_pct=40.0, fallback_low_hz=20.0, fallback_high_hz=6.0,
    iq_max_a=4.5, mod_ceil_pct=78.0, curr_bw_hz=300.0, spd_kp=150.0, spd_ki=300.0,
    curr_rms_a=5.0, curr_peak_a=7.1, peak_count=12.0, temp_max_c=85.0,
    stall_curr_a=4.0, stall_freq_hz=15.0, ripple_max_v=3.5, dc_min_v=520.0, dc_max_v=780.0,
    derate_temp_c=80.0, derate_curr_a=3.6, derate_hz=92.5, regen_band_v=160.0,
    freeze_low_v=550.0, freeze_high_v=640.0, freeze_hyst_v=5.0)

#-------------------------------------------------------------------------------------------- Trace

def edge(t:float, p:Plant) -> str:
  """One line of where the drive stands, printed only when something turned."""
  m, d = p.machine, p.det
  return (f"{t:7.2f}s  {p.vec:>6} {p.state:>3}  ramp {p.ramp.hz:6.2f}Hz"
    f"  rotor {m.wr:6.2f}Hz  w_hat {p.obs.hz:6.2f}Hz  I {m.curr:5.2f}A  bus {m.vdc:4.0f}V"
    f"  {p.ramp.freeze:>4}  {p.fault or '-':6}"
    f"  takeovers {d.takeovers} fallbacks {d.fallbacks} exit {d.exit_cause}")

def main():
  mode = sys.argv[1] if len(sys.argv) > 1 else "foc"
  hz = float(sys.argv[2]) if len(sys.argv) > 2 else 40.0
  t_end = float(sys.argv[3]) if len(sys.argv) > 3 else 120.0
  plant = Plant(Machine())
  cmd = command(mode, hz)
  t, last = 0.0, None
  while t < t_end:
    plant.step(cmd, STEP_s)
    t += STEP_s
    d = plant.det
    now = (plant.vec, plant.state, plant.ramp.freeze, plant.fault,
      d.takeovers, d.fallbacks, d.exit_cause)
    if now != last: print(edge(t, plant))
    last = now
  m, d = plant.machine, plant.det
  print(f"{t:7.2f}s  end  rotor {m.wr:.2f}Hz  I {m.curr:.2f}A  bus {m.vdc:.0f}V"
    f"  temp {m.temp:.0f}C  load angle {m.load_angle * 57.3:.0f}°"
    f"  takeovers {d.takeovers}  fallbacks {d.fallbacks}  delta {d.delta * 57.3:.0f}°"
    f"  holds {plant.ramp.holds}  fault {plant.fault or '-'}")

if __name__ == "__main__": main()
