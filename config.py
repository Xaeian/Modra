"""
Backend config: serial.ini (connection), regs.csv path,
view.json (monitor panels + ignore list). Factory for ModbusMaster bound
to current on-disk state.
"""

from modbus import ModbusMaster
from xaeian import INI, JSON, Color

STATE_FILE = "serial.ini"
REGS_FILE = "regs.csv"
VIEW_FILE = "view.json"

# Read write-only (W) registers back on a sync (device is source of truth), or
# never read them and show a written W as 0 (self-clearing command registers).
READBACK_W = True

# Background trickle-refresh of RW/RWs between syncs (smart contiguous packets,
# auto-sized to the poll interval). Off leaves them refreshed only on a sync.
TRICKLE = True

# Seeds serial.ini on first launch.
STATE_DEFAULT = {
  "port": "COM3",
  "addr": 1,
  "baudrate": 9600,
  "parity": "N",
  "stopbits": 1,
  "timeout": 1000,
  "retries": 3,
  "interval": 500,
  "history": 14,
  "autosend": False,
}

VIEW_DEFAULT = {"version": 1, "monitor": [], "ignore": []}

def load_state() -> dict:
  state = INI.load(STATE_FILE)
  if state: return state
  INI.save(STATE_FILE, STATE_DEFAULT)
  return dict(STATE_DEFAULT)

def save_state(state:dict):
  INI.save(STATE_FILE, state)

def _int(val, default:int) -> int:
  try: return int(val)
  except (ValueError, TypeError): return default

def _bool(val, default:bool=False) -> bool:
  """Coerce INI-style values to bool. Accepts true/yes/1/on (case-insensitive)."""
  if isinstance(val, bool): return val
  if val is None: return default
  s = str(val).strip().lower()
  if s in ("true", "yes", "1", "on"): return True
  if s in ("false", "no", "0", "off", ""): return False
  return default

#------------------------------------------------------------------------------ View (UI state)

def load_view() -> dict:
  """Lenient: missing keys default to empty so a partial file still boots."""
  try:
    data = JSON.load(VIEW_FILE)
    if isinstance(data, dict):
      out = dict(VIEW_DEFAULT)
      if isinstance(data.get("monitor"), list):
        out["monitor"] = data["monitor"]
      if isinstance(data.get("ignore"), list):
        out["ignore"] = [str(x).strip() for x in data["ignore"] if str(x).strip()]
      return out
  except Exception: pass
  return dict(VIEW_DEFAULT)

def save_view(view:dict):
  payload = {
    "version": 1,
    "monitor": view.get("monitor", []) if isinstance(view.get("monitor"), list) else [],
    "ignore":  [str(x).strip() for x in view.get("ignore", []) if str(x).strip()],
  }
  JSON.save_smart(VIEW_FILE, payload)

#---------------------------------------------------------------------------- ModbusMaster wire

def create_mb(state:dict, view:dict=None, port:str=None) -> ModbusMaster:
  """ModbusMaster bound to current state + `view.ignore`. Ignore is applied
  inside `mb.read()`; the map itself stays complete so the DB schema covers
  every register. `view=None` lets CLI tools skip view.json lookup."""
  if view is None: view = load_view()
  port = port or str(state.get("port", ""))
  return ModbusMaster(
    port=port,
    regmap_file=REGS_FILE,
    addr=_int(state.get("addr"), 1),
    baudrate=_int(state.get("baudrate"), 9600),
    parity=str(state.get("parity", "N")),
    stopbits=_int(state.get("stopbits"), 1),
    timeout=_int(state.get("timeout"), 1000) / 1000,
    retries=_int(state.get("retries"), 3),
    ignore_set=set(view.get("ignore", [])),
    sim=(port == "SIM"),
  )

#-------------------------------------------------------------------------- Map lint

# 16-bit register span per type; the encoder masks round(value*scale) with
# & 0xFFFF, so a bound/default that overflows wraps instead of being rejected.
_RAW_RANGE = {
  "uint": (0, 0xFFFF), "hex": (0, 0xFFFF), "rule": (0, 0xFFFF),
  "int": (-0x8000, 0x7FFF),
}

def _slots(val) -> list:
  return val if isinstance(val, list) else [val]

def _slot(val, i):
  """Per-slot pick for rule lists; scalars repeat, OOB falls back to slot 0
  (matching runtime _get_scale / _get_minmax)."""
  if not isinstance(val, list): return val
  if i < len(val): return val[i]
  return val[0] if val else None

def lint_regs(regs:list[dict]) -> list[tuple[str, str]]:
  """Flag regs.csv mistakes the encoder would otherwise hide (uint16 wrap,
  scale-zero coercion). Advisory: logs and returns issues, never raises."""
  issues = []
  for r in regs:
    name = r.get("name", "?")
    # 32-bit pairs (list id) encode outside the single-word scale path.
    if isinstance(r.get("id"), list): continue
    rng = _RAW_RANGE.get(r.get("type"))
    if not rng: continue
    raw_lo, raw_hi = rng
    scale, mn, mx = r.get("scale", 1.0), r.get("min"), r.get("max")
    n = max(len(_slots(scale)), len(_slots(mn)), len(_slots(mx)))
    for i in range(n):
      s, lo, hi = _slot(scale, i), _slot(mn, i), _slot(mx, i)
      tag = name + (f"[{i}]" if n > 1 else "")
      if s is None or s <= 0:
        issues.append(("err", f"{tag}: scale={s} (must be > 0)"))
        continue
      if lo is not None and hi is not None and lo > hi:
        issues.append(("wrn", f"{tag}: min {lo:g} > max {hi:g}"))
      for label, bound in (("min", lo), ("max", hi)):
        if bound is None: continue
        raw = bound * s
        if raw < raw_lo or raw > raw_hi:
          issues.append(("wrn",
            f"{tag}: {label} {bound:g} x scale {s:g} = {raw:g} "
            f"out of register range [{raw_lo}, {raw_hi}] - writes near it wrap"))
    # default-in-range only when bounds are plain scalars: rule slots and
    # per-variant defaults live on different list axes, so don't cross them.
    if not isinstance(mn, list) and not isinstance(mx, list):
      for d in _slots(r.get("default")):
        if not isinstance(d, (int, float)) or isinstance(d, bool): continue
        if mn is not None and d < mn:
          issues.append(("wrn", f"{name}: default {d:g} below min {mn:g}"))
        if mx is not None and d > mx:
          issues.append(("wrn", f"{name}: default {d:g} above max {mx:g}"))
  if issues:
    errs = sum(1 for k, _ in issues if k == "err")
    print(f"{Color.ORANGE}regs.csv: {len(issues)} issue(s), {errs} error(s){Color.END}")
    for kind, msg in issues:
      col = Color.RED if kind == "err" else Color.YELLOW
      print(f"  {col}{kind.upper()}{Color.END} {msg}")
  return issues

def load_regs(state:dict=None, view:dict=None) -> list[dict]:
  """Full register catalog (ignored entries included; frontend hides them)."""
  if state is None: state = load_state()
  if view is None: view = load_view()
  regs = create_mb(state, view).regs_info()
  lint_regs(regs)
  return regs
