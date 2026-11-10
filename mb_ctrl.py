"""
CLI: device ↔ config file admin tool.

  mb_ctrl import [file] - device → file (.ini default, .csv supported), as the app exports it
  mb_ctrl export [file] - file → device, read-only rows skipped
  mb_ctrl sudo - unlock via config.AUTH_KEY (the app does this itself)
"""

import sys, asyncio, os
from pymodbus.exceptions import ModbusException
from xaeian import INI, CSV, Print, Color as c
import config

log = Print()

def _config_regs(catalog:list) -> list:
  """What a config file carries: every RWs value, after the `info` registers."""
  info = [r for r in catalog if config.is_info(r.get("info"))]
  rws = [r for r in catalog if r["rws"] == "RWs" and not config.is_info(r.get("info"))]
  return info + rws

def _value(r:dict, values:dict):
  """A value as the app writes it: a hex word as the grid shows it, a whole float as an int."""
  v = values.get(r["name"])
  if v is not None and r["type"] == "hex": return f"0x{int(v):04X}"
  return int(v) if isinstance(v, float) and v.is_integer() else v

def _joined(cell, sep:str) -> str:
  """A map cell as text: a list joined by `sep`, `None` as empty."""
  if isinstance(cell, list): return sep.join(map(str, cell))
  return "" if cell is None else str(cell)

async def main():
  if len(sys.argv) < 2:
    log.err("Usage: py mb_ctrl.py {import|export|sudo} [file]"); sys.exit(1)

  state = config.load_state()
  mb = config.create_mb(state)
  action = sys.argv[1].lower()

  match action:

    case "import" | "imp":
      file = sys.argv[2] if len(sys.argv) > 2 else "config.ini"
      await mb.connect()
      await mb.sync()
      await mb.disconnect()
      # The file the app exports. The catalog joins 32-bit pairs into one entry, as the values do.
      regs = _config_regs(mb.regs_info())
      values = mb.decode(grouped=False)
      ext = os.path.splitext(file)[1].lstrip(".").lower()
      if ext == "csv":
        rows = []
        for r in regs:
          rows.append({
            "id": _joined(r["id"], ","), "hex": _joined(r["hex"], ","), "name": r["name"],
            "value": _value(r, values), "unit": _joined(r["unit"], "/"), "desc": r["desc"] or "",
          })
        CSV.save(file, rows, ["id", "hex", "name", "value", "unit", "desc"])
      else:
        data = {}
        for r in regs:
          group, _, key = r["name"].partition(":")
          value = _value(r, values)
          unit = _joined(r["unit"], "/")
          entry = (value, unit) if unit else value
          if key: data.setdefault(group, {})[key] = entry
          else: data[group] = entry
        INI.save(file, data)
      log.inf(f"{file} {c.TURQUS}<<{c.END} Motor")

    case "export" | "exp":
      file = sys.argv[2] if len(sys.argv) > 2 else "config.ini"
      if not os.path.exists(file):
        log.err(f"File not found: {file}"); sys.exit(1)
      ext = os.path.splitext(file)[1].lstrip(".").lower()
      if ext == "csv":
        rows = CSV.load(file)
        data = {r["name"]: r["value"] for r in rows
          if r.get("name") and r.get("value") not in (None, "")}
      else:
        data = INI.load(file) or {}
      await mb.connect()
      count = await mb.write(data)
      await mb.disconnect()
      # Unknown names and read-only rows are skipped, so a file can hold nothing to write
      if not count: log.err(f"{file}: nothing writable for this map"); sys.exit(1)
      log.inf(f"{file} {c.TURQUS}>>{c.END} Motor")

    case "sudo" | "su":
      if config.AUTH_KEY is None:
        log.err("No key: set config.AUTH_KEY"); sys.exit(1)
      await mb.connect()
      if not await mb.write({config.AUTH_KEY_REG: config.AUTH_KEY}):
        log.err(f"No writable {config.AUTH_KEY_REG} in {config.regs_path()}"); sys.exit(1)
      # The device publishes the level on its own clock, so it may trail the key: wait up to 1s
      for _ in range(10):
        level = (await mb.read([config.AUTH_LEVEL_REG], grouped=False)).get(config.AUTH_LEVEL_REG)
        if level == config.AUTH_LEVEL: break
        await asyncio.sleep(0.1)
      await mb.disconnect()
      if level != config.AUTH_LEVEL:
        log.err(f"Unlock unconfirmed, {config.AUTH_LEVEL_REG} reads {level}"); sys.exit(1)
      log.ok(f"You are {c.TURQUS}{config.AUTH_LEVEL}{c.END} now")

    case _:
      log.err(f"Unknown action: {action}"); sys.exit(1)

if __name__ == "__main__":
  # Only what the user can fix: a bad file or value, a dead port, a silent or refusing device
  try: asyncio.run(main())
  except (OSError, RuntimeError, ValueError, ModbusException) as e:
    log.err(str(e)); sys.exit(1)