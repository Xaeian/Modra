# ModbusMaster

Async Modbus RTU master with CSV-based register map, automatic encoding/decoding, and caching.

The module has two layers: module-level regmap parsing (CSV cell → typed value)
and the `ModbusMaster` class (connection, block transport, codec, public API).

## Requirements

```
pymodbus
xaeian
```

## Quick Start

```python
from modbus import ModbusMaster

mb = ModbusMaster("/dev/ttyUSB0", "regmap.csv", addr=1, baudrate=9600)

# Sync first - fills the cache, and rule registers need their switch read
data = await mb.sync()

# Read specific registers
data = await mb.read(["Ctrl:Mode", "Ctrl:Speed"])

# Write
await mb.write({"Ctrl": {"Mode": "rpm", "Speed": 1500}})

await mb.disconnect()
```

## Register Map CSV

| Column    | Description                               | Example                    |
| --------- | ----------------------------------------- | -------------------------- |
| `id`      | Register address                          | `10`                       |
| `hex`     | Hex address (optional)                    | `0x0A`                     |
| `name`    | `Group:Name` format                       | `Ctrl:Mode`                |
| `rws`     | Access: R, W, RW, RWs                     | `RW`                       |
| `type`    | Data type (prefix `?` = nullable)         | `uint` / `?int`            |
| `unit`    | Unit, or enum / bits label map            | `rpm` or `0=off 1=on`      |
| `scale`   | Multiplier (or `/` separated list)        | `10` or `1/10/100`         |
| `min`     | Minimum value                             | `0`                        |
| `max`     | Maximum value                             | `10000`                    |
| `desc`    | Description                               | `Motor speed`              |
| `rule`    | Special rules                             | `switch=Ctrl:Mode`         |
| `default` | Factory value; `/`-list per device variant       | `1500` or `3700/2600/1500` |
| `null`    | Sentinel override for nullable types      | `0xFFFF` / `0` / `-1`      |

Any other column is the project's own: carried through untouched and returned
by `reg_info()`. This app adds `auth`.

### Access Modes (rws)

| Value | Description                                |
| ----- | ------------------------------------------ |
| `R`   | Read-only, included in regular polling     |
| `W`   | Write-only                                 |
| `RW`  | Read/write                                 |
| `RWs` | Read/write, persisted to storage on device |

### Types

| Type    | Description                                               |
| ------- | --------------------------------------------------------- |
| `uint`  | Unsigned 16-bit                                           |
| `int`   | Signed 16-bit                                             |
| `bool`  | Boolean (0/1)                                             |
| `enum`  | Enumeration (parsed from `unit`)                          |
| `bits`  | Bitfield: per-bit labels from `unit`, value is a raw mask |
| `hex`   | Hex display                                               |
| `ver`   | Version X.YY.ZZ (max 6.55.35)                             |
| `rule`  | Dynamic scale/unit based on switch                        |
| `float` | IEEE 754 single, used in `high`/`low` pair (32-bit)       |

`bool` accepts spelled-out text - `false` / `no` / `off` / `0` are 0, anything
else 1. Without that every non-empty string would be truthy.

### Nullable registers

A `?` prefix on `type` reserves one raw value as "no data". Default
sentinels follow the SunSpec industry convention; override per-register
via the `null` column when the device uses a different value.

| Type prefix      | Default sentinel  | Decoded |
| ---------------- | ----------------- | ------- |
| `?uint` / `?hex` | `0xFFFF`          | `None`  |
| `?int`           | `0x8000` (-32768) | `None`  |
| `?bool`          | `0xFFFF` (raw)    | `None`  |
| `?uint` (pair)   | `0xFFFFFFFF`      | `None`  |
| `?int`  (pair)   | `0x80000000`      | `None`  |
| `float` (pair)   | `NaN` (IEEE-754)  | `None`  |

`?bool` works because a boolean Modbus register still occupies a full
16-bit word - `0`/`1` are HIGH/LOW, anything else is free for N/A.

`float` pairs are nullable by default - NaN is the natural sentinel and
`?` is redundant. `enum` / `ver` / `rule` / `bits` accept `?` for
metadata purposes but have no clean spare encoding (`ver` packs all 16
bits, `enum` raw outside the table reads as an integer fallback, `rule`
already returns `None` for an inactive slot, and `bits` treats `0xFFFF`
as a valid all-set mask - use an explicit `null` override if a device
reserves a sentinel).

```csv
33,0x21,MeasSlow:Freq,R,?uint,Hz,100,,,Frequency (N/A when output disabled),,
42,0x2A,MeasSlow:Temp,R,?int,°C,100,,,Power-stage temperature (N/A on sensor fault),,
60,0x3C,Energy:Total,R,?uint,Wh,1,,,Accumulated energy (N/A = not accumulated),,0
```

Writing `None` emits the sentinel where the type has one; on a
non-nullable register - or a nullable type with no spare encoding
(`?enum` / `?ver` / `?rule` / `?bits`) - the write is silently skipped
(no garbage write). The DB stores SQLite NULL for any nullable read that
decoded as None, so the history column reads as a gap rather than a
sentinel-valued spike.

### Defaults

