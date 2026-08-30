"""
One tick of intent, in physical units.

The leaf of the package: everything downstream reads a `Command` and none of it
knows what a register is called. `binding.py` is what fills one in.

Machine constants here are what the OPERATOR entered. The loops and the observer
believe them; the shaft does not, because it carries its own truth in
`machine.py`. That gap is what makes the nameplate worth measuring.
"""

from dataclasses import dataclass, field

#------------------------------------------------------------------------------------------ Command

@dataclass
class Command:
  """Bundled because every field is read together, every tick."""
  target_hz: float = 0.0
  enabled: bool = True                      # Ctrl:Mode != off
  mode: str = "vf"                          # vf | if | foc
  poles: float = 6.0                        # Motor:PolePairs, as entered
  motor_type: int = 1                       # Motor:Type, 1500 | 4000 | 7500W
  rise: list = field(default_factory=list)  # [(hz, Hz/s)] acceleration tempo
  fall: list = field(default_factory=list)  # [(hz, Hz/s)] deceleration tempo
  volt: list = field(default_factory=list)  # [(hz, V)] the V/f table
  curr: list = field(default_factory=list)  # [(hz, A)] forced-vector current
  catch_hz: float = 0.0                     # If:CatchFreq
  max_freq_hz: float = 0.0                  # If:MaxFreq
  damp_pct: float = 100.0                   # If:Damp
  entry_hz: float = 0.0                     # Foc:EntryFreq
  entry_timeout_s: float = 0.0              # Foc:EntryTimeout
  lock_err_deg: float = 22.0                # Foc:LockErr, 0 inhibits takeover
  lock_speed_pct: float = 25.0              # Foc:LockSpeed
  entry_glide_ms: float = 400.0             # Foc:EntryGlide
  fallback_low_hz: float = 2.0              # If:FallbackFreq
  fallback_high_hz: float = 3.0             # If:FallbackHigh
  align_ms: float = 700.0                   # Drive:AlignTime
  init_hz: float = 0.5                      # Drive:InitFreq
  speed_min_hz: float = 0.0                 # Speed:Min, also the stop cutoff
  speed_max_hz: float = 0.0                 # Speed:Max, 0 leaves it open
  boot_delay_s: float = 0.0                 # System:BootDelay
  coast_s: float = 90.0                     # Brake:Coast, quoted at 50Hz
  # Machine constants in SI, converted at the binding: nothing here knows a
  # nameplate unit or a pole count it was not handed.
  rs_ohm: float = 0.0                       # Motor:Rs, 0 sheds the vector
  lq_h: float = 0.0                         # Motor:Lq
  ke_v_hz: float = 0.0                      # phase RMS volts per electrical Hz
  phasemap: float = 0.0                     # Sense:PhaseMap
  shunt_ok: bool = True                     # Sense:ShuntRes and ShuntGain set
  shape: int = 1                            # Pwm:Shape
  deadtime_ns: float = 2500.0               # Pwm:Deadtime
  dtcomp_pct: float = 0.0                   # Obs:DtComp
  pll_bw_hz: float = 30.0                   # Pll:Bw
  id_ref_a: float = 0.0                     # Foc:IdRef
  iq_ref_a: float = 0.0                     # Foc:IqRef, open speed loop only
  iq_max_a: float = 10.0                    # Foc:IqMax
  curr_bw_hz: float = 300.0                 # Foc:CurrBw
  mod_ceil_pct: float = 78.0                # Foc:ModCeil
  spd_kp: float = 0.0                       # SpeedCtrl:Kp
  spd_ki: float = 0.0                       # SpeedCtrl:Ki
  # Thresholds and derating, 0 disabling each check on its own.
  curr_rms_a: float = 0.0                   # Thresh:CurrRms
  curr_peak_a: float = 0.0                  # Thresh:CurrPeak, an AMPLITUDE
  peak_count: float = 0.0                   # Thresh:PeakCount
  temp_max_c: float = 0.0                   # Thresh:Temp
  stall_curr_a: float = 0.0                 # Thresh:StallCurr
  stall_freq_hz: float = 0.0                # Thresh:StallFreq
  ripple_max_v: float = 0.0                 # Thresh:Ripple, a start gate
  dc_min_v: float = 0.0                     # Thresh:DcBusMin
  dc_max_v: float = 780.0                   # Thresh:DcBusMax
  derate_temp_c: float = 0.0                # Speed:DerateTemp
  derate_curr_a: float = 0.0                # Speed:DerateCurr
  derate_hz: float = 0.0                    # Speed:DerateLimit
  regen_band_v: float = 0.0                 # Brake:RegenBand
  freeze_low_v: float = 0.0                 # Freeze:VdcLow
  freeze_high_v: float = 0.0                # Freeze:VdcHigh
  freeze_hyst_v: float = 5.0                # Freeze:VdcHyst
  clear_fault: bool = False                 # Fault:Clear
