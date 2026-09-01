"""
Scenario trace of the plant, faster than real time.

`py -m ectra [vf|if|foc] [Hz] [s]` drives the factory 1500W tables
and prints a line on every stage, state, freeze or fault edge, then the final balance.
Halfway through, the load steps.
Nothing here is scripted: every edge is the integrated machine answering the command,
so a model change is verified by diffing two runs.
"""

import sys
from .command import Command
from .machine import Machine
from .plant import Plant

#----------------------------------------------------------------------------------------- Defaults

# The 1500W factory tables, as `regs.csv` ships them.
VOLT = [(2, 17.1), (5, 17.4), (10, 18), (15, 19.5), (20, 21), (25, 23), (30, 25),
  (35, 27), (40, 29), (45, 31), (50, 33), (55, 35), (60, 37), (70, 41), (80, 45),
  (90, 49), (100, 53), (120, 61), (140, 69), (170, 81), (200, 93), (250, 113),
  (300, 133), (360, 157)]
CURR = [(2, 2.42), (5, 2.42), (10, 2.18), (15, 2.06), (20, 2.06), (25, 2.06),
  (30, 2.42), (35, 2.55), (40, 2.61), (45, 2.73), (50, 2.79), (55, 2.91), (60, 2.97),
  (70, 3.03), (80, 3.09), (90, 3.15), (100, 3.21), (120, 3.27), (140, 3.39),
  (170, 3.52), (200, 3.64), (250, 3.76), (300, 3.88), (360, 4.0)]
RISE = [(5, 1.3), (10, 1.35), (20, 1.4), (30, 1.5), (40, 1.55), (50, 1.65), (60, 1.7),
  (80, 1.85), (100, 2.0), (140, 2.3), (200, 2.5), (300, 2.5)]
FALL = [(5, .55), (10, .55), (20, .6), (30, .7), (40, .75), (50, .8), (60, .85),
  (80, 1.0), (100, 1.1), (140, 1.35), (200, 1.5), (300, 1.5)]

STEP_s = 0.02
LOAD_Nm = 1.2

def command(mode:str, hz:float, ke:float) -> Command:
  """A commissioned drive: factory tables, and a nameplate that matches the iron."""
  return Command(target_hz=hz, mode=mode, poles=6, enabled=True, motor_type=1,
    rise=RISE, fall=FALL, volt=VOLT, curr=CURR,
    damp_pct=100, entry_hz=55.0, entry_timeout_s=120,
    lock_err_deg=22.0, lock_speed_pct=25, fallback_low_hz=25.0, fallback_high_hz=3.0,
    align_ms=700, init_hz=0.5, speed_min_hz=0.0, speed_max_hz=165.0,
    boot_delay_s=5.0, coast_s=90, rs_ohm=0.9, lq_h=6300e-6, ke_v_hz=ke,
    phasemap=2, shape=1, deadtime_ns=2500, dtcomp_pct=60, pll_bw_hz=30,
    iq_max_a=4.5, mod_ceil_pct=78, curr_bw_hz=300, entry_glide_ms=400,
    spd_kp=150, spd_ki=300, curr_rms_a=5.0, curr_peak_a=7.1, peak_count=12,
    temp_max_c=85.0, stall_curr_a=4.24, stall_freq_hz=15.0, ripple_max_v=3.5,
    dc_min_v=520.0, dc_max_v=780.0, derate_temp_c=80.0, derate_curr_a=3.6,
    derate_hz=92.5, regen_band_v=160, freeze_low_v=550, freeze_high_v=640,
    freeze_hyst_v=5)

#-------------------------------------------------------------------------------------------- Trace

def edge(t:float, p:Plant) -> str:
  """One line of where the drive stands, printed only when something turned."""
  m = p.machine
  return (f"{t:7.2f}s  {p.vec:>6} {p.state:>3}  ramp {p.ramp.hz:6.2f}Hz"
    f"  rotor {m.wr:6.2f}Hz  I {m.curr:5.2f}A  bus {m.vdc:4.0f}V"
    f"  {p.ramp.freeze:>4}  {p.fault or '-'}")

def main():
  mode = sys.argv[1] if len(sys.argv) > 1 else "foc"
  hz = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
  t_end = float(sys.argv[3]) if len(sys.argv) > 3 else 120.0
  machine = Machine()
  plant = Plant(machine)
  cmd = command(mode, hz, machine.ke)
  t, last = 0.0, None
  while t < t_end:
    if t >= t_end / 2.0 and not machine.load_nm:
      machine.load_nm = LOAD_Nm
      print(f"{t:7.2f}s  load stepped to {LOAD_Nm}Nm")
    plant.step(cmd, STEP_s)
    t += STEP_s
    now = (plant.vec, plant.state, plant.ramp.freeze, plant.fault)
    if now != last: print(edge(t, plant))
    last = now
  det, m = plant.det, plant.machine
  print(f"{t:7.2f}s  end  rotor {m.wr:.2f}Hz  I {m.curr:.2f}A  bus {m.vdc:.0f}V"
    f"  temp {m.temp:.0f}C  takeovers {det.takeovers}  fallbacks {det.fallbacks}"
    f"  holds {plant.ramp.holds}  fault {plant.fault or '-'}")

if __name__ == "__main__": main()
