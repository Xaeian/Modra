# bench/ectra/machine.py

"""
The machine, the bridge that feeds it and the shaft it turns.

Knows nothing of stages, ramps or takeover gates:
hand it a control frame and a current reference, or a voltage off the table,
and it answers with what the iron does over one sub-step.

Everything is integrated, nothing settles algebraically:
the winding on an exact rotation, the shaft on its load curve, the rotor angle as a real angle.
The control loops run in the frame the caller names,
so a frame that is not the rotor (a forced ramp, an observer with an error)
lands the current where that frame puts it,
and the torque follows from the geometry, never from an assumption.

The constants are the machine's own TRUTH, separate from the `Motor:*` an operator typed in.
A nameplate entered wrong bends the observer and the loops; it does not bend the iron.

Example:
  >>> m = Machine()
  >>> round(m.emf(50.0), 1)
  21.0
"""

from random import Random
from math import atan2, cos, exp, pi as PI, sin, sqrt
from .command import Command
from .curve import clamp, interp

#-------------------------------------------------------------------------------- The 1500W machine

# The bench's 1.5kW motor on its 400 rotor, 10-12.11 on 0.13.4, the release that reads
# the vector's volts exactly. `py check_model.py` puts every number below against those runs.
# The winding's resistance carries the bridge's resistive drop with it:
# the align current rose 0.9A per volt of `Volt:0Hz` (4.55A at 17.5V, 6.25A at 19.4V),
# which is √2/1.58Ω, where the end-of-line 0.898Ω alone would give 1.6A.
# Lq from the assembled motor; the stator alone reads 2.5× less.
RS_ohm = 1.58
LQ_H = 0.0154
# Phase RMS volts per ELECTRICAL Hz, the unit the whole package works in.
# The observer's flux read 0.41-0.43 over 70-195Hz, and so did the loops' volts in closed
# with id near zero: 54.5V at 100Hz on 1.0A, 126V at 198Hz on 3.87A.
# The 103.8V/krpm the map enters is √2 above it, a peak taken for RMS;
# the motor of the 315 installation sits near the map, this one does not
KE_V_Hz = 0.42
POLES = 6
# What the bridge keeps for itself along each phase current:
# the dead time `td/T × Vdc` the register `Pwm:Deadtime` describes,
# plus the forward drop of the conducting leg.
# Its size comes from the V/f climb to the catch, where the drive's three-phase mean read 4.03A
# at 1Hz and 2.09A at 9Hz on the map's 19.4V: 10V meets it within 8%.
# The align's DC then reads 5.4A where the drive read 6.25A: the drive loses more once the field
# turns than a square wave along each phase does, and the climb is what `stall` reads.
# The loss is whole from a tenth of an amp:
# in closed at 30Hz the loops held 0.16A on 22.3V, the back-EMF 12.6V and the loss the rest,
# and a loss fading under 0.8A, as this model had it from 0.12 readings of the vector's volts,
# left its observer 8V of compensation the bridge did not take: the loop slipped at 50Hz.
# The observer still subtracts a full square wave when `Obs:DtComp` says so
LOSS_V = 10.0
LOSS_A0, LOSS_A1 = 0.0, 0.1 # phase current, RMS scale: absent under A0, whole above A1

# The shaft: the 400 rotor as the speed loop measures it.
# In closed the loop holds the torque current, so every held step reads the load as `kt × iq`:
# `Foc:IqCmd` 0.157A at 30Hz, 1.005A at 100Hz, 3.87A at 198Hz, and the recorder's iq agrees.
# `0.074Nm + 1.07e-4 × w²` meets 30-198Hz within 6%, and carries on to the window's top,
# far past the current the drive has: the station stops on the derating near 198Hz.
#   mechanical rad/s → Nm
LOAD_CURVE = [(0.0, 0.074), (31.4, 0.189), (47.1, 0.320), (62.8, 0.495), (83.8, 0.806),
  (104.7, 1.209), (125.7, 1.717), (146.6, 2.325), (167.6, 3.019), (188.5, 3.824), (207.3, 4.657),
  (261.8, 7.38), (314.2, 10.60), (387.5, 16.09)]
