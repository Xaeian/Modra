# WebModbus

Modbus RTU register viewer/editor. Dual-mode: PyWebview desktop app or HTTP + browser.

Reads [`reg.csv`](reg.csv): register map defining all device registers _(`id`, `name`, `type`, `scale`, `min`/`max`, `rws`)_. Format described in [`modbus.md`](modbus.md).

## Run

```bash
py serve.py    # run HTTP server for developing or remote
python api.py  # run as integrated desktop .exe app
```

## Stack

Frontend built with [TonkaJSX](https://github.com/Xaeian/TonkaJSX): lightweight JSX-to-DOM runtime, no build step, no bundler, no virtual DOM. Scripts load as plain `<script>` tags and render real DOM elements directly.

Charts use [uPlot](https://github.com/leeoniya/uPlot) via `ChartStack` — synchronized multi-panel wrapper with shared tooltip, zoom, and auto-scroll.

Backend: Python HTTP server (`serve.py`) wrapping async Modbus RTU communication (`link.py`) with SQLite storage (`store.py`). Uses [`xaeian`](https://github.com/Xaeian/Python) utilities throughout.

## Monitor

Right-click any register → **Monitor** to add it to live charts. All register types supported:

- **Numeric** (R/RW/RWs/Rt/W) — continuous line, auto-scaled Y axis
- **Enum** — stepped line, Y axis shows labels, string values mapped to indices
- **Bool** — stepped line, Y axis ON/OFF, fixed range
- **Hex** — stepped line, numeric value

Toolbar toggles: 📈 chart panel, 📋 register panel. CSV export with full timestamps.

## Data

Single `data/data.db` SQLite database. One table per device address (`addr_1`, `addr_5`, ...). Every poll cycle logs **all** registers (R + RW + RWs + Rt + W) from `mb.cache`.

Write operations are audited to `data/audit.log` (rotating, per-register entries).

## Philosophy

One CSV defines everything. UI is generated from register metadata: types, ranges, enums, units, groups. No per-device frontend code. Change the CSV, get a different device tool.