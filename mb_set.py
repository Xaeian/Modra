"""
CLI: quick motor control.

  mb_set off - motor off
  mb_set ai - analog input mode
  mb_set 1500rpm - speed setpoint
  mb_set 75% - duty setpoint
  mb_set 50hz - frequency setpoint
"""

import sys, asyncio
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
    log.wrn(USAGE); return
  mode, setpoint = parse_arg(sys.argv[1])
  if mode is None:
    log.wrn(USAGE); return
  state = config.load_state()
  mb = config.create_mb(state)
  await mb.write({"Ctrl": {"Mode": mode, "Setpoint": setpoint}})
  if mode in ("off", "ai"):
    log.inf(f"Motor mode {c.SKY}{mode}{c.END}")
  else:
    log.inf(f"Motor setpoint {c.SKY}{setpoint}{mode}{c.END}")

if __name__ == "__main__":
  asyncio.run(main())