# The same loop on its ramps weighs the rotor: `J α = kt Δiq` over the steady current,
# 0.126 climbing and 0.111 stopping, in thousands of samples of 10-12.11
INERTIA_kgm2 = 0.12

#-------------------------------------------------------------------------------------- Integration

# The sub-step everything runs on: under the winding's `L/R` of about 7ms, under the rotor swing,
# and fine enough at 90Hz to see each sign change of the phase currents:
# six per electrical turn, the dead-time pattern.
SUB_s = 0.5e-3
SUB_MAX = 2000
# `If:Damp`, as the drive implements it:
# not a torque, a lean of the CONTROL frame against the swing velocity of the rotor.
# The drive reads that swing off the q voltage the loops apply,
# through a 51ms high-pass, a 6.4ms low-pass and a difference every 6.4ms;
# `damp_pct × 1.2` angle units per count, clamped to 8°.
# The rotor angle itself is not available to it, so not used here
DAMP_HP_s = 0.0512
DAMP_LP_s = 0.0064
DAMP_VEL_s = 0.0064
DAMP_VEL_MAX = 4096.0
DAMP_V_PER_COUNT = 580.0 / 3200.0 / 1.4142136 # one vq count at the reference bus, RMS scale
DAMP_RAD_PER_COUNT = 120.0 * 2.0 * PI / 65536.0 # at 100%, per count of velocity
DAMP_MAX_rad = 8.0 * PI / 180.0
# The drive leans the frame by `-vel × k`, and the q axis means the same thing in both frames
# (90° ahead of the current in the direction of rotation), so the sign carries over;
# the other sign excites a limit cycle here
DAMP_SIGN = -1.0
# Current measurement noise the loops and the observer see,
# per alpha/beta sample [A RMS scale, 1σ].
# The bridge's own ADC chain is not silent:
# through `If:Damp`'s difference it becomes a jitter of the applied angle,
# which is why more damping reads as a larger `Sync:ErrPeak` on the bench
NOISE_A = 0.0

#---------------------------------------------------------------------------------- Bridge and link

# Carrier the bridge switches at,
# and the shape factors the `Volt` table is read through:
# SVPWM reaches a given phase voltage at less modulation than a sine.
PWM_Hz = 10000.0
SHAPE_K = (1.0, 0.8660254, 0.873) # sine | svpwm | trapezoid
# The vector core renders min-max SVPWM whatever `Pwm:Shape` says, its ceiling counts half the bus,
# and the bus holds a sine up to the circle inscribed in the bridge hexagon: 2/√3 of that half.
SVPWM_LINEAR = 1.1547005
# Two legs tie at the hexagon vertex with the shortest low-side windows,
# so the vector stays out of the short-pulse band there:
# `2 × Pwm:Deadtime + Pwm:MinPulse` plus a margin, against a quarter of the carrier.
TIMER_Hz = 64e6
CLAMP_MARGIN_s = 16 / TIMER_Hz
# Dead-time steals `td/T` of the bus from every phase along the sign of ITS OWN current:
# a square wave in phase with the current, nothing sinusoidal about it.
# That is what puts six steps per electrical turn into everything downstream.
# The bridge gives nothing back: the drive compensates only in the observer's reconstruction,
# which never reaches a CCR.

# Diode front end: the link charges from the mains only below the rectified level,
# so regenerated energy has nowhere to go and pumps the bus.
BUS_VRECT_V = 590.0
BUS_C_F = 470e-6
BUS_RSRC_ohm = 10.0
LINK_DRAIN_W = 10.0
# The pump guard arms this far under the ceiling outside a closed loop.
BUS_MARGIN_V = 30.0

V_PEAK = 1.4142136 # RMS phase volts to vector peak
TWO_PI = 2.0 * PI

