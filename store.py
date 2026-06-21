"""
SQLite store for poll-cycle history with resolution tiers.

Raw data (one row per poll cycle) goes to one table per address (`addr_1`,
`addr_5`, ...), columns typed from regs.csv (INTEGER/REAL/TEXT). Three coarser
archive tiers downsample it incrementally - minute (`addr_1_m`), hour
(`addr_1_h`), day (`addr_1_d`) - each averaging the tier below. A chart query
reads from whichever tier matches the requested time span, so an overview of a
year is a 365-row read and a zoom into one minute is full resolution. Numeric
columns average; TEXT (enum/ver) take the last value in the bucket.

Schema is created lazily per table on first use and kept in sync with regs.csv
by adding any missing columns (`ALTER TABLE ADD COLUMN`). New registers migrate
in place; only a column removal or type change needs `data.db` deleted.

Rule registers (type=rule with switch + unit list) get one column per slot:
`Ctrl_Setpoint_0`, `Ctrl_Setpoint_1`, ... Each sample writes only the
currently-active slot; inactive slots are NULL.
"""

import os
from xaeian.db import SqliteAsyncDatabase, ident
from xaeian import Print, DIR, PATH, Time

p = Print()

# Archive tiers downsampled off the raw table: (suffix, bucket seconds,
# retention days). Each tier averages the one above it (raw -> m -> h -> d),
# so a year only ever costs the day tier 365 rows. `None` retention = forever.
ARCHIVE_TIERS = [("_m", 60.0, 90), ("_h", 3600.0, 730), ("_d", 86400.0, None)]
# Nominal raw row spacing (s), used only to pick a tier by zoom level. Real
# spacing is the poll interval; a LIMIT caps the row count either way.
RAW_BUCKET = 1.0

