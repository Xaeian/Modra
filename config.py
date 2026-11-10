"""
Backend config: serial.ini (connection), regs.csv path,
view.json (monitor panels + ignore list). Factory for ModbusMaster bound
to current on-disk state.
"""

import re, sys
from importlib import import_module
from modbus import ModbusMaster, RAW_SPAN, slot
from xaeian import INI, JSON, FILE, PATH, Print

APP_FILE = "app.ini" # deployment facts shared with the frontend build
STATE_FILE = "serial.ini"
REGS_FILE = "regs.csv"
VIEW_FILE = "view.json"

log = Print()

# Read write-only (W) registers back on a sync (device is source of truth), or
# never read them and show a written W as 0 (self-clearing command registers).
READBACK_W = True

# Background trickle-refresh of RW/RWs between syncs (smart contiguous packets,
# auto-sized to the poll interval). Off leaves them refreshed only on a sync.
TRICKLE = True

# Auto-unlock: with AUTH_KEY_REG in the map, AUTH_KEY goes out on connect,
# and again whenever the level drops below AUTH_LEVEL (it boots to guest).
# The key is a firmware constant, ectra's `SECRET_KEY_ADMIN`.
# `AUTH_KEY = None`, or a map without that register, leaves access untouched.
AUTH_KEY = 0x5D8E41B3
AUTH_KEY_REG = "Auth:SecretKey"  # 32-bit `high=`/`low=` pair or a single reg
AUTH_LEVEL_REG = "Auth:Access"   # enum reporting the level; optional
AUTH_LEVEL = "admin"             # label from that enum to hold

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

VIEW_DEFAULT = {"ask_map": True, "monitor": [], "ignore": []}

def regs_path() -> str:
  """Absolute, so the map is read from and written to the same file: a bundled
  read would otherwise resolve inside the executable."""
  return PATH.resolve(REGS_FILE, read=False)

def load_state() -> dict:
  """serial.ini over `STATE_DEFAULT`, written out with the defaults on a first start."""
  state = INI.load(STATE_FILE)
  if not state: INI.save(STATE_FILE, STATE_DEFAULT)
  return {**STATE_DEFAULT, **(state or {})}

def save_state(state:dict):
  INI.save(STATE_FILE, state)

def _int(val, default:int) -> int:
  try: return int(val)
  except (ValueError, TypeError): return default

def setting(state:dict, key:str):
  """
  `state[key]` in the type its `STATE_DEFAULT` has, that default where it is missing or garbage.
  The one place a setting's default lives: a reader never keeps a copy of it.
  """
  default = STATE_DEFAULT[key]
  val = state.get(key, default)
  if isinstance(default, bool): return as_bool(val, default)
  if isinstance(default, int): return _int(val, default)
  return default if val is None else str(val)

def as_bool(val, default:bool=False) -> bool:
  """Coerce INI-style values to bool. Accepts true/yes/1/on (case-insensitive)."""
  if isinstance(val, bool): return val
  if val is None: return default
  s = str(val).strip().lower()
  if s in ("true", "yes", "1", "on"): return True
  if s in ("false", "no", "0", "off", ""): return False
  return default

#---------------------------------------------------------------------------------- View (UI state)

def load_view() -> dict:
  """Lenient: missing keys default to empty so a partial file still boots."""
  try:
    data = JSON.load(VIEW_FILE)
    if isinstance(data, dict):
      out = dict(VIEW_DEFAULT)
      out["ask_map"] = as_bool(data.get("ask_map"), True)
      if isinstance(data.get("monitor"), list):
        out["monitor"] = data["monitor"]
      if isinstance(data.get("ignore"), list):
        out["ignore"] = [str(x).strip() for x in data["ignore"] if str(x).strip()]
      return out
  except Exception as e:
    # Kept aside before the defaults stand in: the next save would write them over it
    FILE.save(VIEW_FILE + ".bad", FILE.load(VIEW_FILE, binary=True))
    log.wrn(f"{VIEW_FILE} unreadable, kept as {VIEW_FILE}.bad | {e}")
  return dict(VIEW_DEFAULT)

def save_view(view:dict):
  payload = {
    "ask_map": as_bool(view.get("ask_map"), True),
    "monitor": view.get("monitor", []) if isinstance(view.get("monitor"), list) else [],
    "ignore": [str(x).strip() for x in view.get("ignore", []) if str(x).strip()],
  }
  JSON.save_smart(VIEW_FILE, payload)

#-------------------------------------------------------------------------------- ModbusMaster wire

_sims_loaded = False

def app_path() -> str:
  """`app.ini` beside the app, never relative to the working directory: which
  simulator a build ships cannot depend on where the app was launched from.
  Frozen, the bundle carries its own copy."""
  return PATH.join(getattr(sys, "_MEIPASS", None) or PATH.dirname(__file__), APP_FILE)

def _load_sims():
  """Import the coupled simulator packages this build ships, once.
  They register themselves on import,
  the way a bundled widget file registers when the page loads it.

  Which packages exist is a deployment fact, so it lives in `app.ini` beside
  `widgets` rather than here: another device is a new package and a new line
  there, and a build for none is that line left empty."""
  global _sims_loaded
  if _sims_loaded: return
  _sims_loaded = True
  path = app_path()
  try: listed = str(INI.load(path).get("sim", "") or "")
  except Exception as e:
    log.wrn(f"{path} unreadable, SIM falls back to the generic walk | {e}")
    return
  for name in (n.strip() for n in listed.split(",")):
    if not name: continue
    try: import_module(name)
    except Exception as e:
      log.wrn(f"sim package {name} not loaded | {e}")

