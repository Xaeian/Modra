// scripts/monitor.js

// Chart config, time-series buffer, CSV export. Consumed by Monitor.jsx and chart.js.

//--------------------------------------------------------------------------------- Chart constants

// Live-window presets. Long ranges and `∞` (all history) are cheap: the backend
// serves them from the hour/day tiers, so a year is a few hundred points.
const CHART_RANGE_PRESETS = [
  { label: "2m", s: 120 },
  { label: "10m", s: 600 },
  { label: "1h", s: 3600 },
  { label: "6h", s: 21600 },
  { label: "24h", s: 86400 },
  { label: "7d", s: 604800 },
  { label: "30d", s: 2592000 },
  { label: "1y", s: 31536000 },
  { label: "∞", s: Infinity },
];

// Point budget that picks the resolution tier (see `store.query`). Short ranges
// stay on raw; higher = finer tiers but heavier fetches.
const CHART_TARGET_POINTS = 5000;

// Min gap between live refetches (ms). Re-pulling a full window every poll is
// wasteful; the chart keeps sliding on the buffer it already has.
const CHART_LIVE_MS = 1000;

// A zoom ending this close to "now" counts as live-edge and keeps topping up.
// Absorbs drag and refresh lag; further back is a deliberate historical view.
const CHART_EDGE_SEC = 15;

// Not filtered by available history: tiers cover any span.
function chartRanges() {
  return CHART_RANGE_PRESETS;
}

// One palette per panel index; series rotate within it so multi-trace panels
// stay distinct.
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

const CHART_SIZES = { S: 100, M: 200, L: 300 };
const CHART_SIZE_CYCLE = ["S", "M", "L"];
const CHART_SIZE_DEFAULT = "M";

// Gap floor: a longer hole breaks the line instead of interpolating. 15 ticks
// at the 500ms default ≈ 7.5s - past read jitter, short of a real disconnect.
const GAP_TICKS = 15;
const GAP_MIN_SEC = 5;

//--------------------------------------------------------------------------------- Time formatting

const _pad2 = (n) => String(n).padStart(2, "0");

// "13:45:09" - axis tick.
function chartFmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.getHours() + ":" + _pad2(d.getMinutes()) + ":" + _pad2(d.getSeconds());
}

// "26-05-12" - 2-digit year keeps axis labels narrow at the cost of post-2099 wrap.
function chartFmtDate(ts) {
  const d = new Date(ts * 1000);
  return String(d.getFullYear()).slice(2)
    + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate());
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

//-------------------------------------------------------------------------------- Color / grouping

const chartColor = (gi, si) => {
  const palette = CHART_COLORS[gi % CHART_COLORS.length];
  return palette[si % palette.length];
};

// Stepped where interpolation would lie: writable values jump between samples,
// discrete types have no in-between.
function chartIsStepped(reg) {
  return reg.rws !== "R"
    || ["bool", "enum", "bits", "hex"].includes(reg.type);
}

