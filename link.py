"""
Thread+async wrapper around ModbusMaster. Owns the read loop, port scan,
write queue, SQLite store. Bridges sync Api callers (HTTP/webview) into
the async pymodbus client. `update_view()` rewires the poll filter on
ignore-set changes without dropping the connection.
"""

import asyncio
import threading
from xaeian import Print, Time, serial_scan, logger
import config
from store import Store

log = Print()
write_log = logger("write", file="write.log", stream=False)

class ModbusLink:

  def __init__(self):
    self.mb = None
    self.connected = False
    self.serial_open = False
    self.ports = []
    self.state = config.load_state()
    self.view = config.load_view()
    self.regs = config.load_regs(self.state, self.view)
    self.store = Store(self.regs)
    self._loop = asyncio.new_event_loop()
    self._mb_lock = asyncio.Lock()
    self._read_task = None
    self._sync_next = False
    self._write_pending = False
    self._port_miss = 0
    self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
    self._thread.start()
    self.run_async(self.store.init())
    if self.state:
      log.inf(f"State loaded: {self.state}")
    else:
      log.wrn("No state file, starting fresh")
    self.scan(False)

  #---------------------------------------------------------------------------------- Internals

  def run_async(self, coro, timeout=30):
    """Run coroutine on internal event loop. Thread-safe."""
    try:
      future = asyncio.run_coroutine_threadsafe(coro, self._loop)
      return future.result(timeout=timeout)
    except Exception as e:
      log.err(f"Modbus: {e}")
      return None

  def close(self):
    self._stop_reads()
    if self.mb:
      self.run_async(self.mb.disconnect())
    self._loop.call_soon_threadsafe(self._loop.stop)
    self._thread.join(timeout=2)
    log.inf("ModbusLink closed")

  def _init_mb(self, port:str):
    self.mb = config.create_mb(self.state, self.view, port)
    timeout = self.state.get("timeout", 1000)
    log.inf(f"ModbusMaster init port:{port} addr:{self.mb.addr}"
            f" baud:{self.mb.baudrate} timeout:{timeout}ms")

  def _save_state(self):
    if not self.mb: return
    self.state.update({
      "port": self.mb.port,
      "addr": self.mb.addr,
      "baudrate": self.mb.baudrate,
      "parity": self.mb.parity,
      "stopbits": self.mb.stopbits,
      "timeout": self.state.get("timeout", 1000),
      "retries": self.state.get("retries", 3),
      "interval": self.state.get("interval", 500),
    })
    config.save_state(self.state)
    log.inf("State saved")

  def _clear_cache(self):
    if self.mb:
      self.mb.cache_raw = {rid: None for rid in self.mb.id_map}

  #---------------------------------------------------------------------------------- Read Loop

  def _start_reads(self):
    if self._read_task and not self._read_task.done(): return
    self._sync_next = False
    self._read_task = asyncio.run_coroutine_threadsafe(
      self._read_loop(), self._loop,
    )
    log.inf("Read loop started")

  def _stop_reads(self):
    if self._read_task:
      self._read_task.cancel()
      self._read_task = None
    log.inf("Read loop stopped")

  async def _read_loop(self):
    errors = 0
    async with self._mb_lock:
      try:
        await self.mb.reconnect()
        await self.mb.read(rws_filter=["R", "RW", "RWs"])
        log.ok("Initial sync done")
      except Exception as e:
        log.wrn(f"Initial sync failed: {e}")
        try: await self.mb.reconnect()
        except Exception: pass
    while self.connected:
      t0 = Time()
      cache = None
      if not self._write_pending:
        async with self._mb_lock:
          try:
            t_read = Time()
            if self._sync_next:
              await self.mb.read(rws_filter=["R", "RW", "RWs"])
              self._sync_next = False
              log.inf(f"Sync done {(Time()-t_read).total_seconds()*1000:.0f}ms")
            else:
              await self.mb.read()
            errors = 0
            cache = self.mb.cache
          except Exception as e:
            errors += 1
            log.wrn(f"Read error ({errors}): {e}")
            try: await self.mb.reconnect()
            except Exception: pass
            if errors >= 5:
              log.err("Too many read errors, disconnecting")
              self._clear_cache()
              self.connected = False
              return
      if cache is not None:
        await self.store.log(cache, self.mb.addr)
      interval_s = int(self.state.get("interval", 500)) / 1000
      remaining = interval_s - (Time() - t0).total_seconds()
      if remaining > 0:
        try:
          await asyncio.sleep(remaining)
        except asyncio.CancelledError:
          return

  #--------------------------------------------------------------------------------- Connection

  def scan(self, mute:bool=True) -> list[str]:
    if not mute: log.run("Scanning ports")
    self.ports = serial_scan()
    # Sim mode advertises a "SIM" pseudo-port so the toolbar select has
    # something to pick. SimulatedClient ignores the port name anyway.
    if config._bool(self.state.get("simulator")) and "SIM" not in self.ports:
      self.ports = ["SIM"] + self.ports
    if self.serial_open and self.mb and self.mb.port not in self.ports:
      self._port_miss += 1
      if self._port_miss >= 3:
        log.wrn(f"Port {self.mb.port} disappeared ({self._port_miss} misses)")
        self._stop_reads()
        self._clear_cache()
        self.connected = False
        self.serial_open = False
        self._port_miss = 0
    else:
      self._port_miss = 0
    if not mute: log.inf(f"Ports: {self.ports}")
    return self.ports

  def connect(self, port:str) -> bool:
    """Open the serial port (step 1 of the connect handshake)."""
    log.run(f"Open serial: {port}")
    if self.connected:
      self._stop_reads()
      self.connected = False
    if self.serial_open:
      self.run_async(self.mb.disconnect())
      self.serial_open = False
    self._clear_cache()
    self._port_miss = 0
    self.state["port"] = port
    self._init_mb(port)
    if not self.run_async(self.mb.connect(), timeout=5):
      log.err(f"Serial open failed: {port}")
      return False
    self.serial_open = True
    self._save_state()
    log.ok(f"Serial open: {port}")
    return True

  def disconnect(self):
    log.run("Disconnect")
    self._stop_reads()
    self.connected = False
    self.serial_open = False
    self._port_miss = 0
    if self.mb:
      self.run_async(self.mb.disconnect())
      self.mb = None
    self._clear_cache()

  def set_addr(self, addr:int):
    """Probe addr and start the read loop on response (step 2)."""
    log.run(f"Set addr: {addr}")
    if not self.mb or not self.serial_open: return
    if self.connected:
      self._stop_reads()
      self.connected = False
      self._clear_cache()
    self.mb.addr = addr
    ok = self.run_async(self._probe_addr(addr), timeout=2)
    if not ok:
      log.err(f"No response from addr:{addr}")
      self._save_state()
      return
    self.connected = True
    self._save_state()
    self._start_reads()
    log.ok(f"Device connected addr:{addr}")

  def reload_mb(self):
    """Rebuild ModbusMaster after view.ignore changed. Preserves connection."""
    was_connected = self.connected
    was_serial = self.serial_open
    saved_port = self.mb.port if self.mb else None
    saved_addr = self.mb.addr if self.mb else None
    log.run("Reload mb: ignore changed")
    if was_connected:
      self._stop_reads()
      self.connected = False
    if was_serial and self.mb:
      self.run_async(self.mb.disconnect())
      self.serial_open = False
    self._clear_cache()
    self.regs = config.load_regs(self.state, self.view)
    self.store.reload(self.regs)
    if not saved_port:
      self.mb = None
      return
    self._init_mb(saved_port)
    if not was_serial: return
    if not self.run_async(self.mb.connect(), timeout=5):
      log.err(f"Reload: failed to reopen {saved_port}")
      return
    self.serial_open = True
    if not was_connected or saved_addr is None: return
    self.mb.addr = saved_addr
    if not self.run_async(self._probe_addr(saved_addr), timeout=2):
      log.err(f"Reload: no response from addr:{saved_addr}")
      return
    self.connected = True
    self._start_reads()
    log.ok(f"Reload done addr:{saved_addr}")

  def update_view(self, *, monitor=None, ignore=None) -> dict:
    """Patch + persist the view. Only an ignore-set change rebuilds the
    ModbusMaster; monitor edits don't affect the poll filter."""
    changed_filter = False
    if monitor is not None:
      self.view["monitor"] = monitor
    if ignore is not None and set(ignore) != set(self.view.get("ignore", [])):
      self.view["ignore"] = list(ignore)
      changed_filter = True
    config.save_view(self.view)
    if changed_filter: self.reload_mb()
    return self.view

  def set_serial(self, params:dict):
    changed = False
    for k in ("baudrate", "parity", "stopbits", "timeout", "retries", "interval"):
      if k in params:
        self.state[k] = params[k]
        if k in ("baudrate", "parity", "stopbits", "timeout"):
          changed = True
    if changed and self.serial_open:
      self._stop_reads()
      self.connected = False
      self.serial_open = False
      self.run_async(self.mb.disconnect())
      self._clear_cache()
      self._init_mb(self.mb.port)
      log.inf("Serial params changed, reconnect needed")
    self._save_state()

  #--------------------------------------------------------------------------------------- Data

  def read(self) -> dict|None:
    if not self.mb or not self.connected: return None
    return self.mb.cache

  def scan_addrs(self, addrs:list[int]) -> list[int]:
    """Probe each addr. Stops the read loop first to avoid addr races."""
    if not self.serial_open:
      log.wrn("scan_addrs: serial not open")
      return []
    was_connected = self.connected
    saved_addr = self.mb.addr if self.mb else None
    if was_connected:
      self._stop_reads()
    log.run(f"Scanning {len(addrs)} addresses")
    found = []
    for addr in addrs:
      if self.run_async(self._probe_addr(addr), timeout=2):
        found.append(addr)
    if was_connected and saved_addr is not None:
      self.mb.addr = saved_addr
      self._start_reads()
    log.ok(f"Scan done: {found}")
    return found

  async def _probe_addr(self, addr:int) -> bool:
    async with self._mb_lock:
      orig = self.mb.addr
      try:
        self.mb.addr = addr
        await self.mb.read_registers([0])
        return True
      except Exception:
        return False
      finally:
        self.mb.addr = orig

  def force_sync(self):
    self._sync_next = True

  def write(self, data:dict) -> dict|None:
    if not self.mb or not self.connected:
      log.wrn("Write but not connected")
      return None
    log.run(f"Write {len(data)} entries")
    result = self.run_async(self._async_write(data))
    if result is None:
      log.err("Write failed")
    return result

  async def _async_write(self, data:dict) -> dict|None:
    self._write_pending = True
    async with self._mb_lock:
      self._write_pending = False
      try:
        t = Time()
        await self.mb.write(data)
        log.ok(f"Write done {(Time()-t).total_seconds()*1000:.0f}ms")
        for k, v in data.items():
          write_log.info(f"addr:{self.mb.addr} {k} = {v}")
        self._sync_next = True
        return self.mb.cache
      except Exception as e:
        log.err(f"Write error: {e}")
        try: await self.mb.reconnect()
        except Exception: pass
        return None