#------------------------------------------------------------------------------------------ Sensors

AMBIENT_C = 25.0
# `MeasCtrl:Temp` sits on the power stage, so it reads the bridge's loss, not the winding's:
# on the station it rose with the current, not its square, 52°C at 3.8A on the 1.5kW board
# after 45min at 196Hz. With the winding's copper counted it read 80°C in 23min
TEMP_RTH_CW = 1.0
TEMP_TAU_s = 300.0
SWITCH_LOSS_W = 12.0
RIPPLE_BASE_V = 1.5
RIPPLE_PER_A = 0.4
VCE_V = 1.5
FLYBACK_V = 17.0
PEAK_FACTOR = 2.828 # sine phase RMS to peak-to-peak
PEAK_TRIP_A = 40.0

#------------------------------------------------------------------------------------------ Helpers

def wrap(a:float) -> float:
  """An angle into (-π, π]."""
  return (a + PI) % TWO_PI - PI

def rotate(x:float, y:float, a:float) -> tuple:
  """Components of a vector in a frame turned by `a` from the one they are given in."""
  c, s = cos(a), sin(a)
  return x * c + y * s, -x * s + y * c

def phase_signs(i_a:float, i_b:float) -> tuple:
  """Signs of the three phase currents from the alpha-beta pair."""
  iu = i_a
  iv = -0.5 * i_a + 0.8660254 * i_b
  iw = -0.5 * i_a - 0.8660254 * i_b
  sg = lambda x: 1.0 if x > 0.0 else (-1.0 if x < 0.0 else 0.0)
  return sg(iu), sg(iv), sg(iw)

def dead_ab(signs:tuple, v_dt:float) -> tuple:
  """
  Clarke of the sign vector scaled by the per-phase dead-time volts:
  what the bridge takes away, in alpha-beta. The same arithmetic the drive's observer runs.
  """
  su, sv, sw = signs
  return (2.0 * su - sv - sw) / 3.0 * v_dt, (sv - sw) / 1.7320508 * v_dt

#-------------------------------------------------------------------------------- The 4000W machine

# The 4kW motor on its fan, unit 99 on 12.11, 0.13.4.
# Card: Rs 0.320Ω, Lq 6.60mH, Ke 144.0V/krpm line-to-line RMS, 0.83 per electrical Hz,
# and the loops' volts in closed agree within 3V over 50-190Hz.
# The winding's resistance carries the bridge's resistive drop with it, as in the 1.5kW.
# Resistance and loss come from the starts of 12.11 on the station's own table (17.4V at 0Hz),
# three readings this pair meets together:
# the align's DC, 12.56A, 15.2A and 18.07A at 15.7V, 16.5V and 17.4V in 25 of 30 starts,
# within 5%, the V/f climb to the catch within 6% and 12% at 1Hz, and the angle the observer
# reads in I/f, -13° at 6-13Hz, which only a loss the observer leaves uncompensated gives,
# falling as 1/f.
# The 0.62Ω and 7.65V before them fit three align readings of one trial,
# and left the I/f angle 10° nearer the field than the station's: a start judged at the field
RS_4000W_ohm = 0.44
LQ_4000W_H = 0.0066
KE_4000W_V_Hz = 0.83
LOSS_4000W_V = 9.0
# Under the PWM ripple, ±1.1A on this winding, the dead time loses only part of itself:
# in closed the loss read 5V at 0.45A, 8V at 0.8A and 10V from 2A, the loops' volts less the EMF.
# Fading under 0.8A puts the closed route within 2.4V from 50Hz up, where a whole loss read 6V high
LOSS_4000W_A1 = 0.8
# The rotor weighed on the climbs of the closed loop between held steps, `J α = kt Δiq`,
# the drag between the two holds on the fan's square law: 0.255kgm² in the median of 242 climbs,
# quartiles 0.249-0.263; the same reading over the model's own rotor comes 4% high.
# On the line between the holds the drag reads high halfway along and the inertia low:
# that gave 0.18 off the first climb alone
INERTIA_4000W_kgm2 = 0.25
# The fan from `Foc:IqCmd` held in closed: 0.55A at 70Hz, 1.56A at 130Hz, 3.17A at 190Hz,
# 6.15A at 270Hz under weakening, `0.34Nm + 1.82e-4 × w²` within 3% to 190Hz.
# Under 70Hz the fan does not fall with the square: 0.45A at 45Hz and 50Hz, 0.50A at 55Hz,
# 1.06-1.20Nm where the square gives 0.77-0.96Nm
#   mechanical rad/s → Nm
LOAD_4000W = [(0.0, 0.34), (25.0, 0.45), (47.1, 1.075), (52.4, 1.06), (57.6, 1.20), (73.3, 1.31),
  (94.2, 1.95), (115.2, 2.76), (136.1, 3.71), (157.1, 4.80), (178.0, 6.11), (199.0, 7.54),
  (219.9, 9.18), (240.9, 11.0), (261.8, 12.8), (282.7, 15.0), (314.2, 18.5)]
