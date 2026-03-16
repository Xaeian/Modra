from modbus import ModbusMaster
from xaeian import INI

STATE_FILE = "serial.ini"
REG_FILE = "reg.csv"

STATE_DEFAULT = {
  "port": "COM3",
  "addr": 1,
  "baudrate": 9600,
  "parity": "N",
  "stopbits": 1,
  "timeout": 1000,
  "retries": 3,
  "interval": 500,
}

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

def create_mb(state:dict, port:str=None) -> ModbusMaster:
  return ModbusMaster(
    port=port or str(state.get("port", "")),
    regmap_file=REG_FILE,
    addr=_int(state.get("addr"), 1),
    baudrate=_int(state.get("baudrate"), 9600),
    parity=str(state.get("parity", "N")),
    stopbits=_int(state.get("stopbits"), 1),
    timeout=_int(state.get("timeout"), 1000) / 1000,
    retries=_int(state.get("retries"), 3),
  )

def load_regs(state:dict=None) -> list[dict]:
  """Parse reg.csv via temporary ModbusMaster."""
  if state is None: state = load_state()
  return create_mb(state).regs_info()