// Two registers share a panel iff unit and scale match; bool/enum/bits get one
// each (different y-axis semantics). The `true` arg picks the device-confirmed
// slot, so a rule reg regroups only once the write is ack'd.
function chartGroupKey(reg) {
  if(reg.type === "bool") return "bool|" + reg.name;
  if(reg.type === "enum") return "enum|" + reg.name;
  if(reg.type === "bits") return "bits|" + reg.name;
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

// JSON label maps come string-keyed; charts index them by numeric value.
function chartLabels(map) {
  const out = {};
  for(const [k, v] of Object.entries(map)) out[parseInt(k)] = v;
  return out;
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

//-------------------------------------------------------------------------------------- CSV export

// Rows align on the union of timestamps - missing samples are blank. Decimals
// come from `Reg.decimals` so values match the Grid.
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
    const reg = Reg.byName(n);
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

//------------------------------------------------------------------ MonitData (time-series buffer)

// Visible window only: each fetch returns the whole [from, to] at the right tier
// and REPLACES the buffer (no incremental append). `_buf[name]` -> [{ts, v}].
const MonitData = {

  range: 600,     // live window length (seconds)
  live: true,     // following "now" vs a frozen [from, to] from zoom/picker
  from: 0,        // frozen window start (used when !live)
  to: 0,          // frozen window stop
  _buf: {},
  tier: "raw",    // resolution tier serving the current window (for the UI)
  _nextFetch: 0,  // earliest ms epoch the live refetch may run again
  _edge: false,   // frozen zoom sits at the live edge -> top up on raw tier

  //---------------------------------------------------------------------------------------- Window

  window() {
    if(this.live) {
      const now = Date.now() / 1000;
      // `∞` -> from epoch start: all history, served from the day tier.
      return [this.range === Infinity ? 0 : now - this.range, now];
    }
    // Left anchor stays put, right edge follows "now", so new samples fill in.
    if(this._edge && this.tier === "raw") return [this.from, Date.now() / 1000];
    return [this.from, this.to];
  },

  //----------------------------------------------------------------------------------- Poll params

  // Floor only: `prepare` derives the real threshold from the data's own
  // spacing, since bucket width varies with the tier.
  gapMin() {
    const ms = parseInt(S.serial?.interval) || 500;
    return Math.max(ms * GAP_TICKS / 1000, GAP_MIN_SEC);
  },

  // Time range + point budget; tier selection lives in the backend. `fetchParams`
  // is the explicit fetch (range button, zoom, date pick); `readParams` polls and
  // returns null while frozen, so a zoomed window is not refetched every tick.
  fetchParams() {
    if(!S.monitor.size) return null;
    const [from, to] = this.window();
    return { from, to, names: [...S.monitor], max_points: CHART_TARGET_POINTS };
  },
  readParams() {
    if(!this.live && !(this._edge && this.tier === "raw")) return null;
    const now = Date.now();
    if(now < this._nextFetch) return null;
    this._nextFetch = now + CHART_LIVE_MS;
    if(!this.live) this.to = now / 1000;  // persist the followed edge
    return this.fetchParams();
  },

  //---------------------------------------------------------------------------------------- Ingest

  // DB column for the reg's active slot, or null when no slot resolves
  // (rule reg with switch=off, unpolled, etc). Callers gate on this.
  _activeColumn(reg) {
    if(!reg) return null;
    const base = reg.name.replace(":", "_");
    if(reg.type !== "rule") return base;
    const idx = Reg.ruleIndex(reg, true);
    return idx !== null ? `${base}_${idx}` : null;
  },

  // A non-array payload (cache-only poll) is ignored so a frozen chart is never
  // blanked. Rows arrive downsampled; only the active-slot column is projected.
  ingest(rows) {
    if(!Array.isArray(rows)) return;
    const next = {};
    const traces = [];  // [name, reg, col] per name with a resolvable column
    for(const name of S.monitor) {
      next[name] = [];
      const reg = Reg.byName(name);
      const col = this._activeColumn(reg);
      if(col) traces.push([name, reg, col]);
    }
    for(const row of rows) {
      for(const [name, reg, col] of traces) {
        const raw = row[col];
        if(raw == null) continue;  // gap: inactive slot / no data this bucket
        next[name].push({ ts: row.ts, v: typeof raw === "number" ? raw : chartToNum(reg, raw) });
      }
    }
    this._buf = next;
  },

  //----------------------------------------------------------------------- Range / membership sync

  setRange(s) { this.range = s; this.live = true; this._edge = false; },

  // Frozen window from a drag-zoom or date picker.
  setWindow(from, to) {
    this.from = from; this.to = to; this.live = false;
    this._edge = (Date.now() / 1000 - to) <= CHART_EDGE_SEC;
  },

  // Drop unsubscribed names; the next fetch repopulates the rest.
  sync() {
    for(const n of Object.keys(this._buf)) if(!S.monitor.has(n)) delete this._buf[n];
  },

  //-------------------------------------------------------------------------------------- Grouping

  // Rule regs without an active slot are gated out: no sample can land, so the
  // panel would stay perpetually empty.
  groups() {
    const out = {};
    let idx = 0;
    for(const name of S.monitor) {
      const reg = Reg.byName(name);
      if(!reg || !this._activeColumn(reg)) continue;
      const key = chartGroupKey(reg);
      if(!out[key]) {
        const grp = {
          unit: Reg.unit(reg, true), key, idx: idx++,
          stepped: chartIsStepped(reg),
          type: reg.type,
          names: [],
        };
        if(reg.type === "enum" && reg.enum) grp.enumLabels = chartLabels(reg.enum);
        if(reg.type === "bits" && reg.bits) grp.bitsLabels = chartLabels(reg.bits);
        out[key] = grp;
      }
      out[key].names.push(name);
    }
    return out;
  },

  //------------------------------------------------------------------------ Prepare data for chart

  // Buffer -> uPlot `[xs, ...series]`. Edges are padded with empties so a fresh
  // chart still spans the full requested window.
  prepare(names) {
    const [xMin, xMax] = this.window();
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
    // Break holes wider than ~3x the median spacing, floored by gapMin (tolerates
    // jitter, breaks even a lone pair across a real hole). Stepped enum/bool too:
    // a held value is sampled every poll, so a true hole has no samples to bridge.
    let gap = this.gapMin();
    if(times.length > 2) {
      const diffs = [];
      for(let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
      diffs.sort((a, b) => a - b);
      gap = Math.max(gap, diffs[diffs.length >> 1] * 3);
    }
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

  // Called on disconnect so the next session starts fresh.
  clear() { this._buf = {}; },
};
