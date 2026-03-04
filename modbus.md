# ModbusMaster

Async Modbus RTU master with CSV-based register map, automatic encoding/decoding, and caching.

## Requirements

```
pymodbus
```

## Quick Start

```python
from modbus import ModbusMaster

mb = ModbusMaster("/dev/ttyUSB0", "regmap.csv", addr=1, baudrate=9600)

# Always sync first
data = await mb.sync()

# Read specific registers
data = await mb.read(["Ctrl:Mode", "Ctrl:Speed"])

# Write
await mb.write({"Ctrl": {"Mode": "rpm", "Speed": 1500}})

await mb.disconnect()
```

## Register Map CSV

| Column  | Description                              | Example               |
| ------- | ---------------------------------------- | --------------------- |
| `id`    | Register address                         | `10`                  |
| `hex`   | Hex address (optional)                   | `0x0A`                |
| `name`  | `Group:Name` format                      | `Ctrl:Mode`           |
| `rws`   | Access: R, Rt, W, RW, RWs (storage)      | `RW`                  |
| `type`  | Data type                                | `uint`                |
| `unit`  | Unit or enum definition                  | `rpm` or `0=off 1=on` |
| `scale` | Multiplier (or `/` separated list)       | `10` or `1/10/100`    |
| `min`   | Minimum value                            | `0`                   |
| `max`   | Maximum value                            | `10000`               |
| `desc`  | Description                              | `Motor speed`         |
| `rule`  | Special rules                            | `switch=Ctrl:Mode`    |
| `hide`  | If `true`, register excluded from map   | `true`                |

### Access Modes (rws)

| Value | Description                                                  |
| ----- | ------------------------------------------------------------ |
| `R`   | Read-only, included in regular polling                       |
| `Rt`  | Read transient — readable on demand, excluded from polling   |
| `W`   | Write-only                                                   |
| `RW`  | Read/write                                                   |
| `RWs` | Read/write, persisted to storage on device                   |

### Types

| Type   | Description                        |
| ------ | ---------------------------------- |
| `uint` | Unsigned 16-bit                    |
| `int`  | Signed 16-bit                      |
| `bool` | Boolean (0/1)                      |
| `enum` | Enumeration (parsed from `unit`)   |
| `hex`  | Hex display                        |
| `ver`  | Version X.YY.ZZ (max 6.55.35)      |
| `rule` | Dynamic scale/unit based on switch |

### Rules

**32-bit pairs** - combine two registers into single value:
```csv
20,0x14,Data:KeyHigh,R,uint,-,-,-,-,high=Key
21,0x15,Data:KeyLow,R,uint,-,-,-,-,low=Key
```
Result: `{"Data": {"Key": 0x12345678}}`

**Switch-based scaling** - dynamic unit/scale based on another register (case-insensitive matching):
```csv
10,0x0A,Ctrl:Mode,RW,enum,0=off 1=rpm 2=hz,-,-,-,-
11,0x0B,Ctrl:Speed,RW,rule,off/rpm/Hz,1/10/100,0/0/0,0/10000/20000,switch=Ctrl:Mode
```
When `Mode=rpm`: Speed uses scale=10, unit="rpm"  
When `Mode=hz`: Speed uses scale=100, unit="Hz"  
When `Mode=off`: Speed returns `None`, write skips

## API

### Constructor

```python
ModbusMaster(
  port: str, # Serial port
  regmap_file: str, # CSV path
  addr: int = 1, # Modbus address
  baudrate: int = 9600,
  parity: "N"|"O"|"E" = "N",
  stopbits: 1|2 = 1,
  group: bool = True, # Default output format
  max_block: int = 64  # Max registers per read
)
```

### Methods

