// scripts/monitor.js

// Chart config, time-series buffer, CSV export. Consumed by `Monitor`.

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

/** Local time of day of a timestamp in seconds, as an axis tick shows it: "13:45:09". */
function chartFmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.getHours() + ":" + _pad2(d.getMinutes()) + ":" + _pad2(d.getSeconds());
}

/**
 * Local date of a timestamp in seconds, as "26-05-12".
 * The 2-digit year keeps axis labels narrow, at the cost of a wrap after 2099.
 */
function chartFmtDate(ts) {
  const d = new Date(ts * 1000);
  return String(d.getFullYear()).slice(2)
    + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate());
}

/** Date and time of a timestamp in seconds, as "26-05-12 13:45:09". */
const chartFmtFull = (ts) => chartFmtDate(ts) + " " + chartFmtTime(ts);

/** A uPlot `values` formatter for the x-axis, each tick a date over a time on two lines. */
const chartFmtAxisX = () => (u, vals) => vals.map(v => chartFmtDate(v) + "\n" + chartFmtTime(v));

/** Full stamp of a timestamp in seconds for a CSV export, sortable: "2026-05-12 13:45:09". */
function chartFmtCSV(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + "-" + _pad2(d.getMonth() + 1) + "-" + _pad2(d.getDate())
    + " " + _pad2(d.getHours()) + ":" + _pad2(d.getMinutes()) + ":" + _pad2(d.getSeconds());
}

//-------------------------------------------------------------------------------- Color / grouping

/** Color of series `si` in panel `gi`, each panel its own palette; both indexes wrap around. */
const chartColor = (gi, si) => {
  const palette = CHART_COLORS[gi % CHART_COLORS.length];
  return palette[si % palette.length];
};

/**
 * Whether a register's trace is drawn stepped, which is where interpolation would lie:
 * writable values jump between samples, discrete types have no in-between.
 */
function chartIsStepped(reg) {
  return reg.rws !== "R"
    || ["bool", "enum", "bits", "hex"].includes(reg.type);
}

/**
 * Key of the chart panel a register goes in.
 * Two registers share a panel exactly when unit and scale match;
 * a bool, enum or bits register gets one of its own, its y-axis meaning something else.
 * A rule register regroups only once the device has confirmed the write that moved its slot.
 */
function chartGroupKey(reg) {
  if(reg.type === "bool") return "bool|" + reg.name;
  if(reg.type === "enum") return "enum|" + reg.name;
  if(reg.type === "bits") return "bits|" + reg.name;
  return Reg.unit(reg, true) + "|" + Reg.scale(reg, true);
}

/** Hex color of every charted register by name, so the tag bar mirrors the panel series. */
function chartTagColors() {
  const map = {};
  for(const grp of Object.values(MonitData.groups())) {
    grp.names.forEach((name, i) => { map[name] = chartColor(grp.idx, i); });
  }
  return map;
}

/** A label map keyed by number, as a chart indexes it; JSON gives the keys as strings. */
function chartLabels(map) {
  const out = {};
  for(const [k, v] of Object.entries(map)) out[parseInt(k)] = v;
  return out;
}

/**
 * A value as the number uPlot plots, `null` when there is none:
 * the backend gives an enum as its label and a bool as a JS boolean.
 */
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

/**
 * CSV download of these traces, one row for each timestamp any of them has.
 * A missing sample is blank, and decimals come from `Reg.decimals`, so values match the grid.
 * @param {string[]} names  register names, in column order
 * @param {Record<string, Array<{ts: number, v: number}>>} buf  samples by name, `ts` in seconds
 */
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

  /**
   * Window the chart shows, `[from, to]` in seconds:
   * the last `range` while live, the frozen one otherwise.
   */
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
    return Math.max(S.serial.interval * GAP_TICKS / 1000, GAP_MIN_SEC);
  },

  /**
   * Time range and point budget of an explicit fetch: a range button, a zoom, a date pick.
   * Tier selection lives in the backend. `null` while nothing is charted.
   */
  fetchParams() {
    if(!S.monitor.size) return null;
    const [from, to] = this.window();
    return { from, to, names: [...S.monitor], max_points: CHART_TARGET_POINTS };
  },
  /**
   * `fetchParams` for a poll, at most once per `CHART_LIVE_MS` and `null` in between.
   * A frozen window gets `null` too, so a zoomed window is not refetched every tick;
   * one that ends at the live edge on the raw tier still tops up.
   */
  readParams() {
    if(!this.live && !(this._edge && this.tier === "raw")) return null;
    const now = Date.now();
    if(now < this._nextFetch) return null;
    this._nextFetch = now + CHART_LIVE_MS;
    if(!this.live) this.to = now / 1000; // persist the followed edge
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

  /**
   * The buffer replaced by the rows of one read, a trace for each charted name.
   * A non-array payload (a cache-only poll) is ignored, so a frozen chart is never blanked.
   * Rows arrive downsampled; only the active-slot column is projected.
   */
  ingest(rows) {
    if(!Array.isArray(rows)) return;
    const next = {};
    const traces = []; // [name, reg, col] per name with a resolvable column
    for(const name of S.monitor) {
      next[name] = [];
      const reg = Reg.byName(name);
      const col = this._activeColumn(reg);
      if(col) traces.push([name, reg, col]);
    }
    for(const row of rows) {
      for(const [name, reg, col] of traces) {
        const raw = row[col];
        if(raw == null) continue; // gap: inactive slot / no data this bucket
        next[name].push({ ts: row.ts, v: typeof raw === "number" ? raw : chartToNum(reg, raw) });
      }
    }
    this._buf = next;
  },

  //----------------------------------------------------------------------- Range / membership sync

  /** A live window of the last `s` seconds, `Infinity` for all history. */
  setRange(s) { this.range = s; this.live = true; this._edge = false; },

  /**
   * A frozen window from a drag-zoom or a date picker, `from` and `to` in seconds.
   * One ending within `CHART_EDGE_SEC` of now counts as the live edge and keeps topping up.
   */
  setWindow(from, to) {
    this.from = from; this.to = to; this.live = false;
    this._edge = (Date.now() / 1000 - to) <= CHART_EDGE_SEC;
  },

  /** Samples of names no longer charted dropped; the next fetch repopulates the rest. */
  sync() {
    for(const n of Object.keys(this._buf)) if(!S.monitor.has(n)) delete this._buf[n];
  },

  //-------------------------------------------------------------------------------------- Grouping

  /**
   * Charted registers as panels, keyed by `chartGroupKey`: each group has its `unit`,
   * palette `idx`, member `names`, and the type and labels its y-axis reads.
   * A rule register without an active slot is left out: no sample can land,
   * so its panel would stay perpetually empty.
   */
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

  /**
   * The buffer as uPlot data for these traces, `[xs, ...series]`, a real hole broken by nulls.
   * The window edges are not padded: the x-scale is set explicitly by the chart,
   * and an empty point at the live edge would sit under the pointer instead of the last sample.
   */
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
    for(let i = 0; i < times.length; i++) {
      if(i > 0 && gap > 0 && times[i] - times[i - 1] > gap) {
        emit(times[i - 1] + 0.001, true);
        emit(times[i] - 0.001, true);
      }
      emit(times[i], false);
    }
    return [ts, ...vals];
  },

  /** Every sample held, by register name, each a list of `{ts, v}`. */
  samples() { return this._buf; },

  /** Every sample dropped, once the history they came from is deleted. */
  clear() { this._buf = {}; },
};
