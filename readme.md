# 🟣 Modra

**Modbus RTU** register viewer/editor. Dual-mode: **PyWebview** desktop app or **HTTP** + browser.

Reads [`reg.csv`](reg.csv): register map defining all device registers _(`id`, `name`, `type`, `scale`, `min`/`max`, `rws`)_. Format described in [`modbus.md`](modbus.md).

## Run

```bash
py serve.py    # HTTP server (dev / remote access)
python api.py  # integrated desktop app
```

## Stack

Frontend built with [TonkaJSX](https://tonkajsx.com): lightweight JSX-to-DOM runtime, no build step, no bundler, no virtual DOM. Scripts load as plain `<script>` tags and render real DOM elements directly.

Charts use [uPlot](https://github.com/leeoniya/uPlot) via `ChartStack`: synchronized multi-panel wrapper with shared tooltip, zoom, and auto-scroll.

Backend: Python HTTP server _(`serve.py`)_ wrapping async Modbus RTU communication _(`link.py`)_ with SQLite storage _(`store.py`)_. Uses [`xaeian`](https://github.com/Xaeian/Python) utilities throughout.

## Monitor

Click 📊 on any register to add it to live charts. All register types supported:

- **Numeric** (R/RW/RWs/Rt/W): continuous line, auto-scaled Y axis
- **Enum**: stepped line, Y axis shows labels
- **Bool**: stepped line, ON/OFF
- **Hex**: stepped line, numeric value

Per-panel sizing (S/M/L), time ranges from 2m to ∞, CSV export. Monitor configuration persisted in `monitor.json` — survives restarts.

## Data

Single `data.db` SQLite database. One table per device address _(`addr_1`, `addr_5`, ...)_. Every poll cycle logs **all** registers from cache. History queryable even when disconnected.

Write operations audited to `write.log`.

## CLI Tools

```bash
py mb_ctrl.py import          # device → config.ini (RWs only)
py mb_ctrl.py export          # config.ini → device
py mb_ctrl.py import cfg.csv  # device → CSV
py mb_ctrl.py sudo            # unlock admin
py mb_set.py 1500rpm          # quick setpoint
py mb_set.py off              # motor off
```

## Philosophy

One CSV defines everything. UI is generated from register metadata: types, ranges, enums, units, groups. No per-device frontend code. Change the CSV, get a different device tool.

## Build

```sh
py -m venv .venv
./.venv/Scripts/activate
py -m pip install -U pip
py -m pip install -r requirements.txt
./build.bat
```

Produces single `Modra.exe` in `.dist/`. Place alongside `reg.csv` and run. Files `serial.ini`, `monitor.json`, `data.db` are created automatically on first use.

Pre-built exe available on the [Releases](https://github.com/EctraGroup/Modra/releases) page.