| Method                                  | Description                              |
| --------------------------------------- | ---------------------------------------- |
| `await sync(grouped=None)`              | Read all registers, return decoded       |
| `await read(keys, rws_filter, grouped)` | Read specific registers                  |
| `await write(data)`                     | Write registers (W, RW, RWs)             |
| `await write_sync(data)`                | Write RW/RWs + sync + verify (W skipped) |
| `get_cache(grouped=None)`               | Get decoded cache                        |
| `set_cache(data, grouped=None)`         | Set cache from data                      |
| `decode(raw_data, rws_filter, grouped)` | Decode raw to dict                       |
| `encode(data, rws_filter, grouped)`     | Encode dict to raw                       |
| `annotate(data, fields)`                | Add metadata tuples                      |
| `reg_info(reg_id)`                      | Get register metadata                    |
| `pair_info(pair_key)`                   | Get pair register metadata               |
| `regs_info()`                           | Get all registers metadata               |

### Data Formats

**Grouped** (default):
```python
{"Ctrl": {"Mode": "rpm", "Speed": 150.0}}
```

**Flat**:
```python
{"Ctrl:Mode": "rpm", "Ctrl:Speed": 150.0}
```

`write()` auto-detects format. `read()`/`sync()`/`get_cache()` use `grouped` parameter or default.

### Annotate

Add metadata to values:
```python
mb.annotate(fields=["unit"])           # (val, unit)
mb.annotate(fields=["unit", "min", "max"])  # (val, unit, min, max)
mb.annotate(data, ["unit", "scale"])   # custom data
```

### Write with Verification

```python
cache, diff = await mb.write_sync({"Ctrl": {"Mode": "rpm", "Speed": 1500}})
# Writes RW/RWs only, syncs back, returns (cache, diff)
# diff is None if all match, otherwise dict/list of mismatched keys
# W-only registers (e.g. Fault:Reset) are skipped - use write() for those
```

## Error Handling

```python
# Validation min/max (default enabled)
await mb.write({"Ctrl": {"Speed": 99999}})  
# ValueError: Ctrl:Speed: 99999 > max (10000)

# Unknown enum value
await mb.write({"Ctrl": {"Mode": "turbo"}})
# ValueError: Ctrl:Mode: unknown enum 'turbo' (valid: off, rpm, hz, ...)

# Invalid version format
mb.set_cache({"Dev": {"Version": "99.99.99"}})
# ValueError: Dev:Version: version '99.99.99' exceeds uint16 (max 6.55.35)

# No sync before write with rule registers
await mb.write({"Ctrl": {"Speed": 100}})
# RuntimeError: Switch 'Ctrl:Mode' not synced - call sync() first

# Connection error
await mb.sync()
# RuntimeError: Connect error: /dev/ttyUSB0
```

## Cache

Raw values stored in `mb.cache_raw: dict[int, int|None]`.

```python
# Direct access
mb.cache_raw[10] = 1234

# Decoded access
data = mb.cache  # get
mb.cache = data  # set (auto-detect format)

# Explicit format
data = mb.get_cache(grouped=False)
mb.set_cache(data, grouped=True)
```

## Example regmap.csv

```csv
id,hex,name,rws,type,unit,scale,min,max,desc,rule
0,0x00,Dev:Addr,RWs,uint,-,1,1,247,Modbus address,-
1,0x01,Dev:Baud,RWs,enum,0=9600 1=19200 2=38400,-,-,-,Baudrate,-
2,0x02,Dev:Version,R,ver,-,-,-,-,Firmware version,-
10,0x0A,Ctrl:Mode,RW,enum,0=off 1=rpm 2=hz,-,-,-,Control mode,-
11,0x0B,Ctrl:Speed,RW,rule,off/rpm/Hz,1/10/100,0/0/0,0/10000/20000,Setpoint,switch=Ctrl:Mode
20,0x14,Secret:KeyHigh,RWs,hex,-,-,-,-,Key high word,high=Key
21,0x15,Secret:KeyLow,RWs,hex,-,-,-,-,Key low word,low=Key
```