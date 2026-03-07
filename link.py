import asyncio
import threading
from time import time
from xaeian import Print, serial_scan, logger
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
    self.regs = config.load_regs(self.state)
    self.store = Store(self.regs)
    self._loop = asyncio.new_event_loop()
    self._mb_lock = asyncio.Lock()
    self._read_task = None
    self._sync_next = False
    self._write_pending = False
    self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
    self._thread.start()
    self.run_async(self.store.init())
    if self.state:
      log.inf(f"State loaded: {self.state}")
    else:
      log.wrn("No state file, starting fresh")
    self.scan(False)

  #----------------------------------------------------------------------------------- Internals

  def run_async(self, coro, timeout=30):
    """Run coroutine on internal event loop. Thread-safe."""
    try:
      future = asyncio.run_coroutine_threadsafe(coro, self._loop)
      return future.result(timeout=timeout)
    except Exception as e:
      log.err(f"Modbus: {e}")
      return None

  def close(self):
    """Graceful shutdown."""
    self._stop_reads()
    if self.mb:
      self.run_async(self.mb.disconnect())
    self._loop.call_soon_threadsafe(self._loop.stop)
    self._thread.join(timeout=2)
    log.inf("ModbusLink closed")

  def _init_mb(self, port:str):
    self.mb = config.create_mb(self.state, port)
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
      "interval": self.state.get("interval", 200),
    })
    config.save_state(self.state)
    log.inf("State saved")

  def _clear_cache(self):
    if self.mb:
      self.mb.cache_raw = {rid: None for rid in self.mb.id_map}

  #------------------------------------------------------------------------------- Read Loop

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
        await self.mb.sync()
        log.ok("Initial sync done")
      except Exception as e:
        log.wrn(f"Initial sync failed: {e}")
    while self.connected:
      t0 = time()
      if not self._write_pending:
        async with self._mb_lock:
          try:
            t_read = time()
            if self._sync_next:
              await self.mb.sync()
              self._sync_next = False
              log.inf(f"Sync done {(time()-t_read)*1000:.0f}ms")
            else:
              await self.mb.read()
              # log.inf(f"Read done {(time()-t_read)*1000:.0f}ms")
            errors = 0
            await self.store.log(self.mb.cache, self.mb.addr)
          except Exception as e:
            errors += 1
            log.wrn(f"Read error ({errors}): {e}")
            if errors >= 3:
              log.err("Too many read errors, disconnecting")
              self._clear_cache()
              self.connected = False
              return
      interval_s = int(self.state.get("interval", 200)) / 1000
      elapsed = time() - t0
      remaining = interval_s - elapsed
      if remaining > 0:
        try:
          await asyncio.sleep(remaining)
        except asyncio.CancelledError:
          return

  #-------------------------------------------------------------------------------- Connection

  def scan(self, mute:bool=True) -> list[str]:
    if not mute: log.run("Scanning ports")
    self.ports = serial_scan()
    if self.serial_open and self.mb and self.mb.port not in self.ports:
      log.wrn(f"Port {self.mb.port} disappeared")
      self._stop_reads()
      self._clear_cache()
      self.connected = False
      self.serial_open = False
    if not mute: log.inf(f"Ports: {self.ports}")
    return self.ports

  def connect(self, port:str) -> bool:
    """Open serial port (step 1)."""
    log.run(f"Open serial: {port}")
    if self.connected:
      self._stop_reads()
      self.connected = False
    if self.serial_open:
      self.run_async(self.mb.disconnect())
      self.serial_open = False
    self._clear_cache()
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
    if self.mb:
      self.run_async(self.mb.disconnect())
      self.mb = None
    self._clear_cache()

  def set_addr(self, addr:int):
    """Probe addr and start reads if OK (step 2)."""
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

  def set_serial(self, params:dict):
    changed = False
    for k in ("baudrate", "parity", "stopbits", "timeout", "interval"):
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

  #-------------------------------------------------------------------------------------- Data

  def read(self) -> dict|None:
    if not self.mb or not self.connected: return None
    return self.mb.cache

  def scan_addrs(self, addrs:list[int]) -> list[int]:
    """Scan addresses. Stops read loop during scan to avoid addr race."""
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
        t = time()
        await self.mb.write(data)
        log.ok(f"Write done {(time()-t)*1000:.0f}ms")
        for k, v in data.items():
          write_log.info(f"addr:{self.mb.addr} {k} = {v}")
        self._sync_next = True
        return self.mb.cache
      except Exception as e:
        log.err(f"Write error: {e}")
        return None