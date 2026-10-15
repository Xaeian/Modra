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
  27.5
"""

from random import Random
from math import atan2, cos, exp, pi as PI, sin, sqrt
from .command import Command
from .curve import clamp, interp

#-------------------------------------------------------------------------------- The 1500W machine

# Electrical side: Rs from the end-of-line measurement, Lq from the assembled motor.
# The stator alone reads 2.5× less.
RS_ohm = 0.898
LQ_H = 0.0154
# Phase RMS volts per ELECTRICAL Hz, the unit the whole package works in.
# The nameplate 100.6 V/krpm line-to-line RMS is 0.58.
# The loops' output at 40Hz on the bench (`Foc:Vd` 12.7% with a vanishing `Foc:Vq`)
# reads the back-EMF at 22V, a touch under it,
# and the powers on the I/f steps (65W at 40Hz, 215W at 60Hz, 407W at 90Hz) sit between the two.
# A smaller constant cannot reach those powers.
KE_V_Hz = 0.55
POLES = 6
# How this board's current channels are really wired, in the map register's terms.
# The drive reads the board as drawn with `Sense:PhaseMap` at `norm`,
# so the guard stays silent until somebody changes it,
# which is what makes the guard worth reading.
PHASEMAP = 0
# What the bridge keeps for itself along each phase current:
# the dead time `td/T × Vdc` the register `Pwm:Deadtime` describes,
# plus the forward drop of the conducting leg.
# Its size comes from the V/f start: at 2Hz and `Volt:2Hz` 19.4V,
# the measured 3.1A is the full 16V off the table.
# Its shape comes from the I/f steps on the bench:
# `Feedback:ModIndex` read 10% at 25Hz and 0.5A, 15% at 40Hz and 0.8A, 28% at 80Hz and 2.2A,
# which is the back-EMF plus the loss's fundamental.
# A loss rising from zero and whole above `LOSS_A1` puts the modulation of every step
# where the drive reads it.
# The observer still subtracts a full square wave when `Obs:DtComp` says so,
# which is why every percent of it adds ripple the bridge never made
# and the drive read its smallest `Sync:ErrPeak` at zero.
# The whole loss, phase RMS scale: 2500ns of dead time at 10kHz on a 590V link is 10.4V,
# the rest is gate delays and the forward drops,
# and 3.1A at the start is what 15V off the table leaves in a 0.9Ω winding
LOSS_V = 15.0
LOSS_A0, LOSS_A1 = 0.0, 0.8 # phase current, RMS scale: absent under A0, whole above A1
DTCOMP_pct = 100.0 # the share of the nominal dead time the guard reports

# The shaft: the fan as the speed loop measures it.
# In closed the loop holds the torque current `iq`, so every step reads the load as `kt × iq`:
# 0.47A at 40Hz, 0.62A at 55Hz, 1.02A at 80Hz, 1.54A at 100Hz, electrical, held 20s to 180s.
# `iq = 0.34A + 1.9e-5 × f^2.4` meets every step within 9mA
# and the 1.87A measured at 110Hz, a step the loop did not hold.
# Under 40Hz and over 110Hz the anchors are that fit alone.
# In I/f the same load is a 19° load angle at 45Hz on 1.55A,
# so the -51° to -76° `Obs:AngleErr` reads there is mostly observer error.
#   mechanical rad/s → Nm
LOAD_CURVE = [(0.0, 0.53), (20.9, 0.57), (41.9, 0.74), (57.6, 0.98), (73.3, 1.33), (89.0, 1.80),
  (104.7, 2.40), (125.7, 3.43), (146.6, 4.73), (172.8, 6.76)]
# The same loop on its ramps weighs the rotor at 0.24kgm²:
# 0.3A over the steady current climbing at 1.7-2Hz/s, 0.42-0.7A under it on a stop at 2.5-4.7Hz/s,
# `J α = kt Δiq` either way.
# The model runs lighter, because its bridge takes more of the `Volt` table at standstill:
# 1.3A at 2.4Hz where the drive draws 3.35A, and a V/f start that weak cannot pull 0.24 into step
INERTIA_kgm2 = 0.05

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
TEMP_RTH_CW = 0.8
TEMP_TAU_s = 300.0
SWITCH_LOSS_W = 12.0
RIPPLE_BASE_V = 1.5
RIPPLE_PER_A = 0.4
VCE_V = 1.5
FLYBACK_V = 17.0
PEAK_FACTOR = 2.828 # sine phase RMS to peak-to-peak
PEAK_TRIP_A = 40.0
GUARD_SWAP = 0.45
GUARD_HALF = 0.5
GUARD_PUSH = 3.0

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

#------------------------------------------------------------------------------------------ Machine

class Machine:
  """Iron, shaft and link. Integrated, not solved."""
  def __init__(
    self, rs:float = RS_ohm, lq:float = LQ_H, ke:float = KE_V_Hz, poles:int = POLES,
    phasemap:int = PHASEMAP, dtcomp:float = DTCOMP_pct, peak_trip:float = PEAK_TRIP_A,
    inertia:float = INERTIA_kgm2, load:list|None = None,
  ):
    self.rs = rs
    self.lq = lq
    self.ke = ke
    self.poles = poles
    self.phasemap = phasemap
    self.dtcomp_true = dtcomp # the observer's nominal, for `guard_point`
    self.peak_trip = peak_trip
    self.inertia = inertia
    self.load = list(load or LOAD_CURVE)
    self.reset()

  def reset(self):
    """Power-on: shaft stopped, link charged, stage cold."""
    self.clear()
    self.wm = 0.0        # MECHANICAL speed [rad/s]
    self.theta_r = 0.0   # rotor flux angle, electrical [rad]
    self.vdc = BUS_VRECT_V
    self.temp = AMBIENT_C

  def clear(self):
    """Bridge off. Currents and the loops go; the SHAFT is not touched."""
    self.id = 0.0    # rotor-frame currents, phase RMS
    self.iq = 0.0
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
    # seeded: a run is repeatable to the sample
    self.rng = Random(1)
    self.lean = 0.0 # `If:Damp`'s current frame tilt [rad]
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
    whole past `LOSS_A1`, a square wave of the phase current's sign in between them.
    """
    v = LOSS_V
    iu = i_a
    iv = -0.5 * i_a + 0.8660254 * i_b
    iw = -0.5 * i_a - 0.8660254 * i_b
    def share(x):
      k = clamp((abs(x) - LOSS_A0) / (LOSS_A1 - LOSS_A0), 0.0, 1.0)
      return k if x > 0.0 else -k
    su, sv, sw = share(iu), share(iv), share(iw)
    return (2.0 * su - sv - sw) / 3.0 * v, (sv - sw) / 1.7320508 * v

  def table_volts(self, cmd:Command, hz:float) -> float:
    """
    What the bridge is asked to render off the `Volt` table;
    the loss comes off inside the sub-step, along the current.
    """
    return max(0.0, interp(cmd.volt, hz) or 0.0)

  def modulate(self, cmd:Command, f:float, ceiling:float) -> bool:
    """The applied vector against what the bus can render."""
    shape = SHAPE_K[int(clamp(cmd.shape, 0, len(SHAPE_K) - 1))]
    per_volt = V_PEAK * shape * 2.0 / max(1.0, self.vdc) * 100.0
    mod = 0.0 if f <= 0.0 else self.volt * per_volt
    self.mod_index = min(ceiling, mod)
    if mod > ceiling: self.volt = self.mod_index / per_volt
    return mod >= ceiling

  def vmax(self, cmd:Command) -> float:
    """Phase RMS volts the loops may ask for under `Foc:ModCeil`."""
    shape = SHAPE_K[int(clamp(cmd.shape, 0, len(SHAPE_K) - 1))]
    return cmd.mod_ceil_pct / 100.0 * self.vdc / 2.0 / (V_PEAK * shape)

  def forced_mag(self, cmd:Command, hz:float) -> float:
    """The forced vector's magnitude off the `Curr` table, under `Foc:IqMax`."""
    return min(interp(cmd.curr, hz) or 0.0, cmd.iq_max_a)

  #------------------------------------------------------------------------------------ Integration

  def step_vector(
    self, cmd:Command, h:float, theta_ctrl:float, ref:tuple, forced:bool,
  ) -> tuple:
    """
    One sub-step under the current loops.

    `theta_ctrl` is the frame the loops render into, `ref` the (id, iq) reference in that frame.
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
    # One ADC sample per sub-step, taken before the bridge acts,
    # the same one for the loops and the observer.
    # The loops chase the reference from where the sample says the current is,
    # so its noise walks into the voltage and, through `If:Damp`, into the angle.
    # The observer integrates it against the voltage of this step, as `step_table` does
    s_a, s_b = rotate(self.id, self.iq, -self.theta_r)
    if NOISE_A: s_a, s_b = s_a + self.rng.gauss(0.0, NOISE_A), s_b + self.rng.gauss(0.0, NOISE_A)
    id_m, iq_m = rotate(s_a, s_b, theta_c)
    id_c, iq_c = rotate(self.id, self.iq, phi)
    id_r, iq_r = rotate(id_c + (ref[0] - id_m) * g, iq_c + (ref[1] - iq_m) * g, -phi)
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
      self._winding(h, vd_r, vq_r)
    else:
      self.id, self.iq = id_r, iq_r
      self.curr_hi = max(self.curr_hi, self.curr)
    self.vd_c, self.vq_c = rotate(c_a, c_b, theta_c)
    self.v_ab, self.i_ab = (c_a, c_b), (s_a, s_b)
    self._shaft(h)
    if forced: self._damp(cmd, h)
    return self.v_ab, self.i_ab

  def step_table(self, cmd:Command, h:float, theta_field:float, volts:float) -> tuple:
    """One sub-step under the `Volt` table: voltage imposed at the field angle."""
    self.lean = 0.0
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
      self.vdc += (aim - self.vdc) * min(1.0, dt / (BUS_RSRC_ohm * BUS_C_F))
    else:
      self.vdc -= i_inv * dt / BUS_C_F
    self.vdc = max(100.0, self.vdc)
    if not cmd.dc_max_v: return False
    return self.vdc > cmd.dc_max_v - (0.0 if closed else BUS_MARGIN_V)

  def sense(self, dt:float, running:bool):
    loss = 3.0 * self.rs * self.curr ** 2 + self.bridge_loss(running)
    aim = AMBIENT_C + TEMP_RTH_CW * loss
    self.temp += (aim - self.temp) * dt / (TEMP_TAU_s + dt)

  def guard_point(self, cmd:Command, hz:float) -> tuple:
    """
    What the start feed guard caught:
    the volts the d-axis asked for, the current that answered, and what it asked of it.
    """
    want = self.forced_mag(cmd, max(hz, 0.0))
    wrong = int(cmd.phasemap) ^ int(self.phasemap)
    seen = want
    if wrong & 0b100: seen *= GUARD_SWAP
    flipped = (wrong & 0b001 != 0) + (wrong & 0b010 != 0)
    if flipped == 1: seen *= -GUARD_HALF
    elif flipped == 2: seen *= -1.0
    return GUARD_PUSH * (self.rs * want + self.dead_v(cmd, self.dtcomp_true)), seen, want
