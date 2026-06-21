# Changes `modra`

## `1.2.0` NULL

- Nullable registers _(`?` type)_: "no data" reads show as a gap, not an out-of-scale spike
- Database stops growing without bound: keeps the last N days _(`history` setting)_, prunes the rest
- Long chart ranges stay smooth: history is downsampled, `∞` replaced by the retention window
- 🧹 Clear DB button in settings _(wipes stored history)_
- Config import reads locale CSV _(`;` separator, decimal comma; e.g. a PL Windows regional setting)_
- First click registers while editing a field; Enter confirms a value
- Simulator: each register animated only from its own descriptor row _(type, rws, min/max)_, no cross-register logic; settings hold, telemetry is live from the start, and the random N/A blips are gone
- Fixed chart crash when a `rule` register's active unit changed its panel grouping _(e.g. after a mode/setpoint write or Clear DB)_

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
- Per-panel chart sizing _(`S`/`M`/`L`)_, time ranges _(`2m`, `7d`, `∞`)_, CSV export
- Monitor configuration persisted across sessions _(`view.json`)_
- Inline editing with dirty tracking, slider/stepper controls, out-of-range warnings
- Address scanning, serial parameter tuning, auto port detection
- Write audit logging
- SQLite storage: every poll cycle logged, full history queryable
- Config import and export to INI or CSV
- CLI tools: `mb_ctrl.py` _(import/export/sudo)_, `mb_set.py` _(quick setpoint)_

**Stack**

- Backend: Python, pymodbus, aiosqlite, pywebview
- Frontend: [TonkaJSX](https://tonkajsx.com), [uPlot](https://github.com/leeoniya/uplot)
- Built into a single `.exe` via PyInstaller