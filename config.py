from modbus import ModbusMaster
from xaeian import INI

STATE_FILE = "serial.ini"
REG_FILE = "reg.csv"
DATA_DIR = "data"

def load_state() -> dict:
  return INI.load(STATE_FILE) or {}

def save_state(state:dict):
  INI.save(STATE_FILE, state)

def create_mb(state:dict, port:str=None) -> ModbusMaster:
  return ModbusMaster(
    port=port or state.get("port", ""),
    regmap_file=REG_FILE,
    addr=int(state.get("addr", 1)),
    baudrate=int(state.get("baudrate", 9600)),
    parity=state.get("parity", "N"),
    stopbits=int(state.get("stopbits", 1)),
    timeout=int(state.get("timeout", 1000)) / 1000,
    retries=int(state.get("retries", 1)),
  )

def load_regs(state:dict=None) -> list[dict]:
  """Parse reg.csv via temporary ModbusMaster."""
  if state is None: state = load_state()
  return create_mb(state).regs_info()