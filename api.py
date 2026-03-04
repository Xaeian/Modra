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

  def disconnect(self) -> dict:
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

  def read(self) -> dict|None:
    return link.read()

  def sync(self) -> dict:
    link.force_sync()
    return {"ok": True}

  def write(self, data:dict) -> dict|None:
    try:
      return link.write(data)
    except Exception as e:
      return {"error": str(e)}

  def set_config(self, data:dict) -> dict:
    try:
      result = link.write(data)
      return result if result is not None else {}
    except Exception as e:
      return {"error": str(e)}

  #------------------------------------------------------------------------------------- Store

  def history(
    self, table:str, names:list, day:str=None,
    t0:float=None, t1:float=None, limit:int=2000,
  ) -> list[dict]:
    try:
      return link._run(
        link.store.history(table, names, day, t0, t1, limit),
        timeout=10,
      ) or []
    except Exception as e:
      return []

  def history_range(
    self, table:str, names:list,
    day_from:str, day_to:str=None, limit:int=2000,
  ) -> list[dict]:
    try:
      return link._run(
        link.store.history_range(table, names, day_from, day_to, limit),
        timeout=10,
      ) or []
    except Exception as e:
      return []

  def days(self) -> list[str]:
    return link.store.list_days()

if __name__ == "__main__":
  import webview
  api = Api()
  window = webview.create_window("WebModbus", url="index.html", js_api=api)
  webview.start(debug=True)