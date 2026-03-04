import os
from time import time
from datetime import date
from xaeian.db import SqliteAsyncDatabase
from xaeian import Print
import config

p = Print()

class Store:

  def __init__(self, regs:list[dict]):
    self.db:SqliteAsyncDatabase|None = None
    self._day = None
    self._r_cols:list[tuple] = []
    self._w_cols:list[tuple] = []
    self._r_sql = ""
    self._parse_regs(regs)

  #-------------------------------------------------------------------------------------- Build

  @staticmethod
  def _col(name:str) -> str:
    return name.replace(":", "_")

  @staticmethod
  def _type(reg:dict) -> str:
    typ = reg.get("type", "uint")
    if typ in ("enum", "ver"): return "TEXT"
    if typ in ("bool", "hex"): return "INTEGER"
    if typ == "rule": return "REAL"
    scale = reg.get("scale", 1)
    if isinstance(scale, list): return "REAL"
    if scale != 1 and scale != 1.0: return "REAL"
    return "INTEGER"

  def _parse_regs(self, regs:list[dict]):
    for r in regs:
      name = r["name"]
      col, typ = self._col(name), self._type(r)
      rws = r.get("rws", "R")
      if rws == "R":
        self._r_cols.append((col, typ, name))
      elif rws in ("RW", "RWs", "Rt"):
        self._w_cols.append((col, typ, name))
    if self._r_cols:
      cols = "ts, " + ", ".join(c for c, _, _ in self._r_cols)
      phs = ", ".join(["?"] * (1 + len(self._r_cols)))
      self._r_sql = f"INSERT INTO reads ({cols}) VALUES ({phs})"

  def _db_path(self, day:str=None) -> str:
    return os.path.join(config.DATA_DIR, f"{day or self._day}.db")

  #-------------------------------------------------------------------------------------- Init

  async def _open_db(self, path:str) -> SqliteAsyncDatabase:
    db = SqliteAsyncDatabase(path)
    await db.exec("PRAGMA journal_mode=WAL")
    if self._r_cols:
      defs = ", ".join(f"{c} {t}" for c, t, _ in self._r_cols)
      await db.exec(f"CREATE TABLE IF NOT EXISTS reads (ts REAL NOT NULL, {defs})")
      await db.exec("CREATE INDEX IF NOT EXISTS idx_reads_ts ON reads(ts)")
    if self._w_cols:
      defs = ", ".join(f"{c} {t}" for c, t, _ in self._w_cols)
      await db.exec(f"CREATE TABLE IF NOT EXISTS writes (ts REAL NOT NULL, {defs})")
      await db.exec("CREATE INDEX IF NOT EXISTS idx_writes_ts ON writes(ts)")
    return db

  async def init(self):
    os.makedirs(config.DATA_DIR, exist_ok=True)
    self._day = date.today().isoformat()
    self.db = await self._open_db(self._db_path())
    p.ok(f"Store: {self._db_path()} ({len(self._r_cols)}R + {len(self._w_cols)}W)")

  async def _ensure_day(self):
    today = date.today().isoformat()
    if today != self._day:
      p.inf(f"Store: day rollover {self._day} -> {today}")
      await self.init()

  #----------------------------------------------------------------------------------- Resolve

  @staticmethod
  def _resolve(data:dict, name:str):
    if name in data: return data[name]
    if ":" in name:
      g, n = name.split(":", 1)
      v = data.get(g)
      if isinstance(v, dict): return v.get(n)
    return None

  #----------------------------------------------------------------------------------- Logging

  async def log_reads(self, cache:dict):
    if not self._r_sql: return
    if not self.db:
      p.wrn("log_reads: store not initialized")
      return
    await self._ensure_day()
    try:
      vals = [time()]
      for _, _, name in self._r_cols:
        vals.append(self._resolve(cache, name))
      await self.db.exec(self._r_sql, tuple(vals))
    except Exception as e:
      p.err(f"log_reads: {e}")

  async def log_write(self, data:dict):
    if not self._w_cols: return
    if not self.db:
      p.wrn("log_write: store not initialized")
      return
    await self._ensure_day()
    try:
      cols, vals = ["ts"], [time()]
      for col, _, name in self._w_cols:
        val = self._resolve(data, name)
        if val is not None:
          cols.append(col)
          vals.append(val)
      if len(cols) < 2:
        p.wrn("log_write: no writable fields resolved")
        return
      phs = ", ".join(["?"] * len(cols))
      await self.db.exec(
        f"INSERT INTO writes ({', '.join(cols)}) VALUES ({phs})",
        tuple(vals),
      )
    except Exception as e:
      p.err(f"log_write: {e}")

  #------------------------------------------------------------------------------------- Query

  async def history(
    self, table:str, names:list[str],
    day:str=None, t0:float=None, t1:float=None, limit:int=2000,
  ) -> list[dict]:
    path = self._db_path(day)
    if not os.path.exists(path):
      p.wrn(f"history: file not found: {path}")
      return []
    db = None
    try:
      db = await self._open_db(path)
      cols = "ts, " + ", ".join(self._col(n) for n in names)
      sql = f"SELECT {cols} FROM {table}"
      where, params = [], []
      if t0 is not None: where.append("ts >= ?"); params.append(t0)
      if t1 is not None: where.append("ts <= ?"); params.append(t1)
      if where: sql += " WHERE " + " AND ".join(where)
      sql += " ORDER BY ts"
      if limit: sql += f" LIMIT {limit}"
      return await db.get_dicts(sql, tuple(params) if params else None)
    except Exception as e:
      p.err(f"history: {e}")
      return []
    finally:
      if db and day and day != self._day:
        try: await db.close()
        except Exception as e: p.wrn(f"history: close failed: {e}")

  async def history_range(
    self, table:str, names:list[str],
    day_from:str, day_to:str=None, limit:int=2000,
  ) -> list[dict]:
    days = self.list_days()
    if not days: return []
    if day_to is None: day_to = days[0]
    selected = sorted(d for d in days if day_from <= d <= day_to)
    results = []
    remaining = limit
    for d in selected:
      if remaining <= 0: break
      rows = await self.history(table, names, day=d, limit=remaining)
      results.extend(rows)
      remaining -= len(rows)
    return results

  def list_days(self) -> list[str]:
    if not os.path.isdir(config.DATA_DIR): return []
    return sorted(
      [f[:-3] for f in os.listdir(config.DATA_DIR) if f.endswith(".db")],
      reverse=True,
    )