from link import ModbusLink
from xaeian import Print
import config

log = Print()

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

  def serial(self) -> dict:
    return {
      "port": link.state.get("port", ""),
      "addr": link.state.get("addr", 1),
      "baudrate": link.state.get("baudrate", 9600),
      "parity": link.state.get("parity", "N"),
      "stopbits": link.state.get("stopbits", 1),
      "timeout": link.state.get("timeout", 1000),
      "retries": link.state.get("retries", 3),
      "interval": link.state.get("interval", 200),
    }

  def config(self) -> dict:
    if not link.mb: return {}
    return link.mb.decode(rws_filter=["RWs"])

  #--------------------------------------------------------------------------------- Connection

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

  #--------------------------------------------------------------------------------------- Data

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
    cache = link.read()
    result = {
      "data": cache,
      "connected": link.connected,
      "serial_open": link.serial_open,
      "port": link.mb.port if link.mb and link.serial_open else None,
      "addr": link.mb.addr if link.mb and link.connected else None,
    }
    if isinstance(params, dict):
      since = params.get("since")
      names = params.get("names")
      limit = params.get("limit")
    else:
      since = names = limit = None
    addr = result.get("addr")
    if not addr and link.state.get("addr"):
      addr = int(link.state["addr"])
    if since is not None and names and addr:
      try: limit = min(int(limit or 5000), 50000)
      except (ValueError, TypeError): limit = 5000
      try: since = float(since)
      except (ValueError, TypeError): since = 0.0
      rows = link.run_async(
        link.store.since(addr, names, since, limit),
        timeout=10,
      )
      result["rows"] = rows or []
    return result

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

  #----------------------------------------------------------------------------- Monitor config

  def monitor_load(self) -> list:
    return config.load_monitor()

  def monitor_save(self, data=None) -> dict:
    if not isinstance(data, list):
      return {"error": "Expected list"}
    try:
      config.save_monitor(data)
      return {"ok": True}
    except Exception as e:
      return {"error": str(e)}

if __name__ == "__main__":
  from xaeian import file_context, PATH
  import webview
  webview.settings['ALLOW_DOWNLOADS'] = True
  with file_context(bundle=True):
    api = Api()
    window = webview.create_window("Modra",
      url=PATH.resolve("index.html"),
      js_api=api,
    )
    webview.start(debug=False)
    link.close()