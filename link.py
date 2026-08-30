"""
Thread+async wrapper around ModbusMaster. Owns the read loop, port scan,
write queue, SQLite store, and the auto-unlock that holds the device at
`config.AUTH_LEVEL`. Bridges sync Api callers (HTTP/webview) into the
async pymodbus client. `update_view()` rewires the poll filter on
ignore-set changes without dropping the connection.
"""

import asyncio
import threading
from xaeian import Print, Time, logger
from xaeian.serial.port import serial_scan
import config
from store import Store

log = Print()
write_log = logger("write", file="write.log", stream=False)

# Modes pulled by a full sync (initial connect + forced Read). W joins only when
# config.READBACK_W is set; the regular poll reads "R".
SYNC_RWS = ["R", "RW", "RWs"] + (["W"] if config.READBACK_W else [])

# Trickle rides the idle tail of a poll: whatever the interval has left once the
# telemetry read is paid for, less a margin for jitter. MIN keeps RWs refreshing
# even when that read alone overruns the interval; MAX bounds how long one packet
# can hold the bus against a pending write.
TRICKLE_SPARE = 0.75
TRICKLE_OVERHEAD = 20
TRICKLE_MIN_REGS = 8
TRICKLE_MAX_REGS = 128
TRICKLE_ERR_LIMIT = 3
TRICKLE_BACKOFF_TICKS = 5

# A burst of read errors marks the device unreachable but never tears the read
# loop down: it keeps retrying at RETRY_INTERVAL_S, so a transient bus glitch
# (EMI, a nudged connector, a slave that missed a frame) recovers on its own.
READ_ERR_LIMIT = 5
RETRY_INTERVAL_S = 2.0