def sim_client(mb:ModbusMaster, prev=None):
  """Simulated transport for the SIM port.

  A coupled device model when one of the loaded simulators recognises the map,
  the generic per-register walk when none does,
  which is also what a build shipping no simulator at all gets.

  The single place that choice is made, so a caller holding a client across a
  reconnect cannot pin the wrong one. `prev` is reused while it is still the
  right kind, keeping the simulated device's state; a map swap that changes the
  shape builds the other kind instead."""
  from sim import SimulatedClient, REGISTRY
  _load_sims()
  cls = SimulatedClient
  for offer in REGISTRY:
    # A throwing `match` disqualifies its simulator rather than the SIM port.
    try:
      if offer.match(mb.id_map): cls = offer; break
    except Exception as e:
      log.wrn(f"sim {offer.__name__} match failed | {e}")
  # A model was asked for and none takes this map: without a word the walk would pass for it
  if cls is SimulatedClient and REGISTRY:
    names = ", ".join(sorted({o.__module__.split(".")[0] for o in REGISTRY}))
    log.wrn(f"SIM: the map fits no model of {names}, generic walk")
  if type(prev) is cls:
    prev.reattach(mb.id_map)
    return prev
  return cls(mb.id_map)

def _glob(pattern:str) -> re.Pattern:
  """
  `*` and `?` as in a file name, every other character literal, case kept.
  The grid reads a pattern the same way, so a row it shows as polled is one the poll reads.
  """
  return re.compile(re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".") + r"\Z")

def ignore_names(patterns, mb:ModbusMaster) -> set[str]:
  """view.json entries may be globs (`Journal:*`); the map takes plain names, so
  expand once, here."""
  known = list(mb.name_map) + list(mb.pairs)
  out = set()
  for p in (str(x).strip() for x in patterns):
    if not p: continue
    if "*" in p or "?" in p: out |= {n for n in known if _glob(p).match(n)}
    else: out.add(p)
  return out

def is_info(cell) -> bool:
  """The map's `info` column: `true` on a read-only register the config file carries."""
  return str(cell or "").strip().lower() == "true"

def create_mb(state:dict, view:dict=None, port:str=None) -> ModbusMaster:
  """ModbusMaster bound to current state + `view.ignore`. Ignore is applied
  inside `mb.read()`; the map itself stays complete so the DB schema covers
  every register. `view=None` reads it from view.json. The SIM
  port swaps the transport client here."""
  if view is None: view = load_view()
  port = port or setting(state, "port")
  mb = ModbusMaster(
    port=port,
    regmap_file=regs_path(),
    addr=setting(state, "addr"),
    baudrate=setting(state, "baudrate"),
    parity=setting(state, "parity"),
    stopbits=setting(state, "stopbits"),
    timeout=setting(state, "timeout") / 1000,
    retries=setting(state, "retries"),
    client_factory=sim_client if port == "SIM" else None,
  )
  # Needs the parsed map to resolve globs against.
  mb.ignore_set = ignore_names(view.get("ignore", []), mb)
  return mb

#----------------------------------------------------------------------------------------- Map lint

def _slots(val) -> list:
  return val if isinstance(val, list) else [val]

def lint_regs(regs:list[dict]) -> list[tuple[str, str]]:
  """Flag regs.csv mistakes the encoder would otherwise hide (uint16 wrap,
  scale-zero coercion). Advisory: logs and returns issues, never raises."""
  issues = []
  for r in regs:
    name = r.get("name", "?")
    # 32-bit pairs (list id) encode outside the single-word scale path.
    if isinstance(r.get("id"), list): continue
    rng = RAW_SPAN.get(r.get("type"))
    if not rng: continue
    raw_lo, raw_hi = rng
    scale, mn, mx = r.get("scale", 1.0), r.get("min"), r.get("max")
    n = max(len(_slots(scale)), len(_slots(mn)), len(_slots(mx)))
    for i in range(n):
      s, lo, hi = slot(scale, i), slot(mn, i), slot(mx, i)
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
    log.wrn(f"regs.csv: {len(issues)} issue(s), {errs} error(s)")
    for kind, msg in issues: (log.err if kind == "err" else log.wrn)(f"  {msg}")
  return issues

def load_regs(state:dict=None, view:dict=None) -> list[dict]:
  """Full register catalog (ignored entries included; frontend hides them).
  Empty when there is no map yet - the app starts anyway and asks for one."""
  if state is None: state = load_state()
  if view is None: view = load_view()
  regs = create_mb(state, view).regs_info()
  lint_regs(regs)
  return regs

def save_regs(text:str) -> list[dict]|None:
  """Persist a register map, but only once it loads. A map that fails to parse
  would leave the app with nothing to show and no way to ask again, so the
  previous file (or the absence of one) is put back on failure."""
  path = regs_path()
  backup = FILE.load(path, binary=True) if FILE.exists(path) else None
  if text.startswith("﻿"): text = text[1:] # spreadsheets add a BOM
  # Bytes with normalised newlines: a text-mode write translates them, so a
  # CRLF source would land as \r\r\n.
  FILE.save(path, text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8"))
  try:
    regs = load_regs()
    if regs: return regs
  except Exception as e:
    log.err(f"Register map rejected | {e}")
  if backup is None: FILE.remove(path)
  else: FILE.save(path, backup)
  return None