# Its comparator, an amplitude, from the board: 3.22V against 1.65V + 12.195 × 5mΩ × i.
# The `peak` trips at 0.8Hz on catch starts came with 17-25A on the d axis, past the standstill 18A
PEAK_TRIP_4000W_A = 25.8
# Its link: tens of µF, what the stream read on the 1.5kW board.
# A rotor swinging past the field gives back a few joules, and that is 100V and more here,
# the 50-130V the bus jumped by between two samples before every `hv+` at 10-22Hz
BUS_C_4000W_F = 60e-6

# Its stage on its heatsink: 40°C at 4A and 47°C at 6.5A held in closed, from 20°C
RTH_4000W_CW = 0.6

# Every machine the simulator knows, by `Motor:Type`: the 1500W one is the constants up top
IRON = {
  "1500W": {},
  "4000W": {"rs": RS_4000W_ohm, "lq": LQ_4000W_H, "ke": KE_4000W_V_Hz,
    "inertia": INERTIA_4000W_kgm2, "load": LOAD_4000W, "loss": LOSS_4000W_V,
    "loss_a1": LOSS_4000W_A1, "peak_trip": PEAK_TRIP_4000W_A, "bus_c": BUS_C_4000W_F,
    "rth": RTH_4000W_CW},
}

#------------------------------------------------------------------------------------------ Machine