# Auto-unlock cadence (see `_auth`): at most one key write per interval, and a
# stop after this many failures in a row, so a stale key is not a write storm.
AUTH_RETRY_S = 5.0
AUTH_FAIL_LIMIT = 3

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
    # Sim state lives at link level so it survives mb rebuilds (ignore
    # toggle, serial params change, port change). Without this, every
    # rebuild reseeds the random walk and traces visibly jump.
    self._sim_client = None
    # Simulator mode, mirrored from the active port (refreshed in _init_mb).
    self._sim = (str(self.state.get("port", "")) == "SIM")
    # Background trickle-refresh state (see _trickle).
    self._trickle_built = False
    self._trickle_hot = []
    self._trickle_runs = []
    self._trickle_run = 0
    self._trickle_pos = 0
    self._trickle_errors = 0
    self._trickle_backoff = 0
    # Auto-unlock state (see _auth).
    self._auth_at = None
    self._auth_tried = False
    self._auth_fails = 0
    self._last_prune = Time()
    self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
    self._thread.start()
    self.run_async(self.store.init())
    # Prune once at boot so an oversized DB is trimmed to the retention window.
    self.run_async(self.store.prune(self.history_days()))
    if self.state:
      log.inf(f"State loaded: {self.state}")
    else:
      log.wrn("No state file, starting fresh")
    self.scan(False)

  #-------------------------------------------------------------------------------------- Internals

  def history_days(self) -> int:
    """Retention window in days from state; 14 on missing/garbage value."""
    try:
      return int(self.state.get("history", 14) or 14)
    except (ValueError, TypeError):
      return 14

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
    self._sim = (port == "SIM")
    # Rebuild the trickle plan for the new register set, clear its backoff.
    self._trickle_built = False
    self._trickle_errors = self._trickle_backoff = 0
    timeout = self.state.get("timeout", 1000)
    log.inf(f"ModbusMaster init port:{port} addr:{self.mb.addr}"
      f" baud:{self.mb.baudrate} timeout:{timeout}ms")
    if self._sim:
      # Held across reconnects, so the simulated device does not forget its
      # values whenever the port reopens. Which kind it is stays config's call.
      self._sim_client = config.sim_client(self.mb, self._sim_client)
      self.mb.client = self._sim_client

  def _save_state(self):
    if not self.mb: return
    self.state.update({
      "port": self.mb.port,
      "addr": self.mb.addr,
      "baudrate": self.mb.baudrate,
      "parity": self.mb.parity,
      "stopbits": self.mb.stopbits,
    })
    config.save_state(self.state)
    log.inf("State saved")

  def _clear_cache(self):
    if self.mb:
      self.mb.cache_raw = {rid: None for rid in self.mb.id_map}

  #-------------------------------------------------------------------------------------- Read Loop

  def _start_reads(self):
    if self._read_task and not self._read_task.done(): return
    self._sync_next = False
    self._auth_reset()
    self._read_task = asyncio.run_coroutine_threadsafe(
      self._read_loop(), self._loop,
    )
    log.inf("Read loop started")

  def _stop_reads(self):
    if self._read_task:
      self._read_task.cancel()
      self._read_task = None
    log.inf("Read loop stopped")

  def _sync_ids(self) -> list[int]:
    """Full-read set. Ignore drops a register from the poll cycle; a writable one
    is still read here, since a value you cannot see is one you cannot edit."""
    ignored = self.mb.resolved_ignored_ids()
    return [rid for rid, e in self.mb.id_map.items()
      if e["rws"] in SYNC_RWS and not (rid in ignored and e["rws"] == "R")]

  async def _read_loop(self):
    errors = 0
    slow_warned = False
    async with self._mb_lock:
      try:
        await self.mb.reconnect()
        await self.mb.read_registers(self._sync_ids())
        log.ok("Initial sync done")
      except Exception as e:
        log.wrn(f"Initial sync failed: {e}")
        try: await self.mb.reconnect()
        except Exception: pass
    # Only cancellation (`_stop_reads`) ends this loop. `connected` reports
    # whether the device answers; it never decides whether to keep trying.
    while True:
      t0 = Time()
      interval_s = int(self.state.get("interval", 500)) / 1000
      cache = None
      did_sync = False
      if not self._write_pending:
        async with self._mb_lock:
          try:
            t_read = Time()
            if self._sync_next:
              await self.mb.read_registers(self._sync_ids())
              self._sync_next = False
              did_sync = True
              log.inf(f"Sync done {(Time()-t_read).total_seconds()*1000:.0f}ms")
            else:
              await self.mb.read()
            if not self.connected:
              self.connected = True
              log.ok("Device reachable again")
            errors = 0
          except Exception as e:
            errors += 1
            log.wrn(f"Read error ({errors}): {e}")
            try: await self.mb.reconnect()
            except Exception: pass
            if errors >= READ_ERR_LIMIT and self.connected:
              log.err("Too many read errors, device unreachable")
              self._clear_cache()
              self.connected = False
        if errors == 0:
          await self._auth()
          # A full sync already refreshed everything; trickle only on plain polls,
          # and only into whatever the telemetry read left of the interval.
          if not did_sync:
            await self._trickle(interval_s - (Time() - t0).total_seconds())
          cache = self.mb.cache
      if cache is not None:
        await self.store.log(cache, self.store_key())
      # Retention + downsampling run on the same loop between polls, once a
      # minute. Prune only deletes the ~60s that just aged out; roll only
      # aggregates the minute bucket that just completed - both stay cheap.
      if (Time() - self._last_prune).total_seconds() >= 60:
        self._last_prune = Time()
        await self.store.prune(self.history_days())
        await self.store.roll(self.store_key())
      # While unreachable, slow the retry cadence instead of hammering the port.
      if not self.connected: interval_s = max(interval_s, RETRY_INTERVAL_S)
      remaining = interval_s - (Time() - t0).total_seconds()
      # The bus is the floor: say so once, rather than silently missing the rate.
      if remaining < 0 and self.connected and not slow_warned:
        slow_warned = True
        log.wrn(f"Poll needs {(Time()-t0).total_seconds()*1000:.0f}ms, "
          f"interval is {interval_s*1000:.0f}ms")
      if remaining > 0:
        try:
          await asyncio.sleep(remaining)
        except asyncio.CancelledError:
          return

  #---------------------------------------------------------------------------------------- Trickle

  def _build_trickle(self):
    """Split non-ignored writable registers into the volatile hot set (RW, read
    every tick) and contiguous RWs runs, so each cold packet is one Modbus block."""
    self._trickle_hot = []
    cold = []
    if self.mb:
      ignored = self.mb.resolved_ignored_ids()
      for rid, e in self.mb.id_map.items():
        if rid in ignored: continue
        if e["rws"] == "RW": self._trickle_hot.append(rid)
        elif e["rws"] == "RWs": cold.append(rid)
    self._trickle_hot.sort()
    self._trickle_runs = []
    for rid in sorted(cold):
      if self._trickle_runs and rid == self._trickle_runs[-1][-1] + 1:
        self._trickle_runs[-1].append(rid)
      else:
        self._trickle_runs.append([rid])
    self._trickle_run = self._trickle_pos = 0
    self._trickle_built = True

  def _trickle_budget(self, spare_s:float) -> int:
    """Registers that fit the idle time this tick has left, at the current baud."""
    baud = self.mb.baudrate if self.mb else 9600
    fit = int((TRICKLE_SPARE * max(spare_s, 0) * baud / 10 - TRICKLE_OVERHEAD) / 2)
    return max(TRICKLE_MIN_REGS, min(TRICKLE_MAX_REGS, fit))

  async def _trickle(self, spare_s:float):
    """One trickle step: re-read the volatile RW plus the next contiguous RWs
    packet. Best-effort - own error budget that never trips the disconnect
    counter, and yields to writes and forced syncs."""
    if not config.TRICKLE or not self.connected: return
    if self._sync_next or self._write_pending: return
    if self._trickle_backoff > 0:
      self._trickle_backoff -= 1
      return
    if not self._trickle_built:
      self._build_trickle()
    ids = list(self._trickle_hot)
    take = 0
    if self._trickle_runs:
      take = self._trickle_budget(spare_s)
      run = self._trickle_runs[self._trickle_run]
      ids += run[self._trickle_pos:self._trickle_pos + take]
    if not ids: return
    try:
      async with self._mb_lock:
        await self.mb.read_registers(ids)
      self._trickle_errors = 0
      # Advance past a packet only once it lands, so a failed read is retried
      # instead of leaving a hole until the next sweep comes round.
      if take:
        self._trickle_pos += take
        if self._trickle_pos >= len(self._trickle_runs[self._trickle_run]):
          self._trickle_run = (self._trickle_run + 1) % len(self._trickle_runs)
          self._trickle_pos = 0
    except Exception:
      self._trickle_errors += 1
      if self._trickle_errors >= TRICKLE_ERR_LIMIT:
        self._trickle_backoff = TRICKLE_BACKOFF_TICKS
        self._trickle_errors = 0
        log.wrn("Trickle: backing off after read errors")

  #----------------------------------------------------------------------------------------- Unlock

  def _auth_reset(self):
    """Fresh unlock budget, per connection: a device that comes back after a
    reboot is unlocked again even if the previous attempt gave up."""
    self._auth_at = None
    self._auth_tried = False
    self._auth_fails = 0

  def _auth_key(self) -> str|None:
    """Name to write the key under - a 32-bit `high=`/`low=` pair or a plain
    register - or None when auto-unlock is off or the map carries no such
    register.

    The simulator is not exempt. A map that declares access control declares it
    for every port: a simulated device that hands out admin for free would let
    a procedure pass here and fail on the bench, which is the one thing a
    simulator must never do."""
    if config.AUTH_KEY is None or not self.mb: return None
    name = config.AUTH_KEY_REG
    return name if (name in self.mb.pairs or name in self.mb.name_map) else None

  async def _auth(self):
    """Hold the device at `config.AUTH_LEVEL`, so nothing above has to think
    about access. Runs after every successful poll, which makes it self-healing:
    a drive that reboots back to guest is unlocked again on the next poll.
    That needs the level register polled; ignored, it gets one blind unlock.
    Best-effort - one write per AUTH_RETRY_S, and it gives up entirely after
    AUTH_FAIL_LIMIT failures, so a stale key never becomes a write storm."""
    name = self._auth_key()
    if not name or not self.connected or self._sync_next or self._write_pending: return
    if self._auth_fails >= AUTH_FAIL_LIMIT: return
    level = self.mb.name_map.get(config.AUTH_LEVEL_REG)
    enum = level.get("enum", {}) if level else {}
    # Enum codes ascend with privilege (guest < user < service < admin), so a
    # code below the wanted one means "not unlocked".
    want = next((k for k, v in enum.items() if v == config.AUTH_LEVEL), None)
    now = self.mb.cache_raw.get(level["id"]) if level else None
    if now is not None and want is not None:
      # Standing at the wanted level IS the proof the key works, whenever the
      # device got around to reporting it. Without clearing the budget here, an
      # unlock that lands one read late counts as a failure every time, and
      # enough re-locks would retire auto-unlock on a device it never failed on.
      if now >= want:
        self._auth_fails = 0
        return
    elif self._auth_tried:
      return # nothing to watch: the blind unlock already went out
    if self._auth_at and (Time() - self._auth_at).total_seconds() < AUTH_RETRY_S: return
    self._auth_at = Time()
    self._auth_tried = True
    try:
      async with self._mb_lock:
        await self.mb.write({name: config.AUTH_KEY})
        # The write reads back the key halves, not the level register; refresh
        # it here so the next poll sees the new level instead of re-arming.
        if level: await self.mb.read_registers([level["id"]])
    except Exception as e:
      self._auth_fails += 1
      log.wrn(f"Unlock failed ({self._auth_fails}): {e}")
      return
    if want is None:
      log.inf(f"Unlock key sent to {name}")
      return
    now = self.mb.cache_raw.get(level["id"])
    if now is not None and now >= want:
      self._auth_fails = 0
      log.ok(f"Access level: {enum.get(now, now)}")
    else:
      self._auth_fails += 1
      log.wrn(f"Unlock refused ({self._auth_fails}), level: {enum.get(now, now)}")
      if self._auth_fails >= AUTH_FAIL_LIMIT:
        log.err("Unlock given up - check config.AUTH_KEY")

  #------------------------------------------------------------------------------------- Connection

  def scan(self, mute:bool=True) -> list[str]:
    if not mute: log.run("Scanning ports")
    self.ports = serial_scan()
    # "SIM" is always offered; picking it runs the simulator. SimulatedClient
    # ignores the port name anyway.
    if "SIM" not in self.ports:
      self.ports = self.ports + ["SIM"]
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

  def apply_ignore(self):
    """Rewire the read-time poll filter after view.ignore changed. `read()`
    resolves `ignore_set` on every call, and the register map and DB schema
    cover every register regardless, so nothing is rebuilt and the port stays
    open. Applied on the read loop's thread, which owns the trickle plan and
    the raw cache."""
    if not self.mb: return
    new_ignore = config.ignore_names(self.view.get("ignore", []), self.mb)
    def _apply():
      if not self.mb: return
      self.mb.ignore_set = new_ignore
      # Telemetry drops its cached raw so history takes a gap, not a frozen
      # repeat. A writable keeps its value - it is still synced, and editable.
      for rid in self.mb.resolved_ignored_ids():
        if self.mb.id_map[rid]["rws"] == "R": self.mb.cache_raw[rid] = None
      self._trickle_built = False
      log.inf(f"Poll filter updated: {len(new_ignore)} ignored")
    self._loop.call_soon_threadsafe(_apply)

  def update_view(self, *, monitor=None, ignore=None, ask_map=None) -> dict:
    """Patch + persist the view. An ignore-set change rewires the poll filter
    in place; monitor edits don't affect it."""
    changed_filter = False
    if monitor is not None:
      self.view["monitor"] = monitor
    if ask_map is not None:
      self.view["ask_map"] = ask_map
    if ignore is not None and set(ignore) != set(self.view.get("ignore", [])):
      self.view["ignore"] = list(ignore)
      changed_filter = True
    config.save_view(self.view)
    if changed_filter: self.apply_ignore()
    return self.view

  def set_map(self, text:str) -> bool:
    """Adopt a register map. Everything the app shows is derived from it, so the
    connection and the simulator are dropped and the store schema swapped."""
    regs = config.save_regs(text)
    if not regs: return False
    self.disconnect()
    self._sim_client = None
    self.regs = regs
    self.store.reload(regs)
    log.ok(f"Register map loaded: {len(regs)} registers")
    return True

  def set_serial(self, params:dict):
    changed = False
    for k in ("baudrate", "parity", "stopbits", "timeout",
      "retries", "interval", "history", "autosend"):
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
    # `_save_state` needs an open `mb`; when disconnected, persist state directly.
    if self.mb: self._save_state()
    else: config.save_state(self.state)

  def reset_database(self) -> bool:
    """Wipe stored history. Stops the read loop and waits for its in-flight
    insert to release the DB file before deleting, then resumes polling if it
    was active. Returns `False` when the file could not be removed."""
    was_connected = self.connected
    task = self._read_task
    self._stop_reads()
    # Wait for the cancelled read loop to unwind so its open aiosqlite
    # connection is closed before `store.reset` deletes the file. A still-held
    # handle makes `os.remove` fail on Windows, silently leaving history on disk.
    if task:
      try: task.result(timeout=2)
      except Exception: pass
    ok = bool(self.run_async(self.store.reset()))
    if was_connected and self.mb:
      self._start_reads()
    if ok: log.ok("Database reset")
    return ok

  #------------------------------------------------------------------------------------------- Data

  def store_key(self):
    """DB table key: 'sim' isolates simulator history in addr_sim* tables; a
    real device keys by its Modbus address. Columns are named after registers,
    so an updated map slots into the existing table."""
    if self._sim: return "sim"
    return self.mb.addr if (self.mb and self.connected) else self.state.get("addr")

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
        # READBACK_W off: a written W isn't read back, so show it as 0.
        if not config.READBACK_W:
          for rid in self.mb.encode(data, ["W"]):
            self.mb.cache_raw[rid] = 0
        for k, v in data.items():
          write_log.info(f"addr:{self.mb.addr} {k} = {v}")
        # Read back exactly what was written, so the caller gets the device's own
        # values and not an echo of its request. Cheap enough to do on every
        # write; a failure here says nothing about the write, so it must not
        # fail it. Use `sync()` for a full re-read of the whole map.
        try: await self.mb.read_registers(list(self.mb.encode(data, ["W", "RW", "RWs"])))
        except Exception as e: log.wrn(f"Readback failed: {e}")
        return self.mb.cache
      except Exception as e:
        log.err(f"Write error: {e}")
        try: await self.mb.reconnect()
        except Exception: pass
        return None