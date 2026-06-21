# 🥬🟣 Modra

**Modbus RTU client that generates its entire UI from a single CSV file.**

Modbus carries no metadata about registers. Type, unit, range and factory values live separately in firmware, client code, UI and docs. Modra closes that loop: one `regs.csv` describes every register, the entire client surface generates from it.

There is no per-device configuration UI. The grid, controls, validation rules and history schema all live in `regs.csv`. Change the file, restart, get a different device tool.

**Modes:**

- **Desktop** - `Modra.exe` via PyWebview
- **HTTP** - `py serve.py` → `localhost:8000`, any browser
- **Simulator** - `simulator = true` in `serial.ini`, no hardware

## Quick start

```bash
py -3.12 -m venv .venv
./.venv/Scripts/activate
py -m pip install -i pip
py -m pip install -r requirements.txt
py api.py # desktop window
py serve.py # HTTP server
```

Or grab `Modra.exe` from [Releases](https://github.com/Xaeian/Modra/releases), drop next to `regs.csv`, run.

First launch creates `serial.ini`, `view.json`, `data.db` next to the binary.

## The grid

![REG](register-grid.png)

**Controls by type:**

- **`uint`** / **`int`** / **`float`** / **`rule`** - numeric input, accepts `0x..` / `0b..`
- **`bool`** - HIGH / LOW buttons
- **`enum`** - one button per label, exclusive
- **`hex`** - input formatted as `0xNNNN`
- **`ver`** - read-only `X.YY.ZZ`

**Access badges:**

- **🟡R** - read-only
- **🔴W** - write-only
- **🔵RW** - volatile read/write
- **🟢RWs** - persisted read/write

**Visual states:**

- **yellow** - pending edit _(not sent)_
- **red outline** - out of range
- **blank** - rule register with no active slot
- **strikethrough** - ignored

**Row icons:**

- **📊** add to chart
- **🚫** ignore _(stop polling, hide row)_
- **⚙** open slider tweaker _(editable numerics only)_

## Toolbar

![OPT](options-menu.png)

- **⚡** connect / disconnect
- **⬇ Read** force full sync _(when no dirty edits)_
- **⬆ Send(n)** flush pending edits to device
- **✕ Reset** discard pending edits
- **📈** toggle chart panel
- **🚫** toggle show-disabled mode
- **☰** toggle settings panel

Connect flow: pick port → type address _(1-247)_ → **⚡**. Polling reads **R**/**RW**/**RWs** at the configured interval. Validation runs on both sides: frontend marks out-of-range, backend rejects writes outside `min/max`.

## Charts

![PLT](plots-menu.png)

Click **📊** on any row. Registers sharing unit + scale share a panel; bool and enum get their own panels.

- **range buttons** - `2m` / `10m` / `1h` / `6h` / `24h` / `7d` / `30d` / `1y` / `∞` _(all history)_
- **`S`** / **`M`** / **`L`** - cycle panel size
- **tag click** - remove trace
- **💾** - export all series to CSV
- **drag on plot** - zoom in; the window refetches at a finer resolution, so detail appears as you go deeper
- **double-click** - back to the live edge

Each chart request is a time window, served from a resolution tier: raw for recent/narrow windows, minute/hour/day archives _(downsampled off raw)_ for wider ones. A year-wide overview is a few hundred points, not millions, and zooming refetches the new window at a finer tier.

## Hiding registers

- **🚫 on row** - ignore _(stop polling, hide row)_
- **🚫 in toolbar** - switch to show-disabled mode _(only ignored visible)_
- **🚫 on row in show-disabled mode** - un-ignore

History column is preserved; new rows after the ignore land as `NULL`. Membership stored in `view.json`.

## Settings ☰

- **Baud** / **Parity** / **Stop** / **Timeout** - wire-level, changing forces reconnect
- **Interval** - polling interval _(ms)_, drives both device polling and UI refresh rate
- **Retries** - per-block retry budget on read errors
- **History** - retention window _(days)_; older poll rows are pruned and the chart's max range follows it
- **Address scan** - enter `1-10, 12, 100-110` → **🔍 Scan**, click result to connect
- **📂 Import** - load `.ini` / `.csv` into pending edits _(no auto-send; reads locale CSV with `;` + decimal comma)_
- **💾 CSV** / 💾 **INI** - export current RWs values to file
- **🧹 Clear DB** - wipe stored poll history _(data.db)_

## Keyboard shortcuts

Fire when nothing is focused _(Gmail / GitHub pattern)_, neighbours on QWERTY:

- **`i`** - **i**gnore mode _(toggle show-disabled)_
- **`o`** - **o**ptions _(toggle settings panel)_
- **`p`** - **p**lots _(toggle chart panel)_

## Files

| File | Role | Edited by |
|---|---|---|
| [`regs.csv`](regs.csv) | register map, source of truth _(format: [`modbus.md`](modbus.md))_ | you |
| `serial.ini` | connection state + simulator flag | app + you |
| `view.json` | UI state _(monitor panels, ignored list)_ | app + you |
| `data.db` | SQLite poll history, one table per addr | app |
| `write.log` | audit log of every write | app |

**Schema change:** if you edit `regs.csv`, delete `data.db` and it rebuilds fresh on next boot.

## Simulator

In `serial.ini`:

```ini
simulator = true
```

Each register is simulated from its own descriptor row alone _(type, rws, min/max)_, no cross-register logic:

- **numeric R**: mean-reverting random walk, edge-biased to stay in range
- **bool R**: rare random toggle
- **enum R**: rare advance to neighbour state
- **hex / ver**: stable _(firmware-controlled)_
- **RWs / W**: static, only user writes change them

## Build

```bash
py -3.12 -m venv .venv
./.venv/Scripts/activate
py -m pip install -r requirements.txt
./build.bat
```

`Modra.exe` lands in `.dist/`. Place next to `regs.csv` and run.
