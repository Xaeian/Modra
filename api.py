"""
Frontend-facing API surface. Each method is callable from pywebview
(`js_api=api`) and from serve.py as a JSON HTTP handler. Returns
JSON-safe dicts; errors become `{"error": str}`.
"""

import config
from link import ModbusLink

link = ModbusLink()

class Api:

  def status(self) -> dict:
    return {
      "ports": link.ports,
      "port": link.mb.port if link.mb and link.serial_open else None,
      "serial_open": link.serial_open,
      "connected": link.connected,
      "addr": link.mb.addr if link.mb and link.connected else None,
    }

  def info(self) -> list[dict]:
    return link.regs

  def set_map(self, params:dict=None) -> dict:
    """Take a register map from the frontend. With no map next to the app there
    is nothing to generate a UI from, so the frontend asks for one and sends it
    here on first run."""
    if not isinstance(params, dict):
      return {"error": "Expected dict"}
    text = params.get("text")
    if not isinstance(text, str) or not text.strip():
      return {"error": "Empty file"}
    try:
      if not link.set_map(text):
        return {"error": "Not a usable register map"}
      return {"ok": True, "count": len(link.regs)}
    except Exception as e:
      return {"error": str(e)}

  def serial(self) -> dict:
    return {
      "port": link.state.get("port", ""),
      "addr": link.state.get("addr", 1),
      "baudrate": link.state.get("baudrate", 9600),
      "parity": link.state.get("parity", "N"),
      "stopbits": link.state.get("stopbits", 1),
      "timeout": link.state.get("timeout", 1000),
      "retries": link.state.get("retries", 3),
      "interval": link.state.get("interval", 500),
      "history": link.state.get("history", 14),
      "autosend": config._bool(link.state.get("autosend"), False),
    }

  #------------------------------------------------------------------------------------- Connection

  def scan(self) -> dict:
    try:
      link.scan()
    except Exception as e:
      return {"error": str(e), **self.status()}
    return self.status()

  def connect(self, params:dict=None) -> dict:
    if not isinstance(params, dict):
      return {"error": "Expected dict", **self.status()}
    port = str(params.get("port", "") or "")
    if not port:
      return {"error": "Missing 'port'", **self.status()}
    addr = params.get("addr")
    if addr is not None:
      try: addr = int(addr)
      except (ValueError, TypeError):
        return {"error": f"Invalid addr: {addr}", **self.status()}
    ser_params = {k: params[k] for k in
      ("baudrate", "parity", "stopbits", "timeout", "retries", "interval")
      if k in params}
    try:
      if ser_params:
        link.set_serial(ser_params)
      if not link.connect(port):
        return {"error": f"Failed to open {port}", **self.status()}
      if addr is not None:
        link.set_addr(addr)
        if not link.connected:
          link.disconnect()
          return {"error": f"No response from addr:{addr}", **self.status()}
    except Exception as e:
      link.disconnect()
      return {"error": str(e), **self.status()}
    return self.status()

  def disconnect(self, _=None) -> dict:
    try:
      link.disconnect()
    except Exception as e:
      return {"error": str(e), **self.status()}
    return self.status()

  def set_addr(self, params=None) -> dict:
    if isinstance(params, dict): params = params.get("addr")
    try: addr = int(params)
    except (ValueError, TypeError):
      return {"error": f"Invalid addr: {params}", **self.status()}
    try:
      link.set_addr(addr)
    except Exception as e:
      return {"error": str(e), **self.status()}
    if not link.connected:
      return {"error": f"No response from addr:{addr}", **self.status()}
    return self.status()

  def set_serial(self, params:dict=None) -> dict:
    if not isinstance(params, dict):
      return {"error": "Expected dict"}
    try:
      link.set_serial(params)
    except Exception as e:
      return {"error": str(e)}
    return self.serial()

  #------------------------------------------------------------------------------------------- Data

  def scan_addrs(self, params=None) -> dict:
    if isinstance(params, dict): params = params.get("addrs")
    if not isinstance(params, list):
      return {"error": "Expected list", "found": []}
    try:
      found = link.scan_addrs([int(a) for a in params])
      return {"found": found}
    except Exception as e:
      return {"error": str(e), "found": []}

  def read(self, params:dict=None) -> dict:
    result = {
      "data": link.read(),
      "connected": link.connected,
      "serial_open": link.serial_open,
      "port": link.mb.port if link.mb and link.serial_open else None,
      "addr": link.mb.addr if link.mb and link.connected else None,
    }
    if isinstance(params, dict):
      result.update(self._history(params))
    return result

  @staticmethod
  def _history(params:dict) -> dict:
    """Chart rows + tier for a read that asked for a time window. Served from
    the DB, so it works with no device connected."""
    frm, to, names = params.get("from"), params.get("to"), params.get("names")
    addr = link.store_key()
    if frm is None or to is None or not names or not addr: return {}
    try: max_points = int(params.get("max_points") or 2000)
    except (ValueError, TypeError): max_points = 2000
    rows = link.run_async(
      link.store.query(addr, names, frm, to, max_points, link.history_days()),
      timeout=10,
    )
    return {
      "rows": rows or [],
      "tier": link.store.tier_label(frm, to, max_points, link.history_days()),
    }

  def sync(self) -> dict:
    if not link.connected:
      return {"error": "Not connected"}
    link.force_sync()
    return {"ok": True}

  def write(self, data:dict=None) -> dict:
    if not isinstance(data, dict) or not data:
      return {"error": "Expected non-empty dict"}
    try:
      result = link.write(data)
      if result is None:
        return {"error": "Write failed"}
      return result
    except Exception as e:
      return {"error": str(e)}

  #------------------------------------------------------------------------------------- View state

  def view_get(self) -> dict:
    return link.view

  def view_set(self, data=None) -> dict:
    """Patch the view. Missing keys stay - lets the frontend send a sparse
    `{ignore: [...]}` without echoing the whole document."""
    if not isinstance(data, dict):
      return {"error": "Expected dict"}
    monitor = data.get("monitor")
    ignore = data.get("ignore")
    ask_map = data.get("ask_map")
    if monitor is not None and not isinstance(monitor, list):
      return {"error": "monitor must be list"}
    if ignore is not None and not isinstance(ignore, list):
      return {"error": "ignore must be list"}
    if ask_map is not None and not isinstance(ask_map, bool):
      return {"error": "ask_map must be bool"}
    try:
      view = link.update_view(monitor=monitor, ignore=ignore, ask_map=ask_map)
      return {"ok": True, "view": view}
    except Exception as e:
      return {"error": str(e)}

  #--------------------------------------------------------------------------------------- Database

  def delete_database(self, _=None) -> dict:
    """Wipe all stored poll history. Rebuilds an empty DB on next write."""
    try:
      if link.reset_database():
        return {"ok": True}
      return {"error": "Could not delete data.db (file in use)"}
    except Exception as e:
      return {"error": str(e)}

if __name__ == "__main__":
  from xaeian import file_context, PATH
  import webview
  webview.settings["ALLOW_DOWNLOADS"] = True
  with file_context(bundle=True):
    api = Api()
    window = webview.create_window("Modra",
      url=PATH.resolve("index.html"),
      js_api=api,
    )
    webview.start(debug=False)
    link.close()