`default` is the factory value, reported by `reg_info()` parsed to the
register's own type. A `/`-list holds one value per device variant, so one map
can describe a family that shares a register layout but not its tuning.

```csv
120,0x78,Speed:Max,RWs,uint,rpm,1,0,3000,Maximum speed,,1650/1300/760
```

### Rules

**32-bit pairs** - combine two adjacent registers into one value. The pair's
type is taken from the high half: `uint` produces a plain uint32 (displayed
as hex), `float` reinterprets the 32-bit word as an IEEE 754 single.

```csv
20,0x14,Data:KeyHigh,R,uint,-,-,-,-,Secret key high word,high=Key
21,0x15,Data:KeyLow,R,uint,-,-,-,-,Secret key low word,low=Key
```
Result: `{"Data": {"Key": 0x12345678}}`

```csv
30,0x1E,Calib:GainHigh,RWs,float,V,1,-100,100,Calibration gain high word,high=Gain
31,0x1F,Calib:GainLow,RWs,float,V,1,-100,100,Calibration gain low word,low=Gain
```
Result: `{"Calib": {"Gain": 1.234}}` (decoded via IEEE 754, big-endian).
For float pairs, `unit`/`scale`/`min`/`max` are taken from the high half so
the pair carries real engineering metadata.

**Switch-based scaling** - dynamic unit/scale based on another register
(case-insensitive matching):

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
  port: str,                     # serial port, e.g. "COM3" / "/dev/ttyUSB0"
  regmap_file: str,              # register map CSV path
  addr: int = 1,                 # Modbus device address
  baudrate: int = 9600,
  parity: "N"|"O"|"E" = "N",
  stopbits: 1|2 = 1,
  timeout: float = 1,            # response timeout (s)
  retries: int = 3,              # per-block retry budget
  group: bool = True,            # default output format (grouped/flat)
  max_block: int = 64,           # max registers per read/write block
  ignore_set: set[str] = None,   # names excluded from read() polling (pair-aware)
  client_factory = None,         # (mb) -> client; swaps transport (sim, tests)
)
```

### Methods

High-level (decoded values):

| Method                                  | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `await sync(grouped=None)`              | Read all registers, return decoded cache    |
| `await read(keys, rws_filter, grouped)` | Read selected registers _(default: `R` polling minus `ignore_set`)_ |
| `await write(data)`                     | Encode and write _(W, RW, RWs)_             |
| `get_cache(grouped=None)` / `cache`     | Decoded cache _(unpolled → `None`)_         |
| `annotate(data, fields)`                | Wrap values with metadata tuples            |

Codec and metadata (no I/O):

| Method                                  | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `decode(raw_data, rws_filter, grouped)` | Raw words → engineering values              |
| `encode(data, rws_filter, grouped)`     | Engineering values → raw words              |
| `reg_info(reg_id)`                      | Single register metadata                    |
| `pair_info(pair_key)`                   | 32-bit pair metadata                        |
| `regs_info()`                           | Full catalog _(pairs emitted once)_         |

Connection and transport (raw words):

| Method                            | Description                                       |
| --------------------------------- | ------------------------------------------------- |
| `await connect() / disconnect()`  | Open / close the client                           |
| `await reconnect()`               | Close + reopen, resets framer after stalled frame |
| `await read_registers(reg_ids)`   | Block-grouped raw read, updates cache             |
| `await write_registers(raw_data)` | Block-grouped raw write, returns word count       |
| `resolved_ignored_ids()`          | `ignore_set` resolved to register ids             |

### Runtime exclusions

`ignore_set` provides *user-level* register filtering outside the descriptor.
Names in the set are excluded from the `read()` polling cycle but stay in the
map, so the DB schema and `regs_info()` catalog cover every register. Still
readable explicitly via `read(keys=[...])` and `sync()` (full read for admin
tools). Pair keys (e.g. `Auth:SecretKey`) expand to both underlying halves.

### Data Formats

**Grouped** _(default)_:
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
mb.annotate(fields=["unit"])                # (val, unit)
mb.annotate(fields=["unit", "min", "max"])  # (val, unit, min, max)
mb.annotate(data, ["unit", "scale"])        # custom data
```

## Error Handling

`min` / `max` are advisory - out-of-range numeric writes go through.
The frontend marks them red and the Send button warns, but the device
sees whatever the operator typed. Symbolic values (enum labels, version
strings) still raise because they can't be encoded to a meaningful word.

```python
# Out-of-range numeric - encoded and written as-is
await mb.write({"Ctrl": {"Speed": 99999}})  # OK; firmware decides what to do

# Unknown enum value
await mb.write({"Ctrl": {"Mode": "turbo"}})
# ValueError: Ctrl:Mode: unknown enum 'turbo' (valid: off, rpm, hz, ...)

# Invalid version format
await mb.write({"Dev": {"Version": "99.99.99"}})
# ValueError: Dev:Version: version '99.99.99' over uint16 max 6.55.35

# No sync before write with rule registers
await mb.write({"Ctrl": {"Speed": 100}})
# RuntimeError: Switch 'Ctrl:Mode' not yet read

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

# Explicit format
data = mb.get_cache(grouped=False)
```

## Example regmap.csv

Trailing `default` / `null` columns are optional.

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
