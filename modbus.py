"""
Async Modbus RTU master with CSV-based register descriptor.

Parses regs.csv into a typed map (uint/int/bool/enum/bits/hex/ver/rule),
supports `switch=` / `high=` / `low=` rules and caches raw 16-bit words.
The map is always complete - `ignore_set` filters at read time only
(pair-aware), so the DB schema and `regs_info()` cover every register
and the frontend can show or hide ignored entries on its own.

A `?` prefix on `type` marks a register nullable - a reserved raw value
decodes to `None`. Defaults follow SunSpec; the `null` CSV column
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

# Columns the library reads. Anything else is the project's own (this app adds
# `auth`) and rides along in `extra`, back out through `reg_info()`.
COLUMNS = {"id", "hex", "name", "rws", "type", "unit", "scale",
           "min", "max", "desc", "rule", "default", "null"}

#----------------------------------------------------------------------------------- Regmap parsing

def _float(s, fallback=None):
  try: return float(s)
  except ValueError: return fallback

def _num_or_str(s):
  try: return int(s)
  except ValueError: return _float(s, s)

def _bool(value) -> bool:
  """Spelled-out text too - every non-empty string is otherwise truthy."""
  if isinstance(value, str): return value.strip().lower() not in ("", "0", "false", "no", "off")
  return bool(value)

def _text(val) -> str|None:
  s = str(val).strip() if val is not None else ""
  return s if s not in ("", "-") else None

def _parse_slots(val, conv, empty=None):
  """CSV cell → value or `/`-separated rule-slot list. Empty / `-` → `empty`;
  `conv` maps one token and supplies its own fallback on garbage."""
  s = str(val).strip()
  if s in ("", "-"): return empty
  if "/" in s: return [_parse_slots(x, conv, empty) for x in s.split("/")]
  return conv(s)

def _slot(val, index:int=None, fallback=None):
  """Value for the active rule slot: lists pick `index` (slot 0 when out of
  range), scalars pass through, missing → `fallback`."""
  if isinstance(val, list):
    if index is not None and 0 <= index < len(val): return val[index]
    return val[0] if val else fallback
  return val if val is not None else fallback

def _parse_enum(text:str) -> dict[int, str]:
  if not text or text == "-": return {}
  text = text.replace(":", "=")
  out = {}
  for tok in text.split():
    if "=" not in tok: continue
    k, v = tok.split("=", 1)
    if k.strip().isdigit(): out[int(k)] = v.strip()
  return out

def _parse_rule(rule:str) -> dict[str, str]|None:
  if not rule or rule == "-": return None
  out = {}
  for part in rule.split(";"):
    if "=" in part:
      k, v = part.split("=", 1)
      out[k.strip()] = v.strip()
  return out if out else None

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

def _null_raw_16(typ:str, nullable:bool, override:int|None) -> int|None:
  if not nullable: return None
  if override is not None:
    # Signed CSV input (e.g. -1) wraps into unsigned raw space so it
    # matches the on-wire word directly.
    if typ == "int" and override < 0:
      override = override + 0x10000
    return override & 0xFFFF
  return NULL_SENTINELS_16.get(typ)

def _null_raw_32(entry:dict) -> int|None:
  if not entry.get("nullable"): return None
  typ = entry["type"]
  # Float pairs use NaN at decode time, no integer comparison needed.
  if typ == "float": return None
  override = entry.get("null_override")
  if override is not None:
    if typ == "int" and override < 0:
      override = override + 0x100000000
    return override & 0xFFFFFFFF
  return NULL_SENTINELS_32.get(typ)

#------------------------------------------------------------------------------------------- Master

class ModbusMaster:

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
    # Transport builder `(mb) → client`; None → serial client from the params above.
    self.client_factory = client_factory
    self.id_map: dict[int, dict] = {}
    self.name_map: dict[str, dict] = {}
    self.pairs: dict[str, dict] = {}
    for row in CSV.load(regmap_file):
      entry = self._parse_reg_row(row)
      self.id_map[entry["id"]] = entry
      self.name_map[entry["fullname"]] = entry
      rule = entry.get("rule")
      if rule:
        group_name = entry["group"]
        for part in ("high", "low"):
          if part in rule:
            pair_name = rule[part]
            pair_key = f"{group_name}:{pair_name}" if group_name else pair_name
            pair = self.pairs.setdefault(pair_key, {"group": group_name, "name": pair_name})
            pair[part] = entry
    # Pair sentinels need the high/low table built first.
    for pair in self.pairs.values():
      high = pair.get("high")
      if high: high["null_raw32"] = _null_raw_32(high)
    self.cache_raw: dict[int, int|None] = {rid: None for rid in self.id_map}
    self.client: AsyncModbusSerialClient|None = None

  def _parse_reg_row(self, row:dict) -> dict:
    reg_id = int(row["id"])
    fullname = row["name"].strip()
    group, name = fullname.split(":", 1) if ":" in fullname else (None, fullname)
    hex_str = str(row["hex"]).strip()
    try: hex_val = int(hex_str, 0)
    except ValueError: hex_val = reg_id
    if hex_val != reg_id: hex_str = f"0x{reg_id:02X}"
    rws_map = {"R": "R", "RW": "RW", "RWS": "RWs", "W": "W"}
    rws = rws_map.get(str(row.get("rws", "R")).strip().upper(), "R")
    # `?` prefix → nullable. Strip so downstream sees the plain type.
    typ = str(row.get("type", "uint")).strip().lower()
    nullable = typ.startswith("?")
    if nullable: typ = typ[1:].strip()
    null_override = _parse_null_override(row.get("null"))
    entry = {
      "id": reg_id, "hex": hex_str, "group": group, "name": name, "fullname": fullname,
      "rws": rws, "type": typ,
      "nullable": nullable,
      "null_override": null_override,
      "null_raw": _null_raw_16(typ, nullable, null_override),
      "unit": _parse_slots(row.get("unit", ""), lambda s: s),
      "scale": _parse_slots(row.get("scale", "1"), lambda s: _float(s, 1.0), 1.0),
      "min": _parse_slots(row.get("min", ""), _float),
      "max": _parse_slots(row.get("max", ""), _float),
      "desc": _text(row.get("desc")),
      "rule": _parse_rule(row.get("rule", "")),
      "default": _parse_slots(row.get("default", ""), _bool if typ == "bool" else _num_or_str),
      "extra": {k: _text(v) for k, v in row.items() if k not in COLUMNS},
    }
    if typ == "enum": entry["enum"] = _parse_enum(row.get("unit", ""))
    # For bits the unit column holds the bit→label map, not a real unit.
    if typ == "bits":
      entry["bits"] = _parse_enum(row.get("unit", ""))
      entry["unit"] = None
    return entry

  #------------------------------------------------------------------------------------- Connection

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

  #-------------------------------------------------------------------------------------- Transport

  def _contiguous_blocks(self, ids:list[int]) -> list[tuple[int, int]]:
    """Sorted unique ids → `(start, count)` runs capped at `max_block`."""
    ids = sorted(set(ids))
    if not ids: return []
    blocks = []
    start = prev = ids[0]
    for rid in ids[1:]:
      if rid == prev + 1 and (rid - start + 1) <= self.max_block: prev = rid
      else:
        blocks.append((start, prev - start + 1))
        start = prev = rid
    blocks.append((start, prev - start + 1))
    return blocks

  def _write_blocks(self, raw_data:dict[int, int]) -> list[tuple[int, list[int]]]:
    # A block is a contiguous run, so every id in its range is a key.
    return [(start, [raw_data[i] & 0xFFFF for i in range(start, start + count)])
            for start, count in self._contiguous_blocks(list(raw_data.keys()))]

  async def _retry(self, op):
    """Run `op` up to `retries` times, raising the last failure."""
    last_err = None
    for _ in range(self.retries):
      try: return await op()
      except Exception as e: last_err = e
    raise last_err

  async def read_registers(self, reg_ids:list[int]) -> dict[int, int]:
    blocks = self._contiguous_blocks(reg_ids)
    if not blocks: return {}
    client = await self.connect()
    raw_data = {}
    for start, count in blocks:
      async def op(start=start, count=count):
        resp = await client.read_holding_registers(start, count=count, device_id=self.addr)
        if resp.isError(): raise RuntimeError(f"Read error R{start}: {resp}")
        return resp
      resp = await self._retry(op)
      for i, val in enumerate(resp.registers):
        raw_data[start + i] = val
        self.cache_raw[start + i] = val
    return raw_data

  async def write_registers(self, raw_data:dict[int, int]) -> int:
    blocks = self._write_blocks(raw_data)
    if not blocks: return 0
    client = await self.connect()
    written = 0
    for start, values in blocks:
      async def op(start=start, values=values):
        resp = await client.write_registers(start, values, device_id=self.addr)
        if resp.isError(): raise RuntimeError(f"Write error R{start}: {resp}")
      await self._retry(op)
      for i, val in enumerate(values):
        self.cache_raw[start + i] = val
      written += len(values)
    return written

  #---------------------------------------------------------------------------- Pair & rule helpers

  @staticmethod
  def _pair_decode(raw32:int, pair_type:str, null_raw32:int|None=None):
    """32-bit word → value. Float pairs decode as IEEE-754 big-endian
    (NaN → `None`); integer pairs match `null_raw32` → `None`."""
    if pair_type == "float":
      val = struct.unpack(">f", raw32.to_bytes(4, "big"))[0]
      return None if math.isnan(val) else val
    if null_raw32 is not None and raw32 == null_raw32:
      return None
    return raw32

  @staticmethod
  def _pair_encode(val, pair_type:str, null_raw32:int|None=None) -> int|None:
    """Inverse of `_pair_decode`. `None` returns the sentinel (NaN for
    float, `null_raw32` for int) or `None` if the pair isn't nullable -
    the caller drops the write in that case."""
    if val is None:
      if pair_type == "float":
        return int.from_bytes(struct.pack(">f", float("nan")), "big")
      return null_raw32
    if pair_type == "float":
      return int.from_bytes(struct.pack(">f", float(val)), "big")
    if isinstance(val, str): return int(val, 0) & 0xFFFFFFFF
    return int(val) & 0xFFFFFFFF

  def _get_pair_maps(self) -> tuple[dict[int, str], dict[int, list[str]]]:
    pair_part, pair_anchor = {}, {}
    for pair_key, pair in self.pairs.items():
      high, low = pair.get("high"), pair.get("low")
      if not high or not low: continue
      anchor = min(high["id"], low["id"])
      pair_part[high["id"]] = pair_key
      pair_part[low["id"]] = pair_key
      pair_anchor.setdefault(anchor, []).append(pair_key)
    return pair_part, pair_anchor

  def _get_pair_ids(self) -> set[int]:
    ids = set()
    for pair in self.pairs.values():
      if pair.get("high"): ids.add(pair["high"]["id"])
      if pair.get("low"): ids.add(pair["low"]["id"])
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
    for key in key_list:
      if key in self.pairs:
        pair = self.pairs[key]
        if pair.get("high"): reg_ids.append(pair["high"]["id"])
        if pair.get("low"): reg_ids.append(pair["low"]["id"])
      elif (entry := self.name_map.get(key)):
        reg_ids.append(entry["id"])
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
    for i, label in enumerate(unit):
      if label.lower() == switch_label: return i
    return None

  def _get_scale(self, entry:dict, index:int=None) -> float:
    return _slot(entry.get("scale"), index, 1.0) or 1.0

  def _get_unit(self, entry:dict, index:int=None) -> str|None:
    return _slot(entry.get("unit"), index)

  def _get_minmax(self, entry:dict, index:int=None) -> tuple[float|None, float|None]:
    return (_slot(entry.get("min"), index), _slot(entry.get("max"), index))

  #---------------------------------------------------------------------------------- Encode/decode

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
    if typ == "bits": return int(raw)  # raw bitmask, never scaled
    return int(raw)

  def _encode_value(
    self, reg_id:int, value:any,
    pending_raw:dict[int, int]=None,
  ) -> int|None:
    """Engineering value → 16-bit raw. `None` returns the sentinel on
    nullable regs, or `None` on non-nullable ones (caller drops the
    write). min/max are advisory - out-of-range writes go through and
    the firmware decides what to do."""
    entry = self.id_map.get(reg_id)
    if not entry:
      return None if value is None else int(value) & 0xFFFF
    if value is None:
      return entry.get("null_raw")
    typ = entry.get("type", "uint")
    rule_idx = self._resolve_rule_index(entry, pending_raw) if typ == "rule" else None
    scale = self._get_scale(entry, rule_idx)
    if typ == "bool": return 1 if _bool(value) else 0
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
        pair = self.pairs[pair_key]
        high, low = pair.get("high"), pair.get("low")
        if not high or not low: continue
        if rws_filter and high["rws"] not in rws_filter: continue
        high_raw, low_raw = raw_data.get(high["id"]), raw_data.get(low["id"])
        if high_raw is None or low_raw is None:
          if not missing_as_none: continue
          val = None
        else:
          val = self._pair_decode(
            (high_raw << 16) | low_raw, high.get("type", "uint"), high.get("null_raw32"))
        emitted.add(pair_key)
        self._put(data, grouped, pair.get("group"), pair.get("name"), pair_key, val)
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
    raw_data = {}
    pair_ids = self._get_pair_ids()
    # Key-presence (not val-truthiness) gates pair emission so `None`
    # reaches `_pair_encode` and emits the sentinel for nullable pairs.
    for pair_key, pair in self.pairs.items():
      group, name = pair.get("group"), pair.get("name")
      if grouped:
        block = data.get(group)
        if not isinstance(block, dict) or name not in block: continue
        val = block[name]
      else:
        if pair_key not in data: continue
        val = data[pair_key]
      if isinstance(val, tuple): val = val[0]
      high, low = pair.get("high"), pair.get("low")
      pair_type = high.get("type", "uint") if high else "uint"
      val32 = self._pair_encode(val, pair_type, high.get("null_raw32") if high else None)
      if val32 is None: continue
      if high and (rws_filter is None or high["rws"] in rws_filter):
        raw_data[high["id"]] = (val32 >> 16) & 0xFFFF
      if low and (rws_filter is None or low["rws"] in rws_filter):
        raw_data[low["id"]] = val32 & 0xFFFF
    # Flatten grouped input, pairs already handled above.
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
    # Non-rule regs go first so rule regs can resolve their switch from
    # the pending raw values.
    rule_entries = []
    for fullname, val in flat.items():
      entry = self.name_map.get(fullname)
      if not entry or entry["id"] in pair_ids: continue
      if rws_filter is not None and entry["rws"] not in rws_filter: continue
      if isinstance(val, tuple): val = val[0]
      if entry["type"] == "rule":
        rule_entries.append((entry, val))
      else:
        raw_val = self._encode_value(entry["id"], val)
        if raw_val is not None: raw_data[entry["id"]] = raw_val
    for entry, val in rule_entries:
      if self._resolve_rule_index(entry, raw_data) is None: continue
      raw_val = self._encode_value(entry["id"], val, raw_data)
      if raw_val is not None: raw_data[entry["id"]] = raw_val
    return raw_data

  #------------------------------------------------------------------------------------- Public API

  async def sync(self, grouped:bool=None) -> dict:
    await self.read_registers(list(self.id_map.keys()))
    return self.get_cache(grouped)

  def resolved_ignored_ids(self) -> set[int]:
    # Pair keys (e.g. "Auth:SecretKey") expand to both halves so ignoring
    # a 32-bit composite drops the whole pair.
    ids = {rid for rid, entry in self.id_map.items() if entry["fullname"] in self.ignore_set}
    for pair_key in self.ignore_set:
      pair = self.pairs.get(pair_key)
      if pair:
        if pair.get("high"): ids.add(pair["high"]["id"])
        if pair.get("low"): ids.add(pair["low"]["id"])
    return ids

  async def read(self, keys:list[str]|dict=None,
    rws_filter:list[str]=None, grouped:bool=None) -> dict:
    if keys is not None:
      reg_ids = self._keys_to_ids(keys)
    else:
      if rws_filter is None: rws_filter = ["R"]
      ignored_ids = self.resolved_ignored_ids()
      reg_ids = [rid for rid, entry in self.id_map.items()
                 if entry["rws"] in rws_filter and rid not in ignored_ids]
    if not reg_ids: return {}
    await self.read_registers(reg_ids)
    return self.decode(
      {rid: self.cache_raw[rid] for rid in reg_ids if self.cache_raw.get(rid) is not None},
      grouped=grouped
    )

  async def write(self, data:dict) -> int:
    raw_data = self.encode(data, ["W", "RW", "RWs"])
    return await self.write_registers(raw_data)

  #------------------------------------------------------------------------------------------ Cache

  def get_cache(self, grouped:bool=None) -> dict:
    return self._decode_map(self.cache_raw, grouped=grouped, missing_as_none=True)

  @property
  def cache(self) -> dict:
    return self.get_cache()

  #------------------------------------------------------------------------------------------- Info

  def reg_info(self, reg_id:int) -> dict|None:
    entry = self.id_map.get(reg_id)
    if not entry: return None
    info = {
      **entry["extra"],
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
    high, low = pair.get("high"), pair.get("low")
    if not high or not low: return None
    pair_type = high.get("type", "uint")
    # Float pairs take engineering metadata from the high half and are nullable
    # via NaN; integer pairs span the full range and need `?` to be nullable.
    is_float = pair_type == "float"
    nullable = is_float or bool(high.get("nullable"))
    return {
      **high["extra"],
      "id": [high["id"], low["id"]], "hex": [high["hex"], low["hex"]],
      "name": pair_key, "group": pair.get("group"), "type": pair_type,
      "rws": high["rws"],
      "nullable": nullable,
      "unit": high.get("unit") if is_float else None,
      "scale": high.get("scale", 1.0) if is_float else 1.0,
      "min": high.get("min") if is_float else 0,
      "max": high.get("max") if is_float else 0xFFFFFFFF,
      "desc": high.get("desc"), "rule": {"pair": [high["id"], low["id"]], "type": pair_type},
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
          info = self.pair_info(pair_key)
          if info: result.append(info)
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
      for field in fields:
        if field == "unit": result.append(self._get_unit(entry, rule_idx))
        elif field == "min": result.append(self._get_minmax(entry, rule_idx)[0])
        elif field == "max": result.append(self._get_minmax(entry, rule_idx)[1])
        elif field == "scale": result.append(self._get_scale(entry, rule_idx))
        elif field in entry: result.append(entry[field])
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
