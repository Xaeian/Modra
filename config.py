"""
Backend config: serial.ini (connection + `simulator` flag), regs.csv path,
view.json (monitor panels + ignore list). Factory for ModbusMaster bound
to current on-disk state.
"""

from modbus import ModbusMaster
from xaeian import INI, JSON

STATE_FILE = "serial.ini"
REGS_FILE = "regs.csv"
VIEW_FILE = "view.json"

# `simulator=true` swaps the real serial client for sim.py so the stack
# runs unchanged without hardware. Switchable via serial.ini, no rebuild.
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
  "simulator": False,
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

#--------------------------------------------------------------------------------- View (UI state)

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

#--------------------------------------------------------------------------- ModbusMaster wire

def create_mb(state:dict, view:dict=None, port:str=None) -> ModbusMaster:
  """ModbusMaster bound to current state + `view.ignore`. Ignore is applied
  inside `mb.read()`; the map itself stays complete so the DB schema covers
  every register. `view=None` lets CLI tools skip view.json lookup."""
  if view is None: view = load_view()
  return ModbusMaster(
    port=port or str(state.get("port", "")),
    regmap_file=REGS_FILE,
    addr=_int(state.get("addr"), 1),
    baudrate=_int(state.get("baudrate"), 9600),
    parity=str(state.get("parity", "N")),
    stopbits=_int(state.get("stopbits"), 1),
    timeout=_int(state.get("timeout"), 1000) / 1000,
    retries=_int(state.get("retries"), 3),
    ignore_set=set(view.get("ignore", [])),
    sim=_bool(state.get("simulator"), False),
  )

def load_regs(state:dict=None, view:dict=None) -> list[dict]:
  """Full register catalog (ignored entries included; frontend hides them)."""
  if state is None: state = load_state()
  if view is None: view = load_view()
  return create_mb(state, view).regs_info()
