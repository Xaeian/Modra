"""
Modbus device simulator. Drop-in replacement for AsyncModbusSerialClient.

Numeric R registers walk a mean-reverting random walk: the step at each
tick is drawn from [-down, +up] where `down` peaks at max and `up` peaks
at min (both Gaussian-shaped). Near an edge the asymmetric range pulls
values back toward the middle - the result looks like real instrument
traces rather than a clean sinusoid or pure noise.

  numeric R  → mean-reverting random walk, clamped to min/max
  bool R     → toggles with small per-tick probability
  enum R     → advances one slot with small per-tick probability
  hex/ver    → stable (firmware-controlled)
  RW/RWs/W   → never drifts (user-controlled)

Each register is simulated from its own descriptor row alone (type, rws,
min/max) - no cross-register logic, no mode/setpoint dependencies.

Inspired by the PHP `rand.php` in `php-inspiration/`. Per-register tuning
(sigma/gain/chance) is seeded from `(rid, name)` so adjacent channels
look uncorrelated. `ver` falls back to "0.1.0" when regs.csv has no
`default`, so fresh sims don't show a blank badge.
"""

import asyncio, math, random, time

#---------------------------------------------------------- Tuning constants

# `sigma` is the width of the edge-bias Gaussians (as a fraction of span).
# `gain` is the maximum single-tick step (as a fraction of span). The PHP
# original uses 1.0 / 0.01 - we pick 0.7 for sharper edge restoration and
# vary gain per-register so traces don't all march at the same pace.
SIGMA_FRAC = 0.7
GAIN_FRAC_MIN = 0.004
GAIN_FRAC_MAX = 0.012

# Discrete-type tick probabilities. Tuned for ~200-500ms polls so a flip
# happens every minute or two on average.
BOOL_CHANCE_MIN = 0.002
BOOL_CHANCE_MAX = 0.010
ENUM_CHANCE_MIN = 0.001
ENUM_CHANCE_MAX = 0.005

VER_FALLBACK = "0.1.0"

#---------------------------------------------------------- Modbus response shims

class _RR:
  def __init__(self, registers): self.registers = registers
  def isError(self): return False

class _WR:
  def isError(self): return False

#---------------------------------------------------------- Simulated client

