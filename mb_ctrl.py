# mb_ctrl.py

import sys, asyncio, os
from xaeian import INI, CSV, Print, Color as c
import config

p = Print()

SUDO_KEY = 0x5D8E41B3

async def main():
  if len(sys.argv) < 2:
    p.wrn("Usage: py mb_ctrl.py {import|export|sudo} [file]"); return

  state = config.load_state()
  mb = config.create_mb(state)
  action = sys.argv[1].lower()

  match action:

    case "import" | "imp":
      # device → file (RWs only)
      file = sys.argv[2] if len(sys.argv) > 2 else "config.ini"
      await mb.connect()
      await mb.sync()
      await mb.disconnect()
      ext = os.path.splitext(file)[1].lstrip(".").lower()
      if ext == "csv":
        data = mb.annotate(mb.decode(rws_filter=["RWs"], grouped=False), ["unit", "desc"])
        rows = [{"id": mb.name_map[k]["id"], "hex": mb.name_map[k]["hex"],
          "name": k, "value": v[0], "unit": v[1] or "", "desc": v[2] or ""}
          for k, v in data.items()]
        CSV.save(file, rows, ["id", "hex", "name", "value", "unit", "desc"])
      else:
        data = mb.annotate(mb.decode(rws_filter=["RWs"], grouped=True), ["unit"])
        INI.save(file, data)
      p.inf(f"{file} {c.TURQUS}<<{c.END} Motor")

    case "export" | "exp":
      # file → device (RW + RWs, filtered by library)
      file = sys.argv[2] if len(sys.argv) > 2 else "config.ini"
      if not os.path.exists(file):
        p.err(f"File not found: {file}"); return
      ext = os.path.splitext(file)[1].lstrip(".").lower()
      if ext == "csv":
        rows = CSV.load(file)
        data = {r["name"]: r["value"] for r in rows
          if r.get("name") and r.get("value") not in (None, "")}
      else:
        data = INI.load(file) or {}
      await mb.connect()
      await mb.write(data)
      await mb.disconnect()
      p.inf(f"{file} {c.TURQUS}>>{c.END} Motor")

    case "sudo" | "su":
      await mb.connect()
      await mb.write({"Auth:SecretKey": SUDO_KEY})
      await mb.disconnect()
      p.ok(f"You are {c.TURQUS}admin{c.END} now")

    case _:
      p.wrn(f"Unknown action: {action}")

if __name__ == "__main__":
  asyncio.run(main())