class Store:

  def __init__(self, regs:list[dict]):
    self.db:SqliteAsyncDatabase|None = None
    # Each entry: {col, type, name, slot_idx}. slot_idx=None for plain regs;
    # rule regs expand to N entries with slot_idx in 0..N-1.
    self._cols:list[dict] = []
    # name -> {"switch": switch_name, "units": [...]}  for rule regs.
    self._rule_meta:dict[str, dict] = {}
    self._tables:set[str] = set()
    self._parse_regs(regs)

  def reload(self, regs:list[dict]):
    """Swap register set; next use re-syncs schema (ADD COLUMN if needed)."""
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
          self._cols.append({"col": f"{base}_{i}", "type": "REAL", "name": r["name"], "slot_idx": i})
      else:
        self._cols.append({"col": self._col(r["name"]), "type": self._type(r), "name": r["name"], "slot_idx": None})

  @staticmethod
  def _active_slot(units:list, switch_val) -> int|None:
    """Map switch register value (enum label) -> slot index in `units`."""
    if switch_val is None: return None
    sv = str(switch_val).lower()
    for i, u in enumerate(units):
      if str(u).lower() == sv: return i
    return None

  def _table(self, addr:int, suffix:str="") -> str:
    return f"addr_{addr}{suffix}"

  def _vcols(self, names:list[str]) -> list[str]:
    """Expand register names to DB columns, rule regs -> all slot columns."""
    vcols = []
    for n in names:
      meta = self._rule_meta.get(n)
      if meta:
        base = self._col(n)
        for i in range(len(meta["units"])): vcols.append(f"{base}_{i}")
      else:
        vcols.append(self._col(n))
    return vcols

  #--------------------------------------------------------------------------------------- Init

  async def init(self):
    path = PATH.resolve("data.db")
    DIR.ensure(path, is_file=True)
    self.db = SqliteAsyncDatabase(path)
    await self.db.exec("PRAGMA journal_mode=WAL")
    p.ok(f"Store: {path} ({len(self._cols)} cols)")

  async def _ensure(self, table:str):
    """Create the table (same schema as raw) and its ts index if missing, and
    ALTER in any columns added since (post-reload). Works for raw and tiers."""
    if table in self._tables: return
    defs = ", ".join(f"{c['col']} {c['type']}" for c in self._cols)
    await self.db.exec(f"CREATE TABLE IF NOT EXISTS {ident(table)} (ts REAL NOT NULL, {defs})")
    await self.db.exec(f"CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {ident(table)}(ts)")
    existing = await self.db.get_dicts(f"PRAGMA table_info({ident(table)})")
    have = {r["name"] for r in (existing or [])}
    for c in self._cols:
      if c["col"] not in have:
        await self.db.exec(f"ALTER TABLE {ident(table)} ADD COLUMN {c['col']} {c['type']}")
    self._tables.add(table)

  async def _ensure_table(self, addr:int):
    await self._ensure(self._table(addr))

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
      # Per-rule active-slot cache so we resolve each switch only once per cycle.
      active:dict[str, int|None] = {}
      for c in self._cols:
        name = c["name"]
        slot_idx = c["slot_idx"]
        if slot_idx is None:
          row[c["col"]] = self._resolve(cache, name)
          continue
        if name not in active:
          meta = self._rule_meta.get(name)
          active[name] = self._active_slot(meta["units"], self._resolve(cache, meta["switch"])) if meta else None
        # Only the active slot column gets the value; others stay NULL.
        row[c["col"]] = self._resolve(cache, name) if active[name] == slot_idx else None
      await self.db.insert(self._table(addr), row)
    except Exception as e:
      p.err(f"log: {e}")

  #---------------------------------------------------------------------------------- Downsample

  async def roll(self, addr:int) -> int:
    """Bring every archive tier up to date for `addr`. Cascading: minute reads
    raw, hour reads minute, day reads hour - so each tier only ever aggregates
    the small tier above it, never rescans raw. Forward-only (no backfill): a
    `_roll` watermark per tier marks the next bucket to process, so each pass
    aggregates only the bucket(s) that completed since last time."""
    if not self.db: return 0
    total = 0
    try:
      await self.db.exec("CREATE TABLE IF NOT EXISTS _roll (tbl TEXT PRIMARY KEY, ts REAL)")
      src = self._table(addr)
      for suffix, bucket, _ in ARCHIVE_TIERS:
        dst = self._table(addr, suffix)
        total += await self._roll_tier(src, dst, bucket)
        src = dst
    except Exception as e:
      p.err(f"roll: {e}")
    return total

  async def _roll_tier(self, src:str, dst:str, bucket:float) -> int:
    await self._ensure(dst)
    src_max = await self.db.get_value(f"SELECT MAX(ts) FROM {ident(src)}")
    if src_max is None: return 0
    end = (int(src_max // bucket)) * bucket   # start of the current (incomplete) bucket
    mark = await self.db.get_value("SELECT ts FROM _roll WHERE tbl=?", (dst,))
    if mark is None:
      # First sight of this tier: anchor the watermark at the current edge and
      # archive nothing, so we build forward instead of backfilling old raw.
      await self.db.exec("INSERT OR REPLACE INTO _roll (tbl, ts) VALUES (?, ?)", (dst, end))
      return 0
    if mark >= end: return 0
    cols = [c["col"] for c in self._cols]
    cols_sql = ", ".join(ident(c) for c in (["ts"] + cols))
    rows = await self.db.get_dicts(
      f"SELECT {cols_sql} FROM {ident(src)} WHERE ts >= ? AND ts < ? ORDER BY ts ASC", (mark, end))
    buckets:dict[float, list] = {}
    for r in (rows or []):
      buckets.setdefault((int(r["ts"] // bucket)) * bucket, []).append(r)
    n = 0
    for b in sorted(buckets):
      agg = {"ts": b}
      for c in self._cols:
        vals = [r[c["col"]] for r in buckets[b] if r[c["col"]] is not None]
        if not vals: agg[c["col"]] = None
        elif c["type"] == "TEXT": agg[c["col"]] = vals[-1]   # last value in bucket
        else: agg[c["col"]] = sum(vals) / len(vals)          # mean of the bucket
      await self.db.insert(dst, agg)
      n += 1
    await self.db.exec("INSERT OR REPLACE INTO _roll (tbl, ts) VALUES (?, ?)", (dst, end))
    return n

  #-------------------------------------------------------------------------------------- Query

  def _pick_tier(self, span:float, max_points:int, age:float, raw_days:int) -> str:
    """Finest tier whose native bucket keeps the row count under `max_points`
    (bucket >= span/max_points) AND whose retention still holds data back to
    `from` (age = now - from). Routes wide/old windows to coarse tiers, narrow
    recent ones to raw."""
    needed = span / max_points if max_points else span
    tiers = [("", RAW_BUCKET, raw_days)] + ARCHIVE_TIERS
    for suffix, bucket, ret_days in tiers:
      if bucket < needed: continue
      if ret_days is not None and age > ret_days * 86400: continue
      return suffix
    return "_d"

  def tier_label(self, from_ts:float, to_ts:float, max_points:int, raw_days:int) -> str:
    """Human name of the tier `query` would read for this window, for the UI to
    show which resolution is on screen. Mirrors `query`'s pick (no DB)."""
    try:
      span = float(to_ts) - float(from_ts)
      mp = max(1, min(int(max_points or 2000), 50000))
    except (ValueError, TypeError):
      return "raw"
    suffix = self._pick_tier(span, mp, Time().to("ts") - float(from_ts), int(raw_days or 14))
    return {"": "raw", "_m": "min", "_h": "hour", "_d": "day"}.get(suffix, "raw")

  async def query(
    self, addr:int, names:list[str], from_ts:float, to_ts:float,
    max_points:int=2000, raw_days:int=14,
  ) -> list[dict]:
    """Rows for `names` in [from_ts, to_ts], ascending, downsampled to the tier
    that fits the span. Rule registers expand to all slot columns; the frontend
    picks the active one. Returns at most ~`max_points` rows."""
    if not self.db: return []
    try:
      from_ts = float(from_ts); to_ts = float(to_ts)
    except (ValueError, TypeError):
      return []
    if to_ts <= from_ts: return []
    max_points = max(1, min(int(max_points or 2000), 50000))
    try:
      suffix = self._pick_tier(to_ts - from_ts, max_points, Time().to("ts") - from_ts, raw_days)
      table = self._table(addr, suffix)
      await self._ensure(table)
      vcols = self._vcols(names)
      cols_sql = ", ".join(ident(c) for c in (["ts"] + vcols)) if vcols else "ts"
      cap = max(max_points * 2, 4000)
      sql = (f"SELECT {cols_sql} FROM {ident(table)} "
             f"WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?")
      return await self.db.get_dicts(sql, (from_ts, to_ts, cap))
    except Exception as e:
      p.err(f"query: {e}")
      return []

  #----------------------------------------------------------------------------------- Retention

  @staticmethod
  def _tier_suffix(table:str) -> str:
    for suffix, _, _ in ARCHIVE_TIERS:
      if table.endswith(suffix): return suffix
    return ""

  async def prune(self, history_days:int) -> int:
    """Delete aged rows from every table, each by its own retention: raw by
    `history_days`, tiers by ARCHIVE_TIERS (day tier kept forever). Cheap when
    run often; SQLite reuses freed pages so the file plateaus without VACUUM."""
    if not self.db: return 0
    now = Time().to("ts")
    cutoff = {"": (now - history_days * 86400) if history_days and history_days > 0 else None}
    for suffix, _, ret_days in ARCHIVE_TIERS:
      cutoff[suffix] = (now - ret_days * 86400) if ret_days else None
    total = 0
    try:
      for t in (await self.db.tables() or []):
        if not str(t).startswith("addr_"): continue
        cut = cutoff.get(self._tier_suffix(t))
        if cut is None: continue
        total += await self.db.exec(f"DELETE FROM {ident(t)} WHERE ts < ?", (cut,)) or 0
      if total: p.inf(f"Prune: removed {total} rows")
    except Exception as e:
      p.err(f"prune: {e}")
    return total

  async def reset(self) -> bool:
    """Wipe history: delete the DB file (and WAL/SHM sidecars), reclaim WAL on a
    fresh file. Tables (raw + tiers) re-create lazily. Caller must stop the read
    loop first. Returns `False` if `data.db` itself stayed (still locked)."""
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
