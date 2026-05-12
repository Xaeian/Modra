"""
SQLite store for poll-cycle history. One table per address (`addr_1`,
`addr_5`, ...) with columns typed from regs.csv (INTEGER/REAL/TEXT). On
boot the schema is compared against the current map - any dropped columns
or type mismatches rotate the file to `data-YYYYMMDD-HHMMSS.db` and start
fresh. `self.migrated_to` carries the backup path for the UI.

Rule registers (type=rule with switch + unit list) get one column per slot:
`Ctrl_Setpoint__0`, `Ctrl_Setpoint__1`, ... Each sample writes only the
currently-active slot; inactive slots are NULL. The framework stays
agnostic - slots are independent measurements that happen to share a
modbus address, never combined into one mixed-unit column.
"""

import os, shutil
from datetime import datetime
from xaeian.db import SqliteAsyncDatabase, ident
from xaeian import Print, DIR, PATH, Time

p = Print()

class Store:

  def __init__(self, regs:list[dict]):
    self.db:SqliteAsyncDatabase|None = None
    # Each entry: {col, type, name, slot_idx}. slot_idx=None for plain regs;
    # rule regs expand to N entries with slot_idx in 0..N-1.
    self._cols:list[dict] = []
    # name -> {"switch": switch_name, "units": [...]}  for rule regs.
    # Used at log time to resolve the active slot from the cache.
    self._rule_meta:dict[str, dict] = {}
    self._tables:set[int] = set()
    # Backup path if migration just ran, else None. Surfaced to the UI
    # one-shot via api.status() → frontend toast.
    self.migrated_to:str|None = None
    self._parse_regs(regs)

  def reload(self, regs:list[dict]):
    """Swap register set; next `log()` re-syncs schema (ADD COLUMN if needed)."""
    self._cols = []
    self._rule_meta = {}
    self._tables = set()
    self._parse_regs(regs)

  @staticmethod
  def _col(name:str) -> str:
    return name.replace(":", "_")

  @staticmethod
  def _type(reg:dict) -> str:
    typ = reg.get("type", "uint")
    if typ in ("enum", "ver"): return "TEXT"
    if typ in ("bool", "hex"): return "INTEGER"
    if typ in ("rule", "float"): return "REAL"
    scale = reg.get("scale", 1)
    if isinstance(scale, list): return "REAL"
    if scale != 1 and scale != 1.0: return "REAL"
    return "INTEGER"

  def _parse_regs(self, regs:list[dict]):
    for r in regs:
      rule_info = r.get("rule") or {}
      switch_name = rule_info.get("switch")
      units = r.get("unit")
      # Slot-switching rule register: one column per slot. Pair registers
      # don't have rule.switch (they have rule.pair) so they fall through.
      if switch_name and isinstance(units, list):
        self._rule_meta[r["name"]] = {"switch": switch_name, "units": list(units)}
        base = self._col(r["name"])
        for i in range(len(units)):
          self._cols.append({
            "col": f"{base}__{i}",
            "type": "REAL",
            "name": r["name"],
            "slot_idx": i,
          })
      else:
        self._cols.append({
          "col": self._col(r["name"]),
          "type": self._type(r),
          "name": r["name"],
          "slot_idx": None,
        })

  @staticmethod
  def _active_slot(units:list, switch_val) -> int|None:
    """Map switch register value (enum label) → slot index in `units`."""
    if switch_val is None: return None
    sv = str(switch_val).lower()
    for i, u in enumerate(units):
      if str(u).lower() == sv: return i
    return None

  def _table(self, addr:int) -> str:
    return f"addr_{addr}"

  #--------------------------------------------------------------------------------------- Init

  async def init(self):
    path = PATH.resolve("data.db")
    DIR.ensure(path, is_file=True)
    # Check schema before opening for write. Drift → rotate the legacy
    # file (with WAL/SHM sidecars) and start fresh. Noop on first boot.
    if os.path.exists(path):
      await self._migrate_if_drift(path)
    self.db = SqliteAsyncDatabase(path)
    await self.db.exec("PRAGMA journal_mode=WAL")
    p.ok(f"Store: {path} ({len(self._cols)} cols)")

  #--------------------------------------------------------------------------------- Migration

  async def _migrate_if_drift(self, path:str):
    """Compare each addr_X table against current `_cols`; back the file up
    if any column was dropped or its type changed (additions are recoverable
    via ALTER TABLE ADD COLUMN)."""
    tmp = SqliteAsyncDatabase(path)
    try:
      tables = await tmp.get_dicts(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'addr_%'"
      )
      addrs = []
      for r in tables or []:
        n = r.get("name", "")
        try: addrs.append(int(n.split("_", 1)[1]))
        except (IndexError, ValueError): pass
      if not addrs: return  # empty DB, nothing to compare against

      expected_types = {c["col"]: c["type"].upper() for c in self._cols}
      expected_cols = set(expected_types)
      drift_lines = []
      for addr in addrs:
        table = self._table(addr)
        info = await tmp.get_dicts(f"PRAGMA table_info({ident(table)})")
        actual_types = {r["name"]: str(r["type"]).upper()
                        for r in (info or []) if r["name"] != "ts"}
        actual_cols = set(actual_types)
        dropped = actual_cols - expected_cols
        retyped = {c for c in actual_cols & expected_cols
                   if actual_types[c] != expected_types[c]}
        if dropped or retyped:
          parts = []
          if dropped: parts.append(f"-{len(dropped)}")
          if retyped: parts.append(f"~{len(retyped)}")
          drift_lines.append(f"{table} ({', '.join(parts)})")
      if not drift_lines: return

      ts = datetime.now().strftime("%Y%m%d-%H%M%S")
      backup = path.replace(".db", f"-{ts}.db")
      # Release the handle before move - Windows holds locks on open DBs.
      await self._close(tmp)
      tmp = None
      shutil.move(path, backup)
      # WAL/SHM sidecars exist only when WAL is active; move them too so
      # the new DB starts clean.
      for suffix in ("-wal", "-shm"):
        side = path + suffix
        if os.path.exists(side): shutil.move(side, backup + suffix)
      self.migrated_to = backup
      p.wrn(f"DB schema drift: {', '.join(drift_lines)}")
      p.wrn(f"Backed up to {backup} - fresh DB will be created.")
    finally:
      if tmp is not None: await self._close(tmp)

  @staticmethod
  async def _close(db):
    """Best-effort close. SqliteAsyncDatabase exposes `close` or `aclose`
    depending on version - we just want the handle released."""
    for name in ("close", "aclose"):
      fn = getattr(db, name, None)
      if callable(fn):
        try:
          result = fn()
          if hasattr(result, "__await__"): await result
        except Exception: pass
        return

  async def _ensure_table(self, addr:int):
    if addr in self._tables: return
    table = self._table(addr)
    defs = ", ".join(f"{c['col']} {c['type']}" for c in self._cols)
    await self.db.exec(f"CREATE TABLE IF NOT EXISTS {ident(table)} (ts REAL NOT NULL, {defs})")
    await self.db.exec(f"CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {ident(table)}(ts)")
    # ALTER TABLE for cols missing in an existing table (post-reload).
    existing = await self.db.get_dicts(f"PRAGMA table_info({ident(table)})")
    have = {r["name"] for r in (existing or [])}
    for c in self._cols:
      if c["col"] not in have:
        await self.db.exec(f"ALTER TABLE {ident(table)} ADD COLUMN {c['col']} {c['type']}")
    self._tables.add(addr)

  #------------------------------------------------------------------------------------ Resolve

  @staticmethod
  def _resolve(data:dict, name:str):
    if name in data: return data[name]
    if ":" in name:
      g, n = name.split(":", 1)
      v = data.get(g)
      if isinstance(v, dict): return v.get(n)
    return None

  #------------------------------------------------------------------------------------ Logging

  async def log(self, cache:dict, addr:int):
    if not self._cols or not self.db: return
    try:
      await self._ensure_table(addr)
      row = {"ts": Time().to("ts")}
      # Per-rule active-slot cache so we resolve each switch only once per
      # poll cycle even when a rule has many slots.
      active:dict[str, int|None] = {}
      for c in self._cols:
        name = c["name"]
        slot_idx = c["slot_idx"]
        if slot_idx is None:
          row[c["col"]] = self._resolve(cache, name)
          continue
        if name not in active:
          meta = self._rule_meta.get(name)
          if meta:
            switch_val = self._resolve(cache, meta["switch"])
            active[name] = self._active_slot(meta["units"], switch_val)
          else:
            active[name] = None
        # Only the currently-active slot column gets the value; others stay
        # NULL so the unit semantics of each slot's history are preserved.
        row[c["col"]] = self._resolve(cache, name) if active[name] == slot_idx else None
      await self.db.insert(self._table(addr), row)
    except Exception as e:
      p.err(f"log: {e}")

  #-------------------------------------------------------------------------------------- Query

  async def since(
    self, addr:int, names:list[str], since_ts:float, limit:int=5000,
  ) -> list[dict]:
    """Rows with `ts > since_ts`, ascending. Limit capped at 50000.

    Rule registers expand to all slot columns - the frontend picks the
    column matching the currently-active slot. Non-active slots come back
    as NULL, which the ingest layer treats as "no sample for this slot"."""
    if not self.db: return []
    limit = min(limit, 50000)
    try:
      await self._ensure_table(addr)
      table = self._table(addr)
      cols = ["ts"]
      for n in names:
        meta = self._rule_meta.get(n)
        if meta:
          base = self._col(n)
          for i in range(len(meta["units"])):
            cols.append(f"{base}__{i}")
        else:
          cols.append(self._col(n))
      cols_sql = ", ".join(ident(c) for c in cols)
      sql = f"SELECT {cols_sql} FROM {ident(table)} WHERE ts > ? ORDER BY ts ASC LIMIT ?"
      return await self.db.get_dicts(sql, (since_ts, limit))
    except Exception as e:
      p.err(f"since: {e}")
      return []