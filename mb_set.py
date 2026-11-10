"""
CLI: quick motor control.

  mb_set off - motor off
  mb_set ai - analog input mode
  mb_set 1500rpm - speed setpoint
  mb_set 75% - duty setpoint
  mb_set 50hz - frequency setpoint
"""

import sys, asyncio, math
from pymodbus.exceptions import ModbusException
from xaeian import Print, Color as c
import config

log = Print()

USAGE = "Usage: py mb_set.py {off|ai|<val>rpm|<val>%|<val>hz}"

def parse_arg(value:str) -> tuple:
  value = value.strip().lower()
  if value in ("off", "0"): return "off", 0
  if value == "ai": return "ai", 0
  if value.endswith("%"): return "%", float(value[:-1])
  if value.endswith("rpm"): return "rpm", float(value[:-3])
  if value.endswith("hz"): return "Hz", float(value[:-2])
  return None, None

async def main():
  if len(sys.argv) < 2:
    log.err(USAGE); sys.exit(1)
  try: mode, setpoint = parse_arg(sys.argv[1])
  except ValueError: mode = setpoint = None
  if mode is None or not math.isfinite(setpoint):
    log.err(USAGE); sys.exit(1)
  state = config.load_state()
  mb = config.create_mb(state)
  data = {"Ctrl": {"Mode": mode, "Setpoint": setpoint}}
  if not await mb.write(data):
    log.err(f"No writable Ctrl:Mode in {config.regs_path()}"); sys.exit(1)
  back = await mb.read(data, grouped=False)
  if back.get("Ctrl:Mode") != mode:
    log.err(f"Motor mode {back.get('Ctrl:Mode')}, not {mode}"); sys.exit(1)
  if mode in ("off", "ai"):
    log.inf(f"Motor mode {c.SKY}{mode}{c.END}")
  else:
    log.inf(f"Motor setpoint {c.SKY}{back['Ctrl:Setpoint']}{mode}{c.END}")

if __name__ == "__main__":
  # Only what the user can fix: a bad file or value, a dead port, a silent or refusing device
  try: asyncio.run(main())
  except (OSError, RuntimeError, ValueError, ModbusException) as e:
    log.err(str(e)); sys.exit(1)