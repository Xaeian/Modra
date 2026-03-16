from xaeian.db import SqliteAsyncDatabase, ident
from xaeian import Print, DIR, PATH, Time

p = Print()

class Store:

  def __init__(self, regs:list[dict]):
    self.db:SqliteAsyncDatabase|None = None
    self._cols:list[tuple] = []  # (col, typ, name)
    self._tables:set[int] = set()
    self._parse_regs(regs)

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
      self._cols.append((self._col(r["name"]), self._type(r), r["name"]))

  def _table(self, addr:int) -> str:
    return f"addr_{addr}"

  #----------------------------------------------------------------------------- Init

  async def init(self):
    path = PATH.resolve("data.db")
    DIR.ensure(path, is_file=True)
    self.db = SqliteAsyncDatabase(path)
    await self.db.exec("PRAGMA journal_mode=WAL")
    p.ok(f"Store: {path} ({len(self._cols)} cols)")

  async def _ensure_table(self, addr:int):
    if addr in self._tables: return
    table = self._table(addr)
    defs = ", ".join(f"{c} {t}" for c, t, _ in self._cols)
    await self.db.exec(f"CREATE TABLE IF NOT EXISTS {ident(table)} (ts REAL NOT NULL, {defs})")
    await self.db.exec(f"CREATE INDEX IF NOT EXISTS idx_{table}_ts ON {ident(table)}(ts)")
    self._tables.add(addr)

  #------------------------------------------------------------------------------ Resolve

  @staticmethod
  def _resolve(data:dict, name:str):
    if name in data: return data[name]
    if ":" in name:
      g, n = name.split(":", 1)
      v = data.get(g)
      if isinstance(v, dict): return v.get(n)
    return None

  #------------------------------------------------------------------------------ Logging

  async def log(self, cache:dict, addr:int):
    if not self._cols or not self.db: return
    try:
      await self._ensure_table(addr)
      row = {"ts": Time().to('ts')}
      for col, _, name in self._cols:
        row[col] = self._resolve(cache, name)
      await self.db.insert(self._table(addr), row)
    except Exception as e:
      p.err(f"log: {e}")

  #------------------------------------------------------------------------------ Query

  async def since(
    self, addr:int, names:list[str], since_ts:float, limit:int=5000,
  ) -> list[dict]:
    """Rows with ts > since_ts, ascending. Limit capped at 50000."""
    if not self.db: return []
    limit = min(limit, 50000)
    try:
      await self._ensure_table(addr)
      table = self._table(addr)
      cols_sql = "ts, " + ", ".join(ident(self._col(n)) for n in names)
      sql = f"SELECT {cols_sql} FROM {ident(table)} WHERE ts > ? ORDER BY ts ASC LIMIT ?"
      return await self.db.get_dicts(sql, (since_ts, limit))
    except Exception as e:
      p.err(f"since: {e}")
      return []