class Machine:
  """Iron, shaft and link. Integrated, not solved."""
  def __init__(
    self, rs:float = RS_ohm, lq:float = LQ_H, ke:float = KE_V_Hz, poles:int = POLES,
    peak_trip:float = PEAK_TRIP_A, inertia:float = INERTIA_kgm2, load:list|None = None,
    loss:float = LOSS_V, loss_a1:float = LOSS_A1, bus_c:float = BUS_C_F, rth:float = TEMP_RTH_CW,
  ):
    self.rs = rs
    self.lq = lq
    self.ke = ke
    self.poles = poles
    self.peak_trip = peak_trip
    self.inertia = inertia
    self.load = list(load or LOAD_CURVE)
    self.loss = loss
    self.loss_a1 = loss_a1
    self.bus_c = bus_c
    self.rth = rth
    self.reset()

  def reset(self):
    """Power-on: shaft stopped, link charged, stage cold."""
    self.clear()
    self.wm = 0.0       # MECHANICAL speed [rad/s]
    self.theta_r = 0.0  # rotor flux angle, electrical [rad]
    self.vdc = BUS_VRECT_V
    self.temp = AMBIENT_C

  def clear(self):
    """Bridge off. Currents and the loops go; the SHAFT is not touched."""
    self.id = 0.0    # rotor-frame currents, phase RMS
    self.iq = 0.0
    self.ic = None   # alpha-beta current the loops carry, `None` once no loop holds it
    self.vd_c = 0.0  # last controller output, control frame [V RMS]
    self.vq_c = 0.0
    # What the CCRs carried this sub-step and what the shunts saw, alpha-beta [V RMS, A RMS]
    self.v_ab = (0.0, 0.0)
    self.i_ab = (0.0, 0.0)
    self.signs = (0.0, 0.0, 0.0)
    self.volt = 0.0
    self.mod_index = 0.0
    self.sat = False
    self.damp_ema = self.damp_lp = self.damp_hp = self.damp_vel = 0.0
    self.damp_t = 0.0
    # Seeded: a run is repeatable to the sample
    self.rng = Random(1)
    self.lean = 0.0  # `If:Damp`'s current frame tilt [rad]
    self.curr_hi = 0.0

  #--------------------------------------------------------------------------------------- Readings

  @property
  def wr(self) -> float:
    """Rotor speed as an ELECTRICAL frequency [Hz]."""
    return self.wm * self.poles / TWO_PI

  @property
  def we(self) -> float:
    """Rotor speed, electrical [rad/s]."""
    return self.wm * self.poles

  @property
  def curr(self) -> float:
    """Phase current RMS, exactly what a meter on the wire reads."""
    return sqrt(self.id ** 2 + self.iq ** 2)

  @property
  def peak(self) -> float:
    return max(self.curr, self.curr_hi) * PEAK_FACTOR

  @property
  def power(self) -> float:
    """Apparent power, the drive's VA proxy: no cos phi in it."""
    return 3.0 * self.volt * self.curr

  @property
  def ripple(self) -> float:
    return RIPPLE_BASE_V + RIPPLE_PER_A * self.curr

  @property
  def load_angle(self) -> float:
    """Current vector ahead of the rotor flux [rad], the geometry that makes torque."""
    return atan2(self.iq, self.id) if (self.id or self.iq) else 0.0

  #--------------------------------------------------------------------------------------- Geometry

  def react(self, f:float) -> float:
    return TWO_PI * abs(f) * self.lq

  def emf(self, f:float) -> float:
    """Back-EMF at this electrical frequency, phase RMS."""
    return self.ke * abs(f)

  def kt(self) -> float:
    """Shaft torque per amp of q current, phase RMS: `3 E I = T w`."""
    return 3.0 * self.poles * self.ke / TWO_PI

  def tload(self, wm:float) -> float:
    """What the load asks of the shaft at this mechanical speed."""
    return interp(self.load, abs(wm)) or 0.0

  def vdq(self, f:float) -> tuple:
    """The rotor-frame voltage that holds the current it is holding."""
    x = self.react(f)
    return self.rs * self.id - x * self.iq, self.rs * self.iq + x * self.id + self.emf(f)

  def dead_v(self, cmd:Command, share:float) -> float:
    """Per-phase dead-time volts, phase RMS scale: `td/T × Vdc` times a share."""
    dtpu = max(0.0, cmd.deadtime_ns) * 1e-9 * PWM_Hz
    return share / 100.0 * dtpu * self.vdc / V_PEAK

  def loss_ab(self, i_a:float, i_b:float) -> tuple:
    """
    What the bridge takes off the commanded vector, alpha-beta:
    dead time and forward drop along each phase current, absent under `LOSS_A0`,
    whole past the machine's `loss_a1`, a square wave of the phase current's sign in between them.
    """
    v = self.loss
    iu = i_a
    iv = -0.5 * i_a + 0.8660254 * i_b
    iw = -0.5 * i_a - 0.8660254 * i_b
    def share(x):
      k = clamp((abs(x) - LOSS_A0) / (self.loss_a1 - LOSS_A0), 0.0, 1.0)
      return k if x > 0.0 else -k
    su, sv, sw = share(iu), share(iv), share(iw)
    return (2.0 * su - sv - sw) / 3.0 * v, (sv - sw) / 1.7320508 * v

  def table_volts(self, cmd:Command, hz:float) -> float:
    """
    What the bridge is asked to render off the `Volt` table;
    the loss comes off inside the sub-step, along the current.
    """
    return max(0.0, interp(cmd.volt, hz) or 0.0)

  def modulate(self, cmd:Command, f:float, ceiling:float, vector:bool) -> bool:
    """
    The applied vector against what the bus can render.
    The vector core speaks half the bus; the table reads through `Pwm:Shape`.
    """
    shape = 1.0 if vector else SHAPE_K[int(clamp(cmd.shape, 0, len(SHAPE_K) - 1))]
    per_volt = V_PEAK * shape * 2.0 / max(1.0, self.vdc) * 100.0
    mod = 0.0 if f <= 0.0 else self.volt * per_volt
    self.mod_index = min(ceiling, mod)
    if mod > ceiling: self.volt = self.mod_index / per_volt
    return mod >= ceiling

  def ceiling(self, cmd:Command) -> float:
    """
    The vector's reach as a share of half the bus:
    `Foc:ModCeil`, the SVPWM linear limit and, with the short-pulse clamp on,
    the band the hexagon vertex has to stay out of.
    """
    ceil = min(cmd.mod_ceil_pct / 100.0, SVPWM_LINEAR)
    if cmd.min_pulse:
      band = 2.0 * max(0.0, cmd.deadtime_ns) * 1e-9 + cmd.min_pulse / TIMER_Hz + CLAMP_MARGIN_s
      ceil = min(ceil, max(0.0, (1.0 - band * 4.0 * PWM_Hz) * 4.0 / 3.0))
    return ceil

  def vmax(self, cmd:Command) -> float:
    """Phase RMS volts the loops may ask for under the vector ceiling."""
    return self.ceiling(cmd) * self.vdc / 2.0 / V_PEAK

  def forced_mag(self, cmd:Command, hz:float) -> float:
    """The forced vector's magnitude off the `Curr` table, under `Foc:IqMax`."""
    return min(interp(cmd.curr, hz) or 0.0, cmd.iq_max_a)

  #------------------------------------------------------------------------------------ Integration

  def step_vector(
    self, cmd:Command, h:float, theta_ctrl:float, ref:tuple, forced:bool, w_frame:float=0.0,
  ) -> tuple:
    """
    One sub-step under the current loops.

    `theta_ctrl` is the frame the loops render into, `ref` the (id, iq) reference in that frame,
    `w_frame` its smooth turn [rad/s]: the ramp under the forced vector, the PLL speed in closed.
    The loops are the pole-zero cancelled pair the drive builds,
    so their closed loop is a first-order chase of the reference at `Foc:CurrBw`,
    in the control frame; the rotor is wherever it is,
    and the frame error decides where that current lands on it.
    The voltage is then what the winding needed to get there,
    plus what the bridge keeps for itself:
    that commanded vector is what the CCRs carry and what the observer reconstructs from.
    Above the voltage circle the loops saturate,
    and the winding integrates the clamped vector instead.
    Returns the commanded alpha-beta voltage,
    and the alpha-beta sample the loops and the observer share, taken before the step.
    """
    if not forced: self.lean = 0.0
    theta_c = theta_ctrl + self.lean
    phi = wrap(theta_c - self.theta_r)
    g = 1.0 - exp(-h * TWO_PI * max(1.0, cmd.curr_bw_hz))
    # The integrators hold the loops' vector turning with the frame's smooth turn,
    # so from one sub-step to the next the current goes there, not where the rotor goes,
    # and the rest of the frame's motion, the lean and the PLL's correction, is chased.
    # Carried with the rotor, a rotor swinging ahead drags its own current ahead,
    # torque along the swing: an undamping that grew the 4kW I/f swing held at 15Hz
    # from ±60° to ±90° in 45s, `If:Damp` or not, where the station rides it out.
    # Carried with the whole frame, the current follows every ripple of the PLL's angle
    # and the 1.5kW loop slipped at 40Hz on `Pll:Bw` 15, where the station holds.
    # A clipped vector holds nothing, so after one the winding's own current stands
    if self.ic is None: id_c, iq_c = rotate(self.id, self.iq, phi)
    else: id_c, iq_c = rotate(*rotate(*self.ic, -w_frame * h), theta_c)
    # One ADC sample per sub-step, taken before the bridge acts,
    # the same one for the loops and the observer.
    # The loops chase the reference from where the sample says the current is,
    # so its noise walks into the voltage and, through `If:Damp`, into the angle.
    # The observer integrates it against the voltage of this step, as `step_table` does
    s_a, s_b = rotate(id_c, iq_c, -theta_c)
    if NOISE_A: s_a, s_b = s_a + self.rng.gauss(0.0, NOISE_A), s_b + self.rng.gauss(0.0, NOISE_A)
    id_m, iq_m = rotate(s_a, s_b, theta_c)
    ic = (id_c + (ref[0] - id_m) * g, iq_c + (ref[1] - iq_m) * g)
    id_r, iq_r = rotate(ic[0], ic[1], -phi)
    we = self.we
    vd = self.rs * id_r + self.lq * (id_r - self.id) / h - we * self.lq * iq_r
    vq = (self.rs * iq_r + self.lq * (iq_r - self.iq) / h + we * self.lq * id_r
      + self.emf(self.wr))
    i_a, i_b = rotate(id_r, iq_r, -self.theta_r)
    # The bridge loses along the current it conducts;
    # the observer's dead-time compensation follows the signs of the sample it holds
    d_a, d_b = self.loss_ab(i_a, i_b)
    self.signs = phase_signs(s_a, s_b)
    v_a, v_b = rotate(vd, vq, -self.theta_r)
    c_a, c_b = v_a + d_a, v_b + d_b
    vmax = self.vmax(cmd)
    mag = sqrt(c_a ** 2 + c_b ** 2)
    self.sat = mag > vmax
    if self.sat:
      k = vmax / mag
      c_a, c_b = c_a * k, c_b * k
      vd_r, vq_r = rotate(c_a - d_a, c_b - d_b, self.theta_r)
      self.id, self.iq = rotate(id_c, iq_c, -phi)
      self._winding(h, vd_r, vq_r)
      self.ic = None
    else:
      self.id, self.iq = id_r, iq_r
      self.ic = rotate(ic[0], ic[1], -theta_c)
      self.curr_hi = max(self.curr_hi, self.curr)
    self.vd_c, self.vq_c = rotate(c_a, c_b, theta_c)
    self.v_ab, self.i_ab = (c_a, c_b), (s_a, s_b)
    self._shaft(h)
    if forced: self._damp(cmd, h)
    return self.v_ab, self.i_ab

  def step_table(self, cmd:Command, h:float, theta_field:float, volts:float) -> tuple:
    """One sub-step under the `Volt` table: voltage imposed at the field angle."""
    self.lean = 0.0
    self.ic = None
    v_a, v_b = volts * cos(theta_field), volts * sin(theta_field)
    i_a, i_b = rotate(self.id, self.iq, -self.theta_r)
    self.signs = phase_signs(i_a, i_b)
    d_a, d_b = self.loss_ab(i_a, i_b)
    self.v_ab, self.i_ab = (v_a, v_b), (i_a, i_b)
    vd_r, vq_r = rotate(v_a - d_a, v_b - d_b, self.theta_r)
    self._winding(h, vd_r, vq_r)
    self._shaft(h)
    return self.v_ab, self.i_ab

  def _winding(self, h:float, vd:float, vq:float):
    """
    Stator equation in the rotor frame, solved exactly over the sub-step:
    the cross terms are a rotation at the electrical speed,
    and no explicit scheme carries a rotation without gaining or losing amplitude.
    """
    a = self.rs / self.lq
    we = self.we
    vq -= self.emf(self.wr)
    den = a * a + we * we
    sd = (a * vd / self.lq + we * vq / self.lq) / den
    sq = (a * vq / self.lq - we * vd / self.lq) / den
    ed, eq = self.id - sd, self.iq - sq
    decay, c, sn = exp(-a * h), cos(we * h), sin(we * h)
    self.id = sd + decay * (c * ed + sn * eq)
    self.iq = sq + decay * (c * eq - sn * ed)
    self.curr_hi = max(self.curr_hi, self.curr)

  def _shaft(self, h:float):
    """Torque from the q current, the eddy drag, the load; then the angle."""
    torque = self.kt() * self.iq
    self.wm = max(0.0, self.wm + h * (torque - self.tload(self.wm)) / self.inertia)
    self.theta_r = wrap(self.theta_r + h * self.we)

  def _damp(self, cmd:Command, h:float):
    """
    `If:Damp` as the drive runs it: the pendulum modulates the q voltage the loops apply;
    high-passed, band-limited and differenced it is the swing velocity,
    and the frame leans against it.
    """
    vq = self.vq_c / DAMP_V_PER_COUNT
    self.damp_ema += (vq - self.damp_ema) * h / DAMP_HP_s
    hp = vq - self.damp_ema
    self.damp_lp += (hp - self.damp_lp) * h / DAMP_LP_s
    self.damp_t += h
    if self.damp_t >= DAMP_VEL_s:
      self.damp_t = 0.0
      self.damp_vel = clamp(self.damp_lp - self.damp_hp, -DAMP_VEL_MAX, DAMP_VEL_MAX)
      self.damp_hp = self.damp_lp
    k = DAMP_RAD_PER_COUNT * max(0.0, cmd.damp_pct) / 100.0
    self.lean = clamp(DAMP_SIGN * self.damp_vel * k, -DAMP_MAX_rad, DAMP_MAX_rad)

  def coast(self, dt:float):
    """Bridge off: the shaft carries on against its own load alone."""
    self.id = self.iq = 0.0
    self.ic = None
    self.curr_hi = 0.0
    if dt <= 0.0: return
    n = min(SUB_MAX, max(1, int(round(dt / SUB_s))))
    h = dt / n
    for _ in range(n):
      self.wm = max(0.0, self.wm - h * self.tload(self.wm) / self.inertia)
      self.theta_r = wrap(self.theta_r + h * self.we)

  def finish_tick(self, cmd:Command, field_hz:float, table:bool, gain:float):
    """What one outer tick leaves for the meters, `gain` the share of the table's field."""
    self.volt = self.table_volts(cmd, field_hz) * gain if table \
      else sqrt(self.vd_c ** 2 + self.vq_c ** 2)
    self.curr_hi = self.curr

  #-------------------------------------------------------------------------------- Link and senses

  def bridge_loss(self, running:bool) -> float:
    return 3.0 * VCE_V * self.curr + SWITCH_LOSS_W if running else 0.0

  def bus(self, cmd:Command, dt:float, f:float, closed:bool, running:bool) -> bool:
    """The DC link behind a diode bridge. Returns whether the pump guard tripped."""
    if dt <= 0.0: return False
    vd, vq = self.vdq(f)
    i_inv = (3.0 * (vd * self.id + vq * self.iq)
      + self.bridge_loss(running) + LINK_DRAIN_W) / max(self.vdc, 1.0)
    if self.vdc < BUS_VRECT_V:
      aim = BUS_VRECT_V - i_inv * BUS_RSRC_ohm
      self.vdc += (aim - self.vdc) * min(1.0, dt / (BUS_RSRC_ohm * self.bus_c))
    else:
      self.vdc -= i_inv * dt / self.bus_c
    self.vdc = max(100.0, self.vdc)
    if not cmd.dc_max_v: return False
    return self.vdc > cmd.dc_max_v - (0.0 if closed else BUS_MARGIN_V)

  def sense(self, dt:float, running:bool):
    aim = AMBIENT_C + self.rth * self.bridge_loss(running)
    self.temp += (aim - self.temp) * dt / (TEMP_TAU_s + dt)