class SimulatedClient:
  """Mock AsyncModbusSerialClient. Holds per-id uint16 state, evolves it
  on each read tick from a mean-reverting random walk."""

  def __init__(self, id_map:dict):
    self.id_map = id_map
    self.connected = False
    self.values:dict[int, int] = {}
    # Per-register tuning (gain, sigma, flip-chance) seeded from (rid, name)
    # so traces stay uncorrelated across registers but consistent per tick.
    self._params:dict[tuple, float] = {}
    self._last_tick = time.time()
    for rid, entry in id_map.items():
      self.values[rid] = self._initial(entry)

  def reattach(self, id_map:dict):
    """Bind to a fresh `id_map` after a ModbusMaster rebuild while keeping
    the random-walk state. Seeds entries new to this id_map; drops entries
    that disappeared. Without this, every ignore/serial toggle would reset
    all telemetry traces to their initial midpoint."""
    self.id_map = id_map
    for rid in list(self.values):
      if rid not in id_map: del self.values[rid]
    for rid, entry in id_map.items():
      if rid not in self.values:
        self.values[rid] = self._initial(entry)

  #---------------------------------------------------------- Helpers

  @staticmethod
  def _first(v):
    return v[0] if isinstance(v, list) and v else v

  def _param(self, rid:int, name:str, lo:float, hi:float) -> float:
    """Stable per-register parameter. Seeded by `(rid, name)` so ticks
    produce consistent values across calls."""
    key = (rid, name)
    if key not in self._params:
      rng = random.Random((rid << 16) ^ hash(name))
      self._params[key] = rng.uniform(lo, hi)
    return self._params[key]

  def _bounds(self, entry:dict) -> tuple[float|None, float|None]:
    """Parsed (min, max) with a scale-aware fallback for unbounded R regs."""
    mn = self._first(entry.get("min"))
    mx = self._first(entry.get("max"))
    try: mn = float(mn) if mn is not None else None
    except (TypeError, ValueError): mn = None
    try: mx = float(mx) if mx is not None else None
    except (TypeError, ValueError): mx = None
    if mn is not None and mx is not None: return (mn, mx)
    # Telemetry registers often leave min/max blank because the device
    # doesn't bound them. Pick a scale-aware window so the sim still plays
    # in a believable range.
    scale = self._first(entry.get("scale", 1)) or 1
    try: scale = float(scale)
    except (TypeError, ValueError): scale = 1.0
    if not scale: scale = 1.0
    hi = min(100.0, 65535.0 / scale)
    typ = entry.get("type", "uint")
    if typ == "int":
      if mn is None: mn = -hi
      if mx is None: mx = hi
    else:
      if mn is None: mn = 0.0
      if mx is None: mx = hi
    return (mn, mx)

  #---------------------------------------------------------- Value coding

  @staticmethod
  def _to_raw(entry:dict, val) -> int:
    typ = entry.get("type", "uint")
    if typ == "bool":
      return 1 if val else 0
    if typ == "enum":
      enum_map = entry.get("enum", {})
      if isinstance(val, str):
        rev = {str(v).lower(): k for k, v in enum_map.items()}
        return rev.get(val.lower(), next(iter(enum_map), 0))
      try:
        iv = int(val)
        return iv if iv in enum_map else next(iter(enum_map), 0)
      except (TypeError, ValueError):
        return next(iter(enum_map), 0)
    if typ == "ver":
      parts = [p for p in str(val).split(".") if p.isdigit()]
      if len(parts) != 3: return 0
      raw = int(parts[0])*10000 + int(parts[1])*100 + int(parts[2])
      return raw & 0xFFFF
    scale = SimulatedClient._first(entry.get("scale", 1)) or 1
    try: f = float(val) * float(scale)
    except (TypeError, ValueError): f = 0.0
    if typ == "int":
      i = int(round(f))
      if i < 0: i += 0x10000
      return i & 0xFFFF
    return int(round(f)) & 0xFFFF

  @staticmethod
  def _raw_to_eng(entry:dict, raw:int) -> float:
    """Inverse of `_to_raw` for the numeric (uint/int/rule) types."""
    typ = entry.get("type", "uint")
    scale = SimulatedClient._first(entry.get("scale", 1)) or 1
    try: scale = float(scale)
    except (TypeError, ValueError): scale = 1.0
    if not scale: scale = 1.0
    if typ == "int":
      r = raw if raw < 0x8000 else raw - 0x10000
    else:
      r = raw
    return r / scale

  def _initial(self, entry:dict) -> int:
    """Seed initial raw value. regs.csv `default` wins; otherwise pick a
    sensible per-type fallback (midpoint for numerics, first enum key,
    "0.1.0" for ver). The random walk picks up where this leaves off."""
    typ = entry.get("type", "uint")
    default = self._first(entry.get("default"))
    if default is not None and default != "":
      try: return self._to_raw(entry, default)
      except Exception: pass
    if typ == "ver":
      try: return self._to_raw(entry, VER_FALLBACK)
      except Exception: return 0
    if typ in ("uint", "int", "rule"):
      mn, mx = self._bounds(entry)
      if mn is not None and mx is not None and mx > mn:
        # Start in the middle 60% of the range so the walk has room to drift
        # either way before hitting a wall.
        rng = random.Random((entry["id"] << 16) ^ hash(entry.get("fullname", "")))
        start = mn + (mx - mn) * (0.2 + 0.6 * rng.random())
        try: return self._to_raw(entry, start)
        except (TypeError, ValueError): pass
    if typ == "enum":
      keys = list(entry.get("enum", {}).keys())
      return keys[0] if keys else 0
    return 0

  #---------------------------------------------------------- Tick

  def _tick_one(self, rid:int):
    entry = self.id_map.get(rid)
    if not entry: return
    rws = entry.get("rws", "R")
    typ = entry.get("type", "uint")
    # Only pure read-only telemetry drifts. Anything writable (W/RW/RWs)
    # stays where the user / firmware put it - otherwise a written setpoint
    # would walk off into nonsense values on the next tick.
    if rws != "R": return
    # Identity types (firmware version, status codes) aren't telemetry.
    if typ in ("hex", "ver"): return
    # Pair halves stay at their initial value - drifting them independently
    # would produce meaningless uint32 / float words.
    rule = entry.get("rule") or {}
    if "high" in rule or "low" in rule: return

    if typ == "bool":
      chance = self._param(rid, "bool_c", BOOL_CHANCE_MIN, BOOL_CHANCE_MAX)
      if random.random() < chance:
        self.values[rid] ^= 1
      return

    if typ == "enum":
      keys = list(entry.get("enum", {}).keys())
      if not keys: return
      chance = self._param(rid, "enum_c", ENUM_CHANCE_MIN, ENUM_CHANCE_MAX)
      if random.random() < chance:
        cur = self.values[rid]
        idx = keys.index(cur) if cur in keys else 0
        # Random neighbour (forward or backward) - looks more natural than
        # always cycling in one direction.
        step = 1 if random.random() < 0.5 else -1
        self.values[rid] = keys[(idx + step) % len(keys)]
      return

    # Numeric (uint/int/rule): mean-reverting random walk.
    mn, mx = self._bounds(entry)
    if mn is None or mx is None or mx <= mn: return

    span = mx - mn
    sigma = span * SIGMA_FRAC
    gain = span * self._param(rid, "gain", GAIN_FRAC_MIN, GAIN_FRAC_MAX)

    eng = self._raw_to_eng(entry, self.values[rid])
    # Clamp the input - if a write parked the register outside its range
    # we'd otherwise get a degenerate Gaussian. Snap back gradually.
    eng = max(mn, min(mx, eng))

    # `down` peaks at mx (max attracts → push toward smaller values).
    # `up` peaks at mn (min attracts → push toward larger values).
    # Near an edge the asymmetric step range pulls the value back to centre.
    down = gain * math.exp(-((mx - eng) ** 2) / (2 * sigma ** 2))
    up   = gain * math.exp(-((eng - mn) ** 2) / (2 * sigma ** 2))
    step = random.uniform(-down, up)

    eng = max(mn, min(mx, eng + step))
    self.values[rid] = self._to_raw(entry, eng)

  def _tick_all(self):
    # Single global tick instead of per-read so register pairs (read in
    # different blocks) stay consistent within the same poll cycle.
    now = time.time()
    if now - self._last_tick < 0.05: return
    self._last_tick = now
    for rid in self.id_map: self._tick_one(rid)

  #---------------------------------------------------------- Client interface

  async def connect(self):
    await asyncio.sleep(0.01)
    self.connected = True
    return True

  def close(self):
    self.connected = False

  async def read_holding_registers(self, address:int, count:int=1, device_id:int=1):
    await asyncio.sleep(0.005)
    self._tick_all()
    regs = [self.values.get(address + i, 0) for i in range(count)]
    return _RR(regs)

  async def write_registers(self, address:int, values:list, device_id:int=1):
    await asyncio.sleep(0.005)
    for i, v in enumerate(values):
      self.values[address + i] = int(v) & 0xFFFF
    return _WR()
