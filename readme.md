# WebModbus

Modbus RTU register viewer/editor. Dual-mode: PyWebview desktop app or HTTP + browser.

Reads [`reg.csv`](reg.csv): register map defining all device registers _(`id`, `name`, `type`, `scale`, `min`/`max`, `rws`)_. Format described in [`modbus.md`](modbus.md).

## Run

```bash
py serve.py    # run HTTP server for developing or remote
python api.py  # run as integrated desktop .exe app
```

## Stack

Frontend built with [TonkaJSX](https://github.com/nicecnt/tonka-jsx): lightweight JSX-to-DOM runtime, no build step, no bundler, no virtual DOM. Scripts load as plain `<script>` tags and render real DOM elements directly.

## Philosophy

One CSV defines everything. UI is generated from register metadata: types, ranges, enums, units, groups. No per-device frontend code. Change the CSV, get a different device tool.