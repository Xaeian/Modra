"""
SQLite store for poll-cycle history. One table per address (`addr_1`,
`addr_5`, ...) with columns typed from regs.csv (INTEGER/REAL/TEXT).
Schema is created lazily per addr on first log/query and kept in sync with
regs.csv by adding any missing columns (`ALTER TABLE ADD COLUMN`). New
registers migrate in place; only a column removal or type change needs
`data.db` deleted so it rebuilds fresh.

Rule registers (type=rule with switch + unit list) get one column per slot:
`Ctrl_Setpoint_0`, `Ctrl_Setpoint_1`, ... Each sample writes only the
currently-active slot; inactive slots are NULL. The framework stays
agnostic - slots are independent measurements that happen to share a
modbus address, never combined into one mixed-unit column.
"""

import os, math
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
            "col": f"{base}_{i}",
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
    self.db = SqliteAsyncDatabase(path)
    await self.db.exec("PRAGMA journal_mode=WAL")
    p.ok(f"Store: {path} ({len(self._cols)} cols)")

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
    bucket:float|None=None,
  ) -> list[dict]:
    """Rows with `ts > since_ts`, ascending. Limit capped at 50000.

    Rule registers expand to all slot columns - the frontend picks the
    column matching the currently-active slot. Non-active slots come back
    as NULL, which the ingest layer treats as "no sample for this slot".

    `bucket` (seconds, optional) downsamples long ranges: rows are grouped
    into `bucket`-wide time buckets and one representative row per bucket is
    returned - the latest in the bucket, via SQLite's bare-column rule
    (`MAX(ts)` pulls its whole row). Keeps any range to a bounded point
    count without per-type aggregation, so enum/bool values stay exact."""
    if not self.db: return []
    limit = min(limit, 50000)
    # Sanitize bucket: only positive numbers downsample; anything else is raw.
    try:
      b = float(bucket) if bucket is not None else None
    except (ValueError, TypeError):
      b = None
    if b is None or not math.isfinite(b) or b <= 0: b = None
    try:
      await self._ensure_table(addr)
      table = self._table(addr)
      vcols = []
      for n in names:
        meta = self._rule_meta.get(n)
        if meta:
          base = self._col(n)
          for i in range(len(meta["units"])):
            vcols.append(f"{base}_{i}")
        else:
          vcols.append(self._col(n))
      vcols_sql = ", ".join(ident(c) for c in vcols)
      if b is None:
        cols_sql = ", ".join(["ts", vcols_sql]) if vcols_sql else "ts"
        sql = f"SELECT {cols_sql} FROM {ident(table)} WHERE ts > ? ORDER BY ts ASC LIMIT ?"
        return await self.db.get_dicts(sql, (since_ts, limit))
      # Bucketed: MAX(ts) AS ts makes every bare value column take its value
      # from the latest row in each bucket.
      sel = ", ".join(["MAX(ts) AS ts", vcols_sql]) if vcols_sql else "MAX(ts) AS ts"
      sql = (f"SELECT {sel} FROM {ident(table)} WHERE ts > ? "
             f"GROUP BY CAST(ts / ? AS INT) ORDER BY ts ASC LIMIT ?")
      return await self.db.get_dicts(sql, (since_ts, b, limit))
    except Exception as e:
      p.err(f"since: {e}")
      return []

  #----------------------------------------------------------------------------------- Retention

  async def prune(self, days:int) -> int:
    """Delete rows older than `days` from every addr table. Indexed delete,
    cheap when run often (only newly-aged rows go). SQLite reuses the freed
    pages for new inserts, so the file size plateaus without VACUUM. Returns
    total rows removed. `days <= 0` disables retention (keep forever)."""
    if not self.db or not days or days <= 0: return 0
    cutoff = Time().to("ts") - days * 86400
    total = 0
    try:
      tables = await self.db.tables() or []
      for t in tables:
        if not str(t).startswith("addr_"): continue
        n = await self.db.exec(f"DELETE FROM {ident(t)} WHERE ts < ?", (cutoff,))
        total += n or 0
      if total: p.inf(f"Prune: removed {total} rows older than {days}d")
    except Exception as e:
      p.err(f"prune: {e}")
    return total

  async def reset(self) -> bool:
    """Wipe history: delete the DB file (and WAL/SHM sidecars), reclaim WAL
    mode on a fresh file. Tables re-create lazily on the next log/since.
    Caller must stop the read loop first so no insert keeps the file open.
    Returns `False` if `data.db` itself stayed (still locked), so the caller
    reports the failure instead of a false success."""
    self._tables = set()
    path = str(PATH.resolve("data.db"))
    ok = True
    for suffix in ("", "-wal", "-shm"):
      f = path + suffix
      try:
        if os.path.isfile(f): os.remove(f)
      except OSError as e:
        p.wrn(f"reset: {f}: {e}")
        if suffix == "": ok = False
    if self.db:
      await self.db.exec("PRAGMA journal_mode=WAL")
    if ok: p.ok("Store reset")
    return ok