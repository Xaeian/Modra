# modbus.py

from pymodbus.client import AsyncModbusSerialClient
from typing import Literal
from xaeian import CSV

class ModbusMaster:

  @staticmethod
  def _parse_scale(scale:str|int|float) -> float|list[float]:
    s = str(scale).strip()
    if s == "" or s == "-": return 1.0
    if "/" in s: return [ModbusMaster._parse_scale(x) for x in s.split("/")]
    try: return float(s)
    except ValueError: return 1.0

  @staticmethod
  def _parse_minmax(val:str) -> float|list[float]|None:
    s = str(val).strip()
    if s == "" or s == "-": return None
    if "/" in s: return [ModbusMaster._parse_minmax(x) for x in s.split("/")]
    try: return float(s)
    except ValueError: return None

  @staticmethod
  def _parse_unit(unit:str) -> str|list[str]|None:
    s = str(unit).strip()
    if s == "" or s == "-": return None
    if "/" in s: return [x.strip() for x in s.split("/")]
    return s

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

  def __init__(
    self,
    port: str,
    regmap_file: str,
    addr: int = 1,
    baudrate: int = 9600,
    parity: Literal["N","O","E"] = "N",
    stopbits: Literal[1,2] = 1,
    timeout: float = 1,
    retries: int = 2,
    group: bool = True,
    max_block: int = 64
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
    self.groups: dict[str, dict[str, dict]] = {}
    self.id_map: dict[int, dict] = {}
    self.name_map: dict[str, dict] = {}
    self.pairs: dict[str, dict] = {}
    # Load register map
    for reg_row in CSV.load(regmap_file):
      if str(reg_row.get("hide", "")).strip().lower() == "true": continue  # hide
      entry = self._parse_reg_row(reg_row)
      reg_id, group, name, fullname = entry["id"], entry["group"], entry["name"], entry["fullname"]
      self.id_map[reg_id] = entry
      self.name_map[fullname] = entry
      if group not in self.groups: self.groups[group] = {}
      self.groups[group][name] = entry
      rule = entry.get("rule")
      if rule:
        for part in ("high", "low"):
          if part in rule:
            pair_name = rule[part]
            pair_key = f"{group}:{pair_name}" if group else pair_name
            if pair_key not in self.pairs:
              self.pairs[pair_key] = {"group": group, "name": pair_name}
            self.pairs[pair_key][part] = entry
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
    rws_map = {"R": "R", "RT": "Rt", "RW": "RW", "RWS": "RWs", "W": "W"}
    rws_val = rws_map.get(str(row.get("rws", "R")).strip().upper(), "R")
    type_val = str(row.get("type", "uint")).strip().lower()
    entry = {
      "id": reg_id, "hex": hex_str, "group": group, "name": name, "fullname": name_full,
      "rws": rws_val, "type": type_val,
      "unit": self._parse_unit(row.get("unit", "")),
      "scale": self._parse_scale(row.get("scale", "1")),
      "min": self._parse_minmax(row.get("min", "")),
      "max": self._parse_minmax(row.get("max", "")),
      "desc": row.get("desc") if row.get("desc") not in ("", "-") else None,
      "rule": self._parse_rule(row.get("rule", "")),
    }
    if type_val == "enum": entry["enum"] = self._parse_enum(row.get("unit", ""))
    return entry

  #--------------------------------------------------------------------------------- connection

  async def connect(self) -> AsyncModbusSerialClient:
    if self.client and self.client.connected: return self.client
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

  def reinit(self, addr:int=None, baudrate:int=None,
    parity:Literal["N","O","E"]=None, stopbits:Literal[1,2]=None,
    timeout:float=None, retries:int=None):
    if addr is not None: self.addr = addr
    if baudrate is not None: self.baudrate = baudrate
    if parity is not None: self.parity = parity
    if stopbits is not None: self.stopbits = stopbits
    if timeout is not None: self.timeout = timeout
    if retries is not None: self.retries = max(1, retries)
    if self.client:
      self.client.close()
      self.client = None

  #---------------------------------------------------------------------------------- low-level

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
    ids = sorted(raw_data.keys())
    if not ids: return []
    blocks = []
    start = prev = ids[0]
    for a in ids[1:]:
      if a == prev + 1 and (a - start + 1) <= self.max_block: prev = a
      else:
        blocks.append((start, [(raw_data.get(i, 0) & 0xFFFF) for i in range(start, prev + 1)]))
        start = prev = a
    blocks.append((start, [(raw_data.get(i, 0) & 0xFFFF) for i in range(start, prev + 1)]))
    return blocks

  async def read_registers(self, reg_ids:list[int]) -> dict[int, int]:
    blocks = self._get_blocks(reg_ids)
    if not blocks: return {}
    raw_data = {}
    cli = await self.connect()
    for start, count in blocks:
      last_err = None
      for attempt in range(self.retries):
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
      for attempt in range(self.retries):
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

  #------------------------------------------------------------------------------------ helpers

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
      raise RuntimeError(f"Switch '{rule['switch']}' not synced - call sync() first")
    unit = entry.get("unit")
    if not isinstance(unit, list): return None
    switch_label = switch_entry.get("enum", {}).get(switch_raw, "").lower()
    for i, u in enumerate(unit):
      if u.lower() == switch_label: return i
    return None

  def _get_scale(self, entry:dict, index:int=None) -> float:
    scale = entry.get("scale", 1.0)
    if isinstance(scale, list):
      return scale[index] if index is not None and 0 <= index < len(scale) else scale[0] if scale else 1.0
    return scale if scale else 1.0

  def _get_unit(self, entry:dict, index:int=None) -> str|None:
    unit = entry.get("unit")
    if isinstance(unit, list):
      return unit[index] if index is not None and 0 <= index < len(unit) else unit[0] if unit else None
    return unit

  def _get_minmax(self, entry:dict, index:int=None) -> tuple[float|None, float|None]:
    mn, mx = entry.get("min"), entry.get("max")
    if isinstance(mn, list):
      mn = mn[index] if index is not None and 0 <= index < len(mn) else mn[0] if mn else None
    if isinstance(mx, list):
      mx = mx[index] if index is not None and 0 <= index < len(mx) else mx[0] if mx else None
    return (mn, mx)

  #------------------------------------------------------------------------------ encode/decode

  def _decode_raw(self, reg_id:int, raw:int) -> tuple[any, str|None]:
    entry = self.id_map.get(reg_id)
    if not entry: return (raw, None)
    typ = entry.get("type", "uint")
    rule_idx = self._resolve_rule_index(entry) if typ == "rule" else None
    unit = self._get_unit(entry, rule_idx)
    scale = self._get_scale(entry, rule_idx)
    if typ == "enum":
      val = entry.get("enum", {}).get(int(raw), str(int(raw)))
    elif typ == "ver":
      s = str(int(raw)).zfill(6)
      val = f"{int(s[:-4])}.{int(s[-4:-2])}.{int(s[-2:])}"
    elif typ == "bool": val = bool(raw & 1)
    elif typ == "int": val = (raw if raw < 0x8000 else raw - 0x10000) / scale
    elif typ in ("hex", "uint", "rule"): val = raw / scale
    else: val = int(raw)
    return (val, unit)

  def _encode_value(self, reg_id:int, value:any, pending_raw:dict[int, int]=None,validate:bool=True) -> int:
    entry = self.id_map.get(reg_id)
    if not entry: return int(value) & 0xFFFF
    typ = entry.get("type", "uint")
    rule_idx = self._resolve_rule_index(entry, pending_raw) if typ == "rule" else None
    scale = self._get_scale(entry, rule_idx)
    if validate and typ not in ("bool", "enum", "ver"):
      mn, mx = self._get_minmax(entry, rule_idx)
      fval = float(value)
      if mn is not None and fval < mn:
        raise ValueError(f"{entry['fullname']}: {value} < min ({mn})")
      if mx is not None and fval > mx:
        raise ValueError(f"{entry['fullname']}: {value} > max ({mx})")
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
        raise ValueError(f"{entry['fullname']}: version '{value}' exceeds uint16 (max 6.55.35)")
      return raw
    elif typ == "int":
      return int(round(float(value) * scale)) & 0xFFFF
    elif typ in ("hex", "uint", "rule"):
      return int(round(float(value) * scale)) & 0xFFFF
    return int(value) & 0xFFFF

  def decode(self, raw_data:dict[int, int]=None,
    rws_filter:list[str]=None, grouped:bool=None) -> dict:
    if raw_data is None: raw_data = {k: v for k, v in self.cache_raw.items() if v is not None}
    if rws_filter is None: rws_filter = []
    if grouped is None: grouped = self.group
    data = {}
    pair_part, pair_anchor = self._get_pair_maps()
    emitted_pairs = set()
    for reg_id in sorted(raw_data.keys()):
      if reg_id in pair_anchor:
        for pair_key in pair_anchor[reg_id]:
          if pair_key in emitted_pairs: continue
          info = self.pairs[pair_key]
          h, l = info.get("high"), info.get("low")
          if not h or not l: continue
          if rws_filter and h["rws"] not in rws_filter: continue
          hr, lr = raw_data.get(h["id"]), raw_data.get(l["id"])
          if hr is not None and lr is not None:
            val = (hr << 16) | lr
            emitted_pairs.add(pair_key)
            group, name = info.get("group"), info.get("name")
            if grouped:
              if group not in data: data[group] = {}
              data[group][name] = val
            else:
              data[pair_key] = val
      if reg_id in pair_part: continue
      raw = raw_data.get(reg_id)
      if raw is None: continue
      entry = self.id_map.get(reg_id)
      if not entry: continue
      if rws_filter and entry["rws"] not in rws_filter: continue
      typ = entry.get("type", "uint")
      if typ == "rule":
        rule_idx = self._resolve_rule_index(entry)
        val = None if rule_idx is None else self._decode_raw(reg_id, raw)[0]
      else:
        val = self._decode_raw(reg_id, raw)[0]
      if grouped:
        if entry["group"] not in data: data[entry["group"]] = {}
        data[entry["group"]][entry["name"]] = val
      else:
        data[entry["fullname"]] = val
    return data

  def encode(self, data:dict, rws_filter:list[str]=None, grouped:bool=None) -> dict[int, int]:
    if grouped is None: grouped = self._detect_grouped(data)
    raw = {}
    pair_ids = self._get_pair_ids()
    # Handle pairs
    for pair_key, pair_info in self.pairs.items():
      group, name = pair_info.get("group"), pair_info.get("name")
      val = None
      if grouped and group in data and isinstance(data[group], dict):
        val = data[group].get(name)
      elif not grouped:
        val = data.get(pair_key)
      if val is not None:
        if isinstance(val, tuple): val = val[0]
        val32 = int(val, 0) if isinstance(val, str) else int(val)
        h, l = pair_info.get("high"), pair_info.get("low")
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
        raw[entry["id"]] = self._encode_value(entry["id"], val)
    # Pass 2: rule with pending
    for entry, val in rule_entries:
      if self._resolve_rule_index(entry, raw) is None: continue
      raw[entry["id"]] = self._encode_value(entry["id"], val, raw)
    return raw

  #--------------------------------------------------------------------------------- public API

  async def sync(self, grouped:bool=None) -> dict:
    await self.read_registers(list(self.id_map.keys()))
    return self.get_cache(grouped)

  async def read(self, keys:list[str]|dict=None,
    rws_filter:list[str]=None, grouped:bool=None) -> dict:
    if keys is not None:
      reg_ids = self._keys_to_ids(keys)
    else:
      if rws_filter is None: rws_filter = ["R"]
      reg_ids = [rid for rid, e in self.id_map.items() if e["rws"] in rws_filter]
    if not reg_ids: return {}
    await self.read_registers(reg_ids)
    return self.decode(
      {rid: self.cache_raw[rid] for rid in reg_ids if self.cache_raw.get(rid) is not None},
      grouped=grouped
    )

  async def write(self, data:dict) -> int:
    raw_data = self.encode(data, ["W", "RW", "RWs"])
    return await self.write_registers(raw_data)

  async def write_sync(self, data:dict) -> tuple[dict, dict|list|None]:
    """Write RW/RWs, read back per block. Returns (cache, diff)."""
    grouped = self._detect_grouped(data)
    raw_write = self.encode(data, ["RW", "RWs"])
    blocks = self._write_blocks(raw_write)
    if not blocks: return self.get_cache(grouped), None
    cli = await self.connect()
    for start, values in blocks:
      rr = await cli.write_registers(start, values, device_id=self.addr)
      if rr.isError(): raise RuntimeError(f"Write error R{start}: {rr}")
      for i, val in enumerate(values):
        self.cache_raw[start + i] = val
      rr = await cli.read_holding_registers(start, count=len(values), device_id=self.addr)
      if rr.isError(): raise RuntimeError(f"Readback error R{start}: {rr}")
      for i, val in enumerate(rr.registers):
        self.cache_raw[start + i] = val
    diff_ids = [rid for rid, exp in raw_write.items() if self.cache_raw.get(rid) != exp]
    if not diff_ids: return self.get_cache(grouped), None
    if grouped:
      diff = {}
      for rid in diff_ids:
        entry = self.id_map.get(rid)
        if entry:
          g, n = entry["group"], entry["name"]
          if g not in diff: diff[g] = []
          diff[g].append(n)
      return self.get_cache(grouped), diff
    diff = [self.id_map[rid]["fullname"] for rid in diff_ids if rid in self.id_map]
    return self.get_cache(grouped), diff

  #-------------------------------------------------------------------------------------- cache

  def get_cache(self, grouped:bool=None) -> dict:
    if grouped is None: grouped = self.group
    data = {}
    pair_part, pair_anchor = self._get_pair_maps()
    for reg_id in sorted(self.id_map.keys()):
      if reg_id in pair_anchor:
        for pair_key in pair_anchor[reg_id]:
          info = self.pairs[pair_key]
          h, l = info.get("high"), info.get("low")
          val = None
          if h and l:
            hr, lr = self.cache_raw.get(h["id"]), self.cache_raw.get(l["id"])
            if hr is not None and lr is not None:
              val = (hr << 16) | lr
          group, name = info.get("group"), info.get("name")
          if grouped:
            if group not in data: data[group] = {}
            data[group][name] = val
          else:
            data[pair_key] = val
        continue
      if reg_id in pair_part: continue
      entry = self.id_map[reg_id]
      raw = self.cache_raw.get(reg_id)
      typ = entry.get("type", "uint")
      if raw is not None:
        if typ == "rule":
          rule_idx = self._resolve_rule_index(entry)
          val = None if rule_idx is None else self._decode_raw(reg_id, raw)[0]
        else:
          val = self._decode_raw(reg_id, raw)[0]
      else:
        val = None
      if grouped:
        if entry["group"] not in data: data[entry["group"]] = {}
        data[entry["group"]][entry["name"]] = val
      else:
        data[entry["fullname"]] = val
    return data

  def set_cache(self, data:dict, grouped:bool=None):
    raw_data = self.encode(data, grouped=grouped)
    for reg_id, raw in raw_data.items():
      self.cache_raw[reg_id] = raw

  @property
  def cache(self) -> dict:
    return self.get_cache()

  @cache.setter
  def cache(self, data:dict):
    self.set_cache(data)

  #--------------------------------------------------------------------------------------- info

  def reg_info(self, reg_id: int) -> dict|None:
    entry = self.id_map.get(reg_id)
    if not entry: return None
    info = {
      "id": reg_id, "hex": entry["hex"], "name": entry["fullname"],
      "group": entry["group"], "type": entry["type"], "rws": entry["rws"],
      "unit": entry.get("unit"), "scale": entry.get("scale", 1.0),
      "min": entry.get("min"), "max": entry.get("max"), "desc": entry.get("desc"),
    }
    if entry["type"] == "enum": info["enum"] = entry.get("enum", {})
    rule = entry.get("rule")
    if rule:
      info["rule"] = {}
      if "switch" in rule: info["rule"]["switch"] = rule["switch"]
      if "high" in rule:
        info["rule"]["pair"], info["rule"]["pair_name"] = "high", rule["high"]
      elif "low" in rule:
        info["rule"]["pair"], info["rule"]["pair_name"] = "low", rule["low"]
    return info

  def pair_info(self, pair_key:str) -> dict|None:
    pair = self.pairs.get(pair_key)
    if not pair: return None
    h, l = pair.get("high"), pair.get("low")
    if not h or not l: return None
    return {
      "id": [h["id"], l["id"]], "hex": [h["hex"], l["hex"]],
      "name": pair_key, "group": pair.get("group"), "type": h.get("type", "uint"),
      "rws": h["rws"], "unit": None, "scale": 1.0, "min": 0, "max": 0xFFFFFFFF,
      "desc": h.get("desc"), "rule": {"pair": [h["id"], l["id"]]},
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
    """Add metadata to values as tuples: (value, field1, field2, ...)
    Fields: 'unit', 'min', 'max', 'scale', 'type', 'desc'"""
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
        except: pass
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