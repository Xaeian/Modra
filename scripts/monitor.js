// scripts/monitor.js

// Chart config, time-series buffer, CSV export. `MonitData` holds the ring
// buffer; `chart*` helpers are consumed by Monitor.jsx and chart.js.

//---------------------------------------------------------- Chart constants

// Fixed live windows. The top of the list is appended dynamically from the
// retention setting (see `chartRanges()`) - there is no ∞, because the DB
// only keeps `history` days and an unbounded fetch would pull millions of
// rows into the browser.
const CHART_RANGE_PRESETS = [
  { label: "2m",  s: 120 },
  { label: "10m", s: 600 },
  { label: "1h",  s: 3600 },
  { label: "6h",  s: 21600 },
  { label: "24h", s: 86400 },
  { label: "7d",  s: 604800 },
];

// Downsampling. A long range fetched raw is millions of points; instead the
// backend buckets it to ~`CHART_TARGET_POINTS` (see `store.since` `bucket`).
// Ranges at or below `CHART_RAW_MAX_SEC` come back raw (full resolution).
const CHART_TARGET_POINTS = 2000;
const CHART_RAW_MAX_SEC = 3600;
// Hard ceiling on in-memory points per trace. A long window watched live
// would otherwise accumulate raw-rate samples forever; on overflow the
// buffer is halved by decimation. Headroom above the backend target.
const CHART_BUF_CAP = 8000;

// Bucket width (seconds) for the active range, or 0 for raw. Drives both the
// backend query and the gap threshold so the two stay consistent.
function chartBucket(range) {
  if(range <= CHART_RAW_MAX_SEC) return 0;
  return range / CHART_TARGET_POINTS;
}

// Range buttons: presets shorter than the retention window, capped by a
// final button equal to the window itself (the honest "show everything we
// keep"). `history` comes from the backend (serial.ini), default 14 days.
function chartRanges() {
  const days = Math.max(1, parseInt(S.serial?.history) || 14);
  const maxS = days * 86400;
  const presets = CHART_RANGE_PRESETS.filter(r => r.s < maxS);
  return [...presets, { label: days + "d", s: maxS }];
}

// One palette per panel index. Series within a panel rotate through the
// same palette so multi-trace panels stay visually distinct. 10 hues each;
// panels with >10 series wrap.
const CHART_COLORS = [
  // Ocean: blue, teal, indigo + orange, emerald, pink
  ["#1D4ED8", "#0EA5E9", "#0D9488", "#0369A1", "#6366F1",
   "#10B981", "#DB2777", "#7C3AED", "#64748B", "#F97316"],
  // Fire: red, orange, magenta, amber, wine + blue, emerald, purple
  ["#DC2626", "#B45309", "#DB2777", "#EA580C", "#9F1239",
   "#3B82F6", "#D97706", "#10B981", "#7C3AED", "#64748B"],
  // Forest: green, teal, lime, emerald, olive + orange, blue, red, purple
  ["#15803D", "#0D9488", "#65A30D", "#059669", "#4D7C0F",
   "#EA580C", "#3B82F6", "#DC2626", "#7C3AED", "#78716C"],
  // Sun: amber, red, orange, rust, brown + blue, emerald, purple, teal
  ["#D97706", "#DC2626", "#EA580C", "#B45309", "#92400E",
   "#2563EB", "#10B981", "#7C3AED", "#0891B2", "#78716C"],
  // Violet: purple, indigo, pink, deep-violet, wine + teal, orange, emerald
  ["#7C3AED", "#6366F1", "#DB2777", "#4338CA", "#9F1239",
   "#0891B2", "#F97316", "#10B981", "#1D4ED8", "#64748B"],
  // Aqua: cyan, teal, sky, emerald, ocean + rose, amber, purple, green
  ["#0891B2", "#0D9488", "#0EA5E9", "#059669", "#0369A1",
   "#F43F5E", "#D97706", "#7C3AED", "#16A34A", "#64748B"],
  // Tangerine: orange, amber, red, rust, pink + blue, emerald, purple, teal
  ["#EA580C", "#D97706", "#DC2626", "#B45309", "#DB2777",
   "#3B82F6", "#10B981", "#7C3AED", "#0891B2", "#78716C"],
  // Rose: pink, crimson, wine, red, purple + teal, emerald, orange, blue
  ["#DB2777", "#E11D48", "#9F1239", "#F43F5E", "#7C3AED",
   "#0891B2", "#10B981", "#F97316", "#1D4ED8", "#64748B"],
  // Earth: sienna, rust, olive, umber, teal + blue, red, purple, cyan
  ["#92400E", "#B45309", "#65A30D", "#A16207", "#0D9488",
   "#3B82F6", "#DC2626", "#7C3AED", "#0891B2", "#78716C"],
];

const CHART_SIZES = { S: 100, M: 250, L: 450 };
const CHART_SIZE_CYCLE = ["S", "M", "L"];
const CHART_SIZE_DEFAULT = "M";

// Gap-rendering threshold. A poll gap longer than `GAP_TICKS * interval`
// is drawn as a break, not interpolated. 15 ticks at 200ms ≈ 3s - longer
// than routine read jitter, shorter than a real disconnect.
const GAP_TICKS = 15;
const GAP_MIN_SEC = 5;

//---------------------------------------------------------- Time formatting

const _pad2 = (n) => String(n).padStart(2, "0");

// "13:45:09" - axis tick.
function chartFmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.getHours() + ":" + _pad2(d.getMinutes()) + ":" + _pad2(d.getSeconds());
}

// "26-05-12" - 2-digit year keeps axis labels narrow at the cost of post-2099 wrap.
function chartFmtDate(ts) {
  const d = new Date(ts * 1000);
  return String(d.getFullYear()).slice(2) + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate());
}

const chartFmtFull = (ts) => chartFmtDate(ts) + " " + chartFmtTime(ts);

// uPlot axis values formatter: "date\ntime" on two lines per tick.
const chartFmtAxisX = () => (u, vals) => vals.map(v => chartFmtDate(v) + "\n" + chartFmtTime(v));

// Full ISO-ish stamp for CSV exports (4-digit year, sortable).
function chartFmtCSV(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate())
    + " " + _pad2(d.getHours()) + ":" + _pad2(d.getMinutes()) + ":" + _pad2(d.getSeconds());
}

//---------------------------------------------------------- Color / grouping

// Color for series `si` inside panel `gi`. Both indices wrap.
const chartColor = (gi, si) => CHART_COLORS[gi % CHART_COLORS.length][si % CHART_COLORS[0].length];

// Stepped lines for series that don't interpolate cleanly: non-read-only
// (write-side jumps between samples) and bool/enum/hex (discrete).
function chartIsStepped(reg) {
  return reg.rws !== "R" || reg.type === "bool" || reg.type === "enum" || reg.type === "hex";
}

// Group key = unit + scale fingerprint. Two registers share a panel iff
// their engineering unit and scale match. bool/enum get their own panel each
// (different y-axis semantics). Rule registers use the *confirmed* (device-
// acknowledged) slot so the chart only regroups after the device reports the
// new mode - clicking Hz on Ctrl:mode doesn't relabel until the write is ack'd.
function chartGroupKey(reg) {
  if(reg.type === "bool") return "bool|" + reg.name;
  if(reg.type === "enum") return "enum|" + reg.name;
  return Reg.unit(reg, true) + "|" + Reg.scale(reg, true);
}

// name → hex, so the tag bar in Monitor.jsx mirrors the panel series colors.
function chartTagColors() {
  const map = {};
  for(const grp of Object.values(MonitData.groups())) {
    grp.names.forEach((name, i) => { map[name] = chartColor(grp.idx, i); });
  }
  return map;
}

// Backend returns enums as labels and bools as JS booleans; uPlot needs
// numeric coordinates.
function chartToNum(reg, value) {
  if(value == null) return null;
  if(typeof value === "number") return value;
  if(reg.type === "enum" && reg.enum) {
    const labelToKey = {};
    for(const [k, v] of Object.entries(reg.enum)) labelToKey[v] = parseInt(k);
    return labelToKey[value] ?? null;
  }
  if(reg.type === "bool") return value ? 1 : 0;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

//---------------------------------------------------------- CSV export

// Export `names` from `buf` as a single CSV. Aligns on the union of
// timestamps - missing samples are blank cells. Decimals per column come from
// `Reg.decimals` so values match what the Grid shows.
function chartExportCSV(names, buf) {
  const allTs = new Set();
  for(const n of names) {
    for(const p of (buf[n] || [])) allTs.add(p.ts);
  }
  const sorted = [...allTs].sort((a, b) => a - b);
  if(!sorted.length) return;
  const maps = {}, decs = {};
  for(const n of names) {
    const m = new Map();
    for(const p of (buf[n] || [])) m.set(p.ts, p.v);
    maps[n] = m;
    const reg = S.regs.find(r => r.name === n);
    decs[n] = reg ? Reg.decimals(reg) : 0;
  }
  const rows = sorted.map(ts => {
    const row = { time: chartFmtCSV(ts) };
    for(const n of names) {
      const v = maps[n].get(ts);
      row[n] = v != null ? v.toFixed(decs[n]) : "";
    }
    return row;
  });
  CSV.save(`monitor@${fileStamp()}.csv`, rows, ["time", ...names]);
}

//---------------------------------------------------------- MonitData (time-series buffer)

// Time-series buffer for monitored registers.
//   `_buf[name]`    → [{ts, v}, ...] chronological
//   `_lastTs[name]` → newest ts seen; used as `since` filter when polling
//   `range`         → window length in seconds (always finite)
// Keys are full register names (`Group:Field`). `_buf` is accessed by
// Monitor.jsx for CSV export to avoid a redundant copy.
const MonitData = {

  range: 600,
  _buf: {},
  _lastTs: {},
  // Last active slot column ingested per monitored name. Used by `sync()`
  // to detect rule slot flips (e.g. Ctrl:mode rpm→Hz) and reset the buffer
  // so the next poll backfills the new slot from `backfill` onward.
  _activeSlot: {},

  //---------------------------------------------------------- X range

  // Right edge pinned to "now".
  xRange() {
    const now = Date.now() / 1000;
    return [now - this.range, now];
  },

  //---------------------------------------------------------- Poll params

  // Poll interval (ms) → sample-gap threshold (seconds). On a decimated long
  // range samples are legitimately ~`bucket` apart, so the gap scales with the
  // `bucket`; otherwise a downsampled line would be drawn as all breaks.
  gapThreshold() {
    const ms = parseInt(S.serial?.interval) || 500;
    const base = Math.max(ms * GAP_TICKS / 1000, GAP_MIN_SEC);
    const bucket = chartBucket(this.range);
    return bucket > 0 ? Math.max(base, bucket * 3) : base;
  },

  // `since = min(lastTs)` so a single fetch covers even the slowest series.
  // `bucket` downsamples long ranges server-side. Returns null when nothing
  // is monitored - poll falls back to plain cache.
  readParams() {
    if(!S.monitor.size) return null;
    const vals = Object.values(this._lastTs);
    return {
      since: vals.length ? Math.max(0, Math.min(...vals)) : 0,
      names: [...S.monitor],
      limit: 5000,
      bucket: chartBucket(this.range),
    };
  },

  //---------------------------------------------------------- Ingest / trim

  // DB column for the reg's active slot, or null when no slot resolves
  // (rule reg with switch=off, unpolled, etc). Callers gate on this.
  _activeColumn(reg) {
    if(!reg) return null;
    const base = reg.name.replace(":", "_");
    if(reg.type !== "rule") return base;
    const idx = Reg.ruleIndex(reg, true);
    return idx !== null ? `${base}_${idx}` : null;
  },

  // Backend may return overlapping ranges, so rows older than the per-name
  // `lastTs` are skipped. Trim afterwards drops samples past the window.
  ingest(rows) {
    if(!rows?.length) return;
    for(const row of rows) {
      for(const name of S.monitor) {
        if(row.ts <= (this._lastTs[name] || 0)) continue;
        const reg = S.regs.find(r => r.name === name);
        const col = this._activeColumn(reg);
        // Switch unpolled / no matching slot - skip without advancing lastTs
        // so a later poll backfills once the slot is resolvable.
        if(!col) continue;
        // Trace added mid-poll, this column wasn't projected - same logic.
        if(!(col in row)) continue;
        const raw = row[col];
        // NULL = sample taken while a different slot was active. Advance
        // lastTs so we don't refetch this row, but don't push - the chart
        // shows a natural gap until the active slot has data again.
        if(raw == null) {
          this._lastTs[name] = row.ts;
          continue;
        }
        if(!this._buf[name]) this._buf[name] = [];
        let v = raw;
        if(typeof v !== "number" && reg) v = chartToNum(reg, v);
        this._buf[name].push({ ts: row.ts, v });
        this._lastTs[name] = row.ts;
      }
    }
    this.trim();
    this.cap();
  },

  // Drop samples older than the current window.
  trim() {
    const cutoff = Date.now() / 1000 - this.range;
    for(const buf of Object.values(this._buf)) {
      while(buf.length > 1 && buf[0].ts < cutoff) buf.shift();
    }
  },

  // Hard memory backstop. A long window watched live keeps appending at the
  // poll rate even though the backend decimates the historical backfill;
  // halving by stride keeps the trace bounded while preserving its span.
  cap() {
    for(const name of Object.keys(this._buf)) {
      const buf = this._buf[name];
      if(buf.length > CHART_BUF_CAP) {
        this._buf[name] = buf.filter((_, i) => i % 2 === 0);
      }
    }
  },

  //---------------------------------------------------------- Range / membership sync

  // Clamps `lastTs` down so the next poll backfills the new edge instead
  // of starting from "now" with no history.
  setRange(s) {
    this.range = s;
    const cutoff = Date.now() / 1000 - s;
    for(const n of Object.keys(this._lastTs)) {
      if(this._lastTs[n] > cutoff) this._lastTs[n] = cutoff;
    }
    for(const n of Object.keys(this._buf)) {
      this._buf[n] = (this._buf[n] || []).filter(p => p.ts >= cutoff);
    }
  },

  // Reconcile with `S.monitor`: drop unsubscribed, seed new ones with
  // `lastTs` at the window edge so first poll fetches full history. Also
  // detects rule slot flips (Ctrl:mode rpm→Hz): the active DB column
  // changes, so the buffer is cleared and lastTs is reset to backfill -
  // next poll fetches the new slot's history from the window edge.
  sync() {
    for(const n of Object.keys(this._buf)) {
      if(!S.monitor.has(n)) {
        delete this._buf[n];
        delete this._lastTs[n];
        delete this._activeSlot[n];
      }
    }
    const backfill = Date.now() / 1000 - this.range;
    for(const n of S.monitor) {
      const reg = S.regs.find(r => r.name === n);
      const col = this._activeColumn(reg);
      if(!(n in this._lastTs)) {
        this._lastTs[n] = backfill;
        this._buf[n] = [];
      }
      else if(this._activeSlot[n] !== col) {
        this._buf[n] = [];
        this._lastTs[n] = backfill;
      }
      this._activeSlot[n] = col;
    }
  },

  //---------------------------------------------------------- Grouping

  // Bucket monitored registers into panels sharing unit + scale (or by name
  // for bool/enum). Rule regs without an active slot are gated out - no
  // sample can land, so a panel would stay perpetually empty.
  groups() {
    const out = {};
    let idx = 0;
    for(const name of S.monitor) {
      const reg = S.regs.find(r => r.name === name);
      if(!reg || !this._activeColumn(reg)) continue;
      const key = chartGroupKey(reg);
      if(!out[key]) {
        const grp = {
          unit: Reg.unit(reg, true), key, idx: idx++,
          stepped: chartIsStepped(reg),
          type: reg.type,
          names: [],
        };
        if(reg.type === "enum" && reg.enum) {
          grp.enumLabels = {};
          for(const [k, v] of Object.entries(reg.enum)) grp.enumLabels[parseInt(k)] = v;
        }
        out[key] = grp;
      }
      out[key].names.push(name);
    }
    return out;
  },

  //---------------------------------------------------------- Prepare data for chart

  // Turn the buffer into uPlot-shaped `[xs, ...series]`. Gaps > gapThreshold
  // are bracketed with null markers so the renderer breaks the line instead
  // of interpolating. Edges padded with empties so a fresh chart still spans
  // the full requested range.
  prepare(names, stepped) {
    const [xMin, xMax] = this.xRange();
    const maps = {};
    const tsSet = new Set();
    for(const n of names) {
      const m = new Map();
      for(const p of (this._buf[n] || [])) {
        if(p.ts >= xMin) { m.set(p.ts, p.v); tsSet.add(p.ts); }
      }
      maps[n] = m;
    }
    const times = [...tsSet].sort((a, b) => a - b);
    const ts = [], vals = names.map(() => []);
    const gap = stepped ? 0 : this.gapThreshold();
    const emit = (t, nil) => {
      ts.push(t);
      for(let s = 0; s < names.length; s++) {
        vals[s].push(nil ? null : (maps[names[s]]?.get(t) ?? null));
      }
    };
    emit(xMin, !times.length || times[0] > xMin + 0.01);
    for(let i = 0; i < times.length; i++) {
      const prev = i === 0 ? xMin : times[i - 1];
      if(gap > 0 && times[i] - prev > gap) {
        emit(prev + 0.001, true);
        emit(times[i] - 0.001, true);
      }
      emit(times[i], false);
    }
    if(!times.length || times[times.length - 1] < xMax - 0.01) emit(xMax, true);
    return [ts, ...vals];
  },

  // Wipe the buffer. Called on disconnect so the next session starts fresh.
  clear() { this._buf = {}; this._lastTs = {}; this._activeSlot = {}; },
};
