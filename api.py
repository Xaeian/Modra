from link import ModbusLink
from xaeian import Print
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
      "addr": link.state.get("addr", ""),
      "baudrate": link.state.get("baudrate", 9600),
      "parity": link.state.get("parity", "N"),
      "stopbits": link.state.get("stopbits", 1),
      "timeout": link.state.get("timeout", 1000),
      "interval": link.state.get("interval", 200),
    }

  def config(self) -> dict:
    if not link.mb: return {}
    return link.mb.decode(rws_filter=["RWs"])

  #-------------------------------------------------------------------------------- Connection

  def scan(self) -> dict:
    try:
      link.scan()
    except Exception as e:
      return {"error": str(e), **self.status()}
    return self.status()

  def connect(self, port:str) -> dict:
    try:
      if not link.connect(port):
        return {"error": f"Failed to open {port}", **self.status()}
    except Exception as e:
      return {"error": str(e), **self.status()}
    return self.status()

  def disconnect(self, _=None) -> dict:
    try:
      link.disconnect()
    except Exception as e:
      return {"error": str(e), **self.status()}
    return self.status()

  def set_addr(self, addr:int) -> dict:
    try:
      link.set_addr(addr)
    except Exception as e:
      return {"error": str(e), **self.status()}
    if not link.connected:
      return {"error": f"No response from addr:{addr}", **self.status()}
    return self.status()

  def set_serial(self, params:dict) -> dict:
    try:
      link.set_serial(params)
    except Exception as e:
      return {"error": str(e), **self.serial()}
    return self.serial()

  #-------------------------------------------------------------------------------------- Data

  def scan_addrs(self, addrs:list) -> list:
    try:
      return link.scan_addrs([int(a) for a in addrs])
    except Exception as e:
      log.wrn(f"scan_addrs: {e}")
      return []

  def read(self) -> dict:
    cache = link.read()
    return {
      "data": cache,
      "connected": link.connected,
      "serial_open": link.serial_open,
      "port": link.mb.port if link.mb and link.serial_open else None,
      "addr": link.mb.addr if link.mb and link.connected else None,
    }

  def sync(self) -> dict:
    link.force_sync()
    return {"ok": True}

  def write(self, data:dict) -> dict:
    """Write registers. Used for both direct writes and config changes."""
    try:
      result = link.write(data)
      return result if result is not None else {}
    except Exception as e:
      return {"error": str(e)}

  #------------------------------------------------------------------------------------- Store

  def history(self, names:list, t0:float=None, t1:float=None, limit:int=2000) -> list[dict]:
    if not link.mb or not link.connected: return []
    try:
      return link.run_async(
        link.store.history(link.mb.addr, names, t0, t1, limit),
        timeout=10,
      ) or []
    except Exception:
      return []

if __name__ == "__main__":
  import webview
  api = Api()
  window = webview.create_window("WebModbus", url="index.html", js_api=api)
  webview.start(debug=True)
  link.close()