"""
Async Modbus RTU master with CSV-based register descriptor.

Parses regs.csv → typed map for uint/int/bool/enum/hex/ver/rule, supports
`switch=` / `high=` / `low=` rules, caches raw 16-bit values. The map is
always complete - `ignore_set` filters at read time only (pair-aware) so
the DB schema and `regs_info()` cover every register and the frontend
can show or hide ignored entries on its own.

A `?` prefix on `type` marks the register nullable - a reserved raw
value decodes to `None`. Defaults follow SunSpec; the `null` CSV column
overrides per-register. See modbus.md for the full table.
"""

import asyncio, math, struct
from pymodbus.client import AsyncModbusSerialClient
from typing import Literal
from xaeian import CSV

# SunSpec-aligned sentinels. Float pairs use IEEE-754 NaN at runtime, so
# they don't appear in NULL_SENTINELS_32.
NULL_SENTINELS_16 = {"uint": 0xFFFF, "hex": 0xFFFF, "int": 0x8000, "bool": 0xFFFF}
NULL_SENTINELS_32 = {"uint": 0xFFFFFFFF, "hex": 0xFFFFFFFF, "int": 0x80000000}

class ModbusMaster:

  @staticmethod
  def _parse_slots(val, conv, empty=None):
    """CSV cell → value or `/`-separated rule-slot list. Empty / `-` → `empty`;
    `conv` maps one token and supplies its own fallback on garbage."""
    s = str(val).strip()
    if s in ("", "-"): return empty
    if "/" in s: return [ModbusMaster._parse_slots(x, conv, empty) for x in s.split("/")]
    return conv(s)

  @staticmethod
  def _float(s, fallback=None):
    try: return float(s)
    except ValueError: return fallback

  @staticmethod
  def _num_or_str(s):
    try: return int(s)
    except ValueError: return ModbusMaster._float(s, s)

  @staticmethod
  def _parse_enum(text:str) -> dict[int, str]:
    if not text or text == "-": return {}
    text = text.replace(":", "=")
    out = {}
    for tok in text.split():
      if "=" not in tok: continue
      k, v = tok.split("=", 1)
      if k.strip().isdigit(): out[int(k)] = v.strip()
    return out

  @staticmethod
  def _parse_rule(rule:str) -> dict[str, str]|None:
    if not rule or rule == "-": return None
    out = {}
    for part in rule.split(";"):
      if "=" in part:
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out if out else None

  @staticmethod
  def _parse_null_override(val) -> int|None:
    """Sentinel from the `null` CSV column. Accepts dec / `0x..` / `0b..`,
    signed for `int`. Empty / `-` → type default."""
    if val is None: return None
    s = str(val).strip()
    if s == "" or s == "-": return None
    try: return int(s, 0)
    except ValueError:
      try: return int(float(s))
      except (ValueError, TypeError): return None

  @staticmethod
  def _compute_null_raw_16(type_val:str, nullable:bool, override:int|None) -> int|None:
    if not nullable: return None
    if override is not None:
      # Signed CSV input (e.g. -1) wraps into unsigned raw space so it
      # matches the on-wire word directly.
      if type_val == "int" and override < 0:
        override = override + 0x10000
      return override & 0xFFFF
    return NULL_SENTINELS_16.get(type_val)

  @staticmethod
  def _compute_null_raw_32(h_entry:dict) -> int|None:
    if not h_entry.get("nullable"): return None
    typ = h_entry["type"]
    # Float pairs use NaN at decode time, no integer comparison needed.
    if typ == "float": return None
    override = h_entry.get("null_override")
    if override is not None:
      if typ == "int" and override < 0:
        override = override + 0x100000000
      return override & 0xFFFFFFFF
    return NULL_SENTINELS_32.get(typ)

  def __init__(
    self,
    port:str,
    regmap_file:str,
    addr:int = 1,
    baudrate:int = 9600,
    parity:Literal["N","O","E"] = "N",
    stopbits:Literal[1,2] = 1,
    timeout:float = 1,
    retries:int = 3,
    group:bool = True,
    max_block:int = 64,
    ignore_set:set[str] = None,
    client_factory = None,
  ):
    self.port = port
    self.addr = addr
    self.baudrate = baudrate
    self.parity = parity
    self.stopbits = stopbits
    self.timeout = timeout
    self.retries = max(1, retries)
    self.group = group
    self.max_block = max_block
    # Read-time filter only; the map below stays complete.
    self.ignore_set: set[str] = set(ignore_set) if ignore_set else set()
    # Transport builder `(mb) -> client`; None → serial client from the params above.
    self.client_factory = client_factory
    self.id_map: dict[int, dict] = {}
    self.name_map: dict[str, dict] = {}
    self.pairs: dict[str, dict] = {}
    for reg_row in CSV.load(regmap_file):
      entry = self._parse_reg_row(reg_row)
      reg_id, fullname = entry["id"], entry["fullname"]
      group, name = entry["group"], entry["name"]
      self.id_map[reg_id] = entry
      self.name_map[fullname] = entry
      rule = entry.get("rule")
      if rule:
        for part in ("high", "low"):
          if part in rule:
            pair_name = rule[part]
            pair_key = f"{group}:{pair_name}" if group else pair_name
            if pair_key not in self.pairs:
              self.pairs[pair_key] = {"group": group, "name": pair_name}
            self.pairs[pair_key][part] = entry
    # Pair sentinels need the high/low table built first.
    for pair_info in self.pairs.values():
      h = pair_info.get("high")
      if h: h["null_raw32"] = self._compute_null_raw_32(h)
    self.cache_raw: dict[int, int|None] = {rid: None for rid in self.id_map}
    self.client: AsyncModbusSerialClient|None = None

  def _parse_reg_row(self, row:dict) -> dict:
    reg_id = int(row["id"])
    name_full = row["name"].strip()
    group, name = name_full.split(":", 1) if ":" in name_full else (None, name_full)
    hex_str = str(row["hex"]).strip()
    try: hex_val = int(hex_str, 0)
    except ValueError: hex_val = reg_id
    if hex_val != reg_id: hex_str = f"0x{reg_id:02X}"
    rws_map = {"R": "R", "RW": "RW", "RWS": "RWs", "W": "W"}
    rws_val = rws_map.get(str(row.get("rws", "R")).strip().upper(), "R")
    # `?` prefix → nullable. Strip so downstream sees the plain type.
    type_raw = str(row.get("type", "uint")).strip().lower()
    nullable = type_raw.startswith("?")
    type_val = type_raw[1:].strip() if nullable else type_raw
    null_override = self._parse_null_override(row.get("null"))
    entry = {
      "id": reg_id, "hex": hex_str, "group": group, "name": name, "fullname": name_full,
      "rws": rws_val, "type": type_val,
      "nullable": nullable,
      "null_override": null_override,
      "null_raw": self._compute_null_raw_16(type_val, nullable, null_override),
      "unit": self._parse_slots(row.get("unit", ""), lambda s: s),
      "scale": self._parse_slots(row.get("scale", "1"), lambda s: self._float(s, 1.0), 1.0),
      "min": self._parse_slots(row.get("min", ""), self._float),
      "max": self._parse_slots(row.get("max", ""), self._float),
      "desc": row.get("desc") if row.get("desc") not in ("", "-") else None,
      "rule": self._parse_rule(row.get("rule", "")),
      "default": self._parse_slots(row.get("default", ""), self._num_or_str),
    }
    if type_val == "enum": entry["enum"] = self._parse_enum(row.get("unit", ""))
    # The unit column holds the bit->label map (like enum), not a real unit.
    if type_val == "bits":
      entry["bits"] = self._parse_enum(row.get("unit", ""))
      entry["unit"] = None
    return entry

  #--------------------------------------------------------------------------------- Connection

  async def connect(self) -> AsyncModbusSerialClient:
    if self.client and self.client.connected: return self.client
    if self.client is None:
      if self.client_factory:
        self.client = self.client_factory(self)
      else:
        self.client = AsyncModbusSerialClient(
          port=self.port, baudrate=self.baudrate, parity=self.parity,
          stopbits=self.stopbits, bytesize=8, timeout=self.timeout)
    await self.client.connect()
    if not self.client.connected:
      raise RuntimeError(f"Connect error: {self.port}")
    return self.client

  async def disconnect(self):
    if self.client:
      self.client.close()
      self.client = None

  async def reconnect(self):
    """Close + reopen. Resets pymodbus framer state after a stalled frame."""
    await self.disconnect()
    await asyncio.sleep(0.1)
    await self.connect()

  #---------------------------------------------------------------------------------- Low-level

  def _get_blocks(self, ids:list[int]) -> list[tuple[int, int]]:
    ids = sorted(set(ids))
    if not ids: return []
    blocks = []
    start = prev = ids[0]
    for a in ids[1:]:
      if a == prev + 1 and (a - start + 1) <= self.max_block: prev = a
      else:
        blocks.append((start, prev - start + 1))
        start = prev = a
    blocks.append((start, prev - start + 1))
    return blocks

  def _write_blocks(self, raw_data:dict[int, int]) -> list[tuple[int, list[int]]]:
    # A block is a contiguous run, so every id in its range is a key.
    return [(start, [raw_data[i] & 0xFFFF for i in range(start, start + count)])
            for start, count in self._get_blocks(list(raw_data.keys()))]

  async def read_registers(self, reg_ids:list[int]) -> dict[int, int]:
    blocks = self._get_blocks(reg_ids)
    if not blocks: return {}
    raw_data = {}
    cli = await self.connect()
    for start, count in blocks:
      last_err = None
      for _ in range(self.retries):
        try:
          rr = await cli.read_holding_registers(start, count=count, device_id=self.addr)
          if rr.isError(): raise RuntimeError(f"Read error R{start}: {rr}")
          for i, val in enumerate(rr.registers):
            raw_data[start + i] = val
            self.cache_raw[start + i] = val
          last_err = None
          break
        except Exception as e:
          last_err = e
      if last_err: raise last_err
    return raw_data

  async def write_registers(self, raw_data:dict[int, int]) -> int:
    blocks = self._write_blocks(raw_data)
    if not blocks: return 0
    cli = await self.connect()
    written = 0
    for start, values in blocks:
      last_err = None
      for _ in range(self.retries):
        try:
          rr = await cli.write_registers(start, values, device_id=self.addr)
          if rr.isError(): raise RuntimeError(f"Write error R{start}: {rr}")
          for i, val in enumerate(values):
            self.cache_raw[start + i] = val
          written += len(values)
          last_err = None
          break
        except Exception as e:
          last_err = e
      if last_err: raise last_err
    return written

  #------------------------------------------------------------------------------------ Helpers

  @staticmethod
  def _pair_decode(raw32:int, ptype:str, null_raw32:int|None=None):
    """32-bit word → value. Float pairs decode as IEEE-754 big-endian
    (NaN → `None`); integer pairs match `null_raw32` → `None`."""
    if ptype == "float":
      val = struct.unpack(">f", raw32.to_bytes(4, "big"))[0]
      return None if math.isnan(val) else val
    if null_raw32 is not None and raw32 == null_raw32:
      return None
    return raw32

  @staticmethod
  def _pair_encode(val, ptype:str, null_raw32:int|None=None) -> int|None:
    """Inverse of `_pair_decode`. `None` returns the sentinel (NaN for
    float, `null_raw32` for int) or `None` if the pair isn't nullable -
    the caller drops the write in that case."""
    if val is None:
      if ptype == "float":
        return int.from_bytes(struct.pack(">f", float("nan")), "big")
      return null_raw32
    if ptype == "float":
      return int.from_bytes(struct.pack(">f", float(val)), "big")
    if isinstance(val, str): return int(val, 0) & 0xFFFFFFFF
    return int(val) & 0xFFFFFFFF

  def _get_pair_maps(self) -> tuple[dict[int, str], dict[int, list[str]]]:
    pair_part, pair_anchor = {}, {}
    for pair_key, info in self.pairs.items():
      h, l = info.get("high"), info.get("low")
      if not h or not l: continue
      hid, lid = h["id"], l["id"]
      anchor = min(hid, lid)
      pair_part[hid] = pair_key
      pair_part[lid] = pair_key
      pair_anchor.setdefault(anchor, []).append(pair_key)
    return pair_part, pair_anchor

  def _get_pair_ids(self) -> set[int]:
    ids = set()
    for info in self.pairs.values():
      if info.get("high"): ids.add(info["high"]["id"])
      if info.get("low"): ids.add(info["low"]["id"])
    return ids

  def _keys_to_ids(self, keys:list[str]|dict) -> list[int]:
    if isinstance(keys, dict):
      key_list = []
      for k, v in keys.items():
        if isinstance(v, dict):
          for name in v: key_list.append(f"{k}:{name}" if k else name)
        else: key_list.append(k)
    else: key_list = keys
    reg_ids = []
    for k in key_list:
      if k in self.pairs:
        info = self.pairs[k]
        if info.get("high"): reg_ids.append(info["high"]["id"])
        if info.get("low"): reg_ids.append(info["low"]["id"])
      elif (e := self.name_map.get(k)):
        reg_ids.append(e["id"])
    return reg_ids

  def _detect_grouped(self, data:dict) -> bool:
    for v in data.values():
      if isinstance(v, dict): return True
    for k in data.keys():
      if ":" in k: return False
      if k in self.name_map or k in self.pairs: return False
    return self.group

  def _resolve_rule_index(self, entry:dict, pending_raw:dict[int, int]=None) -> int|None:
    rule = entry.get("rule")
    if not rule or "switch" not in rule: return None
    switch_entry = self.name_map.get(rule["switch"])
    if not switch_entry: return None
    switch_id = switch_entry["id"]
    switch_raw = pending_raw.get(switch_id) if pending_raw else None
    if switch_raw is None: switch_raw = self.cache_raw.get(switch_id)
    if switch_raw is None:
      raise RuntimeError(f"Switch '{rule['switch']}' not yet read")
    unit = entry.get("unit")
    if not isinstance(unit, list): return None
    switch_label = switch_entry.get("enum", {}).get(switch_raw, "").lower()
    for i, u in enumerate(unit):
      if u.lower() == switch_label: return i
    return None

  @staticmethod
  def _slot(val, index:int=None, fallback=None):
    """Value for the active rule slot: lists pick `index` (slot 0 when out of
    range), scalars pass through, missing → `fallback`."""
    if isinstance(val, list):
      if index is not None and 0 <= index < len(val): return val[index]
      return val[0] if val else fallback
    return val if val is not None else fallback

  def _get_scale(self, entry:dict, index:int=None) -> float:
    return self._slot(entry.get("scale"), index, 1.0) or 1.0

  def _get_unit(self, entry:dict, index:int=None) -> str|None:
    return self._slot(entry.get("unit"), index)

  def _get_minmax(self, entry:dict, index:int=None) -> tuple[float|None, float|None]:
    return (self._slot(entry.get("min"), index), self._slot(entry.get("max"), index))

  #------------------------------------------------------------------------------ Encode/decode

  def _decode_raw(self, reg_id:int, raw:int):
    entry = self.id_map.get(reg_id)
    if not entry: return raw
    typ = entry.get("type", "uint")
    rule_idx = self._resolve_rule_index(entry) if typ == "rule" else None
    # Nullable sentinel is checked before type decode, so an N/A read returns
    # None rather than -32768 / 65535.
    null_raw = entry.get("null_raw")
    if null_raw is not None and raw == null_raw:
      return None
    scale = self._get_scale(entry, rule_idx)
    if typ == "enum": return entry.get("enum", {}).get(int(raw), str(int(raw)))
    if typ == "ver":
      s = str(int(raw)).zfill(6)
      return f"{int(s[:-4])}.{int(s[-4:-2])}.{int(s[-2:])}"
    if typ == "bool": return bool(raw & 1)
    if typ == "int": return (raw if raw < 0x8000 else raw - 0x10000) / scale
    if typ in ("hex", "uint", "rule"): return raw / scale
    if typ == "bits": return int(raw)   # raw bitmask, never scaled
    return int(raw)

  def _encode_value(
    self, reg_id:int, value:any,
    pending_raw:dict[int, int]=None,
  ) -> int|None:
    """Engineering value → 16-bit raw. `None` returns the sentinel on
    nullable regs, or `None` on non-nullable ones (caller drops the
    write). min/max are advisory - OOR writes go through; the frontend
    marks them red but the firmware decides what to do."""
    entry = self.id_map.get(reg_id)
    if not entry:
      return None if value is None else int(value) & 0xFFFF
    if value is None:
      return entry.get("null_raw")
    typ = entry.get("type", "uint")
    rule_idx = self._resolve_rule_index(entry, pending_raw) if typ == "rule" else None
    scale = self._get_scale(entry, rule_idx)
    if typ == "bool": return 1 if value else 0
    elif typ == "enum":
      enum_map = entry.get("enum", {})
      rev = {v: k for k, v in enum_map.items()}
      s = str(value)
      if s in rev: return rev[s]
      if isinstance(value, (int, float)) and int(value) in enum_map:
        return int(value)
      valid = ", ".join(rev.keys())
      raise ValueError(f"{entry['fullname']}: unknown enum '{value}' (valid: {valid})")
    elif typ == "ver":
      parts = [p for p in str(value).split(".") if p.isdigit()]
      if len(parts) != 3:
        raise ValueError(f"{entry['fullname']}: invalid version '{value}' (expected X.YY.ZZ)")
      raw = int(parts[0]) * 10000 + int(parts[1]) * 100 + int(parts[2])
      if raw > 65535:
        raise ValueError(f"{entry['fullname']}: version '{value}' over uint16 max 6.55.35")
      return raw
    elif typ == "int":
      return int(round(float(value) * scale)) & 0xFFFF
    elif typ in ("hex", "uint", "rule"):
      return int(round(float(value) * scale)) & 0xFFFF
    return int(value) & 0xFFFF

  @staticmethod
  def _put(data:dict, grouped:bool, group, name, fullname, val):
    if grouped:
      if group not in data: data[group] = {}
      data[group][name] = val
    else:
      data[fullname] = val

  def _decode_map(
    self, raw_data:dict[int, int], rws_filter:list[str]=None,
    grouped:bool=None, missing_as_none:bool=False,
  ) -> dict:
    """Raw ids → engineering values, shared by `decode` and `get_cache`.
    Pairs emit once under their pair key; a rule reg with no active slot
    emits None. `missing_as_none` walks the full map and reports unpolled
    registers as None (cache view) instead of skipping them."""
    if grouped is None: grouped = self.group
    data = {}
    pair_part, pair_anchor = self._get_pair_maps()
    emitted = set()
    ids = sorted(self.id_map.keys() if missing_as_none else raw_data.keys())
    for reg_id in ids:
      for pair_key in pair_anchor.get(reg_id, []):
        if pair_key in emitted: continue
        info = self.pairs[pair_key]
        h, l = info.get("high"), info.get("low")
        if not h or not l: continue
        if rws_filter and h["rws"] not in rws_filter: continue
        hr, lr = raw_data.get(h["id"]), raw_data.get(l["id"])
        if hr is None or lr is None:
          if not missing_as_none: continue
          val = None
        else:
          val = self._pair_decode((hr << 16) | lr, h.get("type", "uint"), h.get("null_raw32"))
        emitted.add(pair_key)
        self._put(data, grouped, info.get("group"), info.get("name"), pair_key, val)
      if reg_id in pair_part: continue
      entry = self.id_map.get(reg_id)
      if not entry: continue
      if rws_filter and entry["rws"] not in rws_filter: continue
      raw = raw_data.get(reg_id)
      if raw is None:
        if not missing_as_none: continue
        val = None
      elif entry["type"] == "rule" and self._resolve_rule_index(entry) is None:
        val = None
      else:
        val = self._decode_raw(reg_id, raw)
      self._put(data, grouped, entry["group"], entry["name"], entry["fullname"], val)
    return data

  def decode(self, raw_data:dict[int, int]=None,
    rws_filter:list[str]=None, grouped:bool=None) -> dict:
    if raw_data is None: raw_data = {k: v for k, v in self.cache_raw.items() if v is not None}
    return self._decode_map(raw_data, rws_filter, grouped)

  def encode(self, data:dict, rws_filter:list[str]=None, grouped:bool=None) -> dict[int, int]:
    if grouped is None: grouped = self._detect_grouped(data)
    raw = {}
    pair_ids = self._get_pair_ids()
    # Key-presence (not val-truthiness) gates pair emission so `None`
    # reaches `_pair_encode` and emits the sentinel for nullable pairs.
    for pair_key, pair_info in self.pairs.items():
      group, name = pair_info.get("group"), pair_info.get("name")
      if grouped:
        block = data.get(group)
        if not isinstance(block, dict) or name not in block: continue
        val = block[name]
      else:
        if pair_key not in data: continue
        val = data[pair_key]
      if isinstance(val, tuple): val = val[0]
      h, l = pair_info.get("high"), pair_info.get("low")
      ptype = h.get("type", "uint") if h else "uint"
      val32 = self._pair_encode(val, ptype, h.get("null_raw32") if h else None)
      if val32 is None: continue
      if h and (rws_filter is None or h["rws"] in rws_filter):
        raw[h["id"]] = (val32 >> 16) & 0xFFFF
      if l and (rws_filter is None or l["rws"] in rws_filter):
        raw[l["id"]] = val32 & 0xFFFF
    # Flatten data
    flat = {}
    if grouped:
      for k, v in data.items():
        if not isinstance(v, dict): continue
        for n, val in v.items():
          fullname = f"{k}:{n}" if k else n
          if fullname not in self.pairs: flat[fullname] = val
    else:
      for k, v in data.items():
        if k not in self.pairs: flat[k] = v
    # Pass 1: non-rule
    rule_entries = []
    for fullname, val in flat.items():
      entry = self.name_map.get(fullname)
      if not entry or entry["id"] in pair_ids: continue
      if rws_filter is not None and entry["rws"] not in rws_filter: continue
      if isinstance(val, tuple): val = val[0]
      if entry["type"] == "rule":
        rule_entries.append((entry, val))
      else:
        rv = self._encode_value(entry["id"], val)
        if rv is not None: raw[entry["id"]] = rv
    # Pass 2: rule with pending
    for entry, val in rule_entries:
      if self._resolve_rule_index(entry, raw) is None: continue
      rv = self._encode_value(entry["id"], val, raw)
      if rv is not None: raw[entry["id"]] = rv
    return raw

  #--------------------------------------------------------------------------------- Public API

  async def sync(self, grouped:bool=None) -> dict:
    await self.read_registers(list(self.id_map.keys()))
    return self.get_cache(grouped)

  def resolved_ignored_ids(self) -> set[int]:
    # Resolve `ignore_set` to ids. pair_keys (e.g. "Auth:SecretKey") expand to
    # both halves so ignoring a 32-bit composite drops the whole pair.
    ids = {rid for rid, e in self.id_map.items() if e["fullname"] in self.ignore_set}
    for pair_key in self.ignore_set:
      p = self.pairs.get(pair_key)
      if p:
        if p.get("high"): ids.add(p["high"]["id"])
        if p.get("low"):  ids.add(p["low"]["id"])
    return ids

  async def read(self, keys:list[str]|dict=None,
    rws_filter:list[str]=None, grouped:bool=None) -> dict:
    if keys is not None:
      reg_ids = self._keys_to_ids(keys)
    else:
      if rws_filter is None: rws_filter = ["R"]
      ignored_ids = self.resolved_ignored_ids()
      reg_ids = [rid for rid, e in self.id_map.items()
                 if e["rws"] in rws_filter and rid not in ignored_ids]
    if not reg_ids: return {}
    await self.read_registers(reg_ids)
    return self.decode(
      {rid: self.cache_raw[rid] for rid in reg_ids if self.cache_raw.get(rid) is not None},
      grouped=grouped
    )

  async def write(self, data:dict) -> int:
    raw_data = self.encode(data, ["W", "RW", "RWs"])
    return await self.write_registers(raw_data)

  #-------------------------------------------------------------------------------------- Cache

  def get_cache(self, grouped:bool=None) -> dict:
    return self._decode_map(self.cache_raw, grouped=grouped, missing_as_none=True)

  @property
  def cache(self) -> dict:
    return self.get_cache()

  #--------------------------------------------------------------------------------------- Info

  def reg_info(self, reg_id:int) -> dict|None:
    entry = self.id_map.get(reg_id)
    if not entry: return None
    info = {
      "id": reg_id, "hex": entry["hex"], "name": entry["fullname"],
      "group": entry["group"], "type": entry["type"], "rws": entry["rws"],
      "nullable": entry.get("nullable", False),
      "unit": entry.get("unit"), "scale": entry.get("scale", 1.0),
      "min": entry.get("min"), "max": entry.get("max"), "desc": entry.get("desc"),
      "default": entry.get("default"),
    }
    if entry["type"] == "enum": info["enum"] = entry.get("enum", {})
    if entry["type"] == "bits": info["bits"] = entry.get("bits", {})
    rule = entry.get("rule")
    if rule:
      info["rule"] = {}
      if "switch" in rule: info["rule"]["switch"] = rule["switch"]
      if "high" in rule: info["rule"]["pair"] = "high"
      elif "low" in rule: info["rule"]["pair"] = "low"
    return info

  def pair_info(self, pair_key:str) -> dict|None:
    pair = self.pairs.get(pair_key)
    if not pair: return None
    h, l = pair.get("high"), pair.get("low")
    if not h or not l: return None
    ptype = h.get("type", "uint")
    # Float pairs carry engineering metadata (unit/scale/min/max) from
    # the high half and are implicitly nullable via NaN. uint32 pairs
    # default to the full 32-bit range and need `?` for nullability.
    is_float = ptype == "float"
    nullable = is_float or bool(h.get("nullable"))
    return {
      "id": [h["id"], l["id"]], "hex": [h["hex"], l["hex"]],
      "name": pair_key, "group": pair.get("group"), "type": ptype,
      "rws": h["rws"],
      "nullable": nullable,
      "unit":  h.get("unit")        if is_float else None,
      "scale": h.get("scale", 1.0)  if is_float else 1.0,
      "min":   h.get("min")         if is_float else 0,
      "max":   h.get("max")         if is_float else 0xFFFFFFFF,
      "desc": h.get("desc"), "rule": {"pair": [h["id"], l["id"]], "type": ptype},
    }

  def regs_info(self) -> list[dict]:
    result = []
    seen_pairs = set()
    for rid in sorted(self.id_map.keys()):
      entry = self.id_map[rid]
      rule = entry.get("rule")
      if rule and ("high" in rule or "low" in rule):
        pair_name = rule.get("high") or rule.get("low")
        pair_key = f"{entry['group']}:{pair_name}" if entry["group"] else pair_name
        if pair_key not in seen_pairs:
          seen_pairs.add(pair_key)
          pinfo = self.pair_info(pair_key)
          if pinfo: result.append(pinfo)
        continue
      result.append(self.reg_info(rid))
    return result

  def annotate(self, data:dict=None, fields:list[str]=None) -> dict:
    """Wrap values as `(value, field1, field2, ...)`. Supported field names:
    `unit`, `min`, `max`, `scale`, `type`, `desc`."""
    if data is None: data = self.cache
    if not fields: return data
    grouped = self._detect_grouped(data)
    out = {}
    def get_meta(fullname:str) -> tuple:
      entry = self.name_map.get(fullname)
      if not entry:
        pair = self.pairs.get(fullname)
        if pair and pair.get("high"): entry = pair["high"]
      if not entry: return tuple(None for _ in fields)
      rule_idx = None
      if entry.get("type") == "rule":
        try: rule_idx = self._resolve_rule_index(entry)
        except Exception: pass
      result = []
      for f in fields:
        if f == "unit": result.append(self._get_unit(entry, rule_idx))
        elif f == "min": result.append(self._get_minmax(entry, rule_idx)[0])
        elif f == "max": result.append(self._get_minmax(entry, rule_idx)[1])
        elif f == "scale": result.append(self._get_scale(entry, rule_idx))
        elif f in entry: result.append(entry[f])
        else: result.append(None)
      return tuple(result)
    if grouped:
      for group, block in data.items():
        if not isinstance(block, dict): continue
        out[group] = {}
        for name, val in block.items():
          fullname = f"{group}:{name}" if group else name
          out[group][name] = (val, *get_meta(fullname))
    else:
      for fullname, val in data.items():
        out[fullname] = (val, *get_meta(fullname))
    return out
