# Changes `modra`

## `1.1.0` Paper

- Register ignore via 🚫, persisted to `view.json`; `i` reveals them in show-disabled mode
- 32-bit float pair _(IEEE 754)_ via `type=float` on `rule=high=Name` / `rule=low=Name`
- Schema drift detection on boot: legacy `data.db` rotated to `data-YYYYMMDD-HHMMSS.db`, fresh DB created
- Keyboard shortcuts _(neighbours on QWERTY)_: `i` ignore mode, `o` options, `p` plots
- Fuzzy search across register name + description, diacritic-insensitive
- Simulator mode via `simulator = true` in `serial.ini`: mean-reverting random walk, no hardware

## `1.0.1` Fixes

- Fixed **config export** returning empty values by reading from device registers instead of serial config
- Fixed buttons ignoring **clicks** during polling by deferring render while pointer is active

## `1.0.0` Init

Modbus RTU register viewer/editor. Desktop app _(PyWebview)_ or browser _(HTTP server)_.

**Features**

- Register map driven by single `regs.csv`: change CSV, get a different device tool
- All register types: numeric, enum, bool, hex, version, rule-based
- Live monitoring with synchronized multi-panel charts _(uPlot)_
- Per-panel chart sizing _(S/M/L)_, time ranges _(2m → 7d → ∞)_, CSV export
- Monitor configuration persisted across sessions _(`monitor.json`)_
- Inline editing with dirty tracking, slider/stepper controls, out-of-range warnings
- Address scanning, serial parameter tuning, auto port detection
- Write audit logging
- SQLite storage: every poll cycle logged, full history queryable
- Config import/export _(INI/CSV)_
- CLI tools: `mb_ctrl.py` _(import/export/sudo)_, `mb_set.py` _(quick setpoint)_

**Stack**

- Backend: Python, pymodbus, aiosqlite, pywebview
- Frontend: [TonkaJSX](https://tonkajsx.com), uPlot
- Builtto single `.exe` via PyInstaller