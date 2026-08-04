# Changes `modra`

## `1.3.0` Widgets

- Device widgets 🧩: per-device panels enabled in `app.ini`
- Register map picked at startup: swap or update it without touching files
- 
## `1.2.4` Bits

- `bits` register type: a toggle per labeled bit, own chart panel
- History browsing works offline, straight from the DB
- Mini fixes: field focus, grid grouping, chart tooltip

## `1.2.3` Lint, Input guards

- `regs.csv` lint on boot
- Overflow values flagged, not silently wrapped; decimal comma accepted
- Toast alerts on more actions, with type icons

## `1.2.2` Trickle, Autosend

- Auto-send writes on commit; per-row 🎯 stages a value for Send _(even if unchanged)_
- Trickle refresh: RW/RWs re-read in the background between syncs
- Forced Read also pulls write-only `W` _(config `READBACK_W`)_
- Chart tops up at the live edge on the raw tier
- Simulator is now the **SIM** port _(no flag)_, history in `addr_sim*`
- Register grid balances into width-fit columns, groups kept in order
- Desktop page zoom _(`Ctrl` +/- / scroll)_
- Fix: text-boxes repaint right after Read

## `1.2.1` Zoom

- Resolution tiers: minute/hour/day archives off raw, so a year is a 365-row read
- Ranges to `1y` / `∞`; `1h` and under stay raw, wider spans step down the tiers
- Active range button tinted by its serving tier _(fine to coarse)_
- Drag-zoom drills into a finer tier; double-click returns to live

## `1.2.0` NULL

- Nullable registers `?`: `null` reads draw as gaps, not out-of-scale spikes
- Bounded history `history=N`: keep last N days, older rows pruned
- Long ranges downsampled; `∞` swapped for the retention window
- 🧹 Clear DB button
- Config import accepts `;`-separated CSV with decimal commas
- First click registers mid-edit; `Enter` confirms
- Simulator follows each register's CSV row _(type, rws, min/max)_: no stray N/A
- Chart no longer crashes when rule-unit panels regroup

## `1.1.0` Paper

- Register ignore via 🚫, saved to `view.json`; `i` reveals them in show-disabled mode
- 32-bit float pair `type=float` on `rule=high=Name` / `rule=low=Name` _(IEEE 754)_
- Schema-drift check on boot: legacy `data.db` rotated to `data-YYYYMMDD-HHMMSS.db`, fresh DB created
- Keyboard shortcuts: `i` ignore, `o` options, `p` plots _(QWERTY neighbours)_
- Fuzzy search over register name + description, diacritic-insensitive
- Simulator mode `simulator=true` in `serial.ini`: mean-reverting random walk, no hardware

## `1.0.1` Fixes

- Config export no longer empty: reads device registers, not serial config
- Buttons respond during polling: render deferred while pointer is active

## `1.0.0` Init

Modbus RTU register viewer/editor. Desktop app _(PyWebview)_ or browser _(HTTP server)_.

**Features**

- Register map from a single `regs.csv`: edit CSV → different device tool
- All register types: numeric, enum, bool, hex, version, rule-based
- Live monitoring, synchronized multi-panel charts _(uPlot)_
- Per-panel sizing _(`S`/`M`/`L`)_, time ranges _(`2m`, `7d`, `∞`)_, CSV export
- Monitor layout persisted across sessions _(`view.json`)_
- Inline editing: dirty tracking, slider/stepper controls, out-of-range warnings
- Address scan, serial-parameter tuning, auto port detection
- Write audit log
- SQLite storage: every poll cycle logged, full history queryable
- Config import/export to INI or CSV
- CLI tools: `mb_ctrl.py` _(import/export/sudo)_, `mb_set.py` _(quick setpoint)_

**Stack**

- Backend: Python, pymodbus, aiosqlite, pywebview
- Frontend: [TonkaJSX](https://tonkajsx.com), [uPlot](https://github.com/leeoniya/uplot)
- Single `.exe` via PyInstaller