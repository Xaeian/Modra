// scripts/monitor.js

const CHART_RANGES = [
  {label: '2m',  s: 120},
  {label: '10m', s: 600},
  {label: '1h',  s: 3600},
  {label: '6h',  s: 21600},
  {label: '24h', s: 86400},
  {label: '7d',  s: 604800},
  {label: '∞',   s: Infinity},
];

const CHART_COLORS = [
  // Ocean: blue→teal→indigo + orange, emerald, pink
  ['#1D4ED8', '#0EA5E9', '#0D9488', '#0369A1', '#6366F1',
   '#10B981', '#DB2777', '#7C3AED', '#64748B', '#F97316'],
  // Fire: red→orange→magenta→amber→wine + blue, emerald, purple
  ['#DC2626', '#B45309', '#DB2777', '#EA580C', '#9F1239',
   '#3B82F6', '#D97706', '#10B981', '#7C3AED',  '#64748B'],
  // Forest: green→teal→lime→emerald→olive + orange, blue, red, purple
  ['#15803D', '#0D9488', '#65A30D', '#059669', '#4D7C0F',
   '#EA580C', '#3B82F6', '#DC2626', '#7C3AED', '#78716C'],
  // Sun: amber→red→orange→rust→brown + blue, emerald, purple, teal
  ['#D97706', '#DC2626', '#EA580C', '#B45309', '#92400E',
   '#2563EB', '#10B981', '#7C3AED', '#0891B2', '#78716C'],
  // Violet: purple→indigo→pink→deep-violet→wine + teal, orange, emerald
  ['#7C3AED', '#6366F1', '#DB2777', '#4338CA', '#9F1239',
   '#0891B2', '#F97316', '#10B981', '#1D4ED8', '#64748B'],
  // Aqua: cyan→teal→sky→emerald→ocean + rose, amber, purple, green
  ['#0891B2', '#0D9488', '#0EA5E9', '#059669', '#0369A1',
   '#F43F5E', '#D97706', '#7C3AED', '#16A34A', '#64748B'],
  // Tangerine: orange→amber→red→rust→pink + blue, emerald, purple, teal
  ['#EA580C', '#D97706', '#DC2626', '#B45309', '#DB2777',
   '#3B82F6', '#10B981', '#7C3AED', '#0891B2', '#78716C'],
  // Rose: pink→crimson→wine→red→purple + teal, emerald, orange, blue
  ['#DB2777', '#E11D48', '#9F1239', '#F43F5E', '#7C3AED',
   '#0891B2', '#10B981', '#F97316', '#1D4ED8', '#64748B'],
  // Earth: sienna→rust→olive→umber→teal + blue, red, purple, cyan
  ['#92400E', '#B45309', '#65A30D', '#A16207', '#0D9488',
   '#3B82F6', '#DC2626', '#7C3AED', '#0891B2', '#78716C'],
];

const CHART_SIZES = {S: 100, M: 250, L: 450};
const CHART_SIZE_CYCLE = ['S', 'M', 'L'];
const CHART_SIZE_DEFAULT = 'M';

//--------------------------------------------------------------------------------- Time format

function chartFmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.getHours() + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

function chartFmtDate(ts) {
  const d = new Date(ts * 1000);
  return String(d.getFullYear()).slice(2) + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function chartFmtFull(ts) {
  return chartFmtDate(ts) + ' ' + chartFmtTime(ts);
}

function chartFmtAxisX() {
  return (u, vals) => vals.map(v => chartFmtDate(v) + '\n' + chartFmtTime(v));
}

function chartFmtCSV(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

//---------------------------------------------------------------------------- Color / grouping

function chartColor(gi, si) {
  return CHART_COLORS[gi % CHART_COLORS.length][si % CHART_COLORS[0].length];
}

function chartIsStepped(reg) {
  return reg.rws !== 'R' || reg.type === 'bool' || reg.type === 'enum' || reg.type === 'hex';
}

function chartGroupKey(reg) {
  if(reg.type === 'bool') return 'bool|' + reg.name;
  if(reg.type === 'enum') return 'enum|' + reg.name;
  const unit = Array.isArray(reg.unit) ? reg.unit[0] : (reg.unit || '');
  const scale = Array.isArray(reg.scale) ? reg.scale[0] : (reg.scale || 1);
  return unit + '|' + scale;
}

function chartTagColors() {
  const map = {};
  for(const grp of Object.values(MonitData.groups()))
    grp.names.forEach((name, i) => { map[name] = chartColor(grp.idx, i); });
  return map;
}

function chartToNum(reg, value) {
  if(value == null) return null;
  if(typeof value === 'number') return value;
  if(reg.type === 'enum' && reg.enum) {
    const map = {};
    for(const [k, v] of Object.entries(reg.enum)) map[v] = parseInt(k);
    return map[value] ?? null;
  }
  if(reg.type === 'bool') return value ? 1 : 0;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

//---------------------------------------------------------------------------------- CSV export

function chartExportCSV(names, buf) {
  const allTs = new Set();
  for(const n of names)
    for(const p of (buf[n] || [])) allTs.add(p.ts);
  const sorted = [...allTs].sort((a, b) => a - b);
  if(!sorted.length) return;
  const maps = {}, decs = {};
  for(const n of names) {
    const m = new Map();
    for(const p of (buf[n] || [])) m.set(p.ts, p.v);
    maps[n] = m;
    const reg = S.regs.find(r => r.name === n);
    const step = reg ? Reg.step(reg) : 1;
    decs[n] = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  }
  const rows = sorted.map(ts => {
    const row = {time: chartFmtCSV(ts)};
    for(const n of names) {
      const v = maps[n].get(ts);
      row[n] = v != null ? v.toFixed(decs[n]) : '';
    }
    return row;
  });
  CSV.save(`monitor@${fileStamp()}.csv`, rows, ['time', ...names]);
}

// ---------------------------------------------------------------------------------- MonitData

const MonitData = {
  range: 600,
  _buf: {},    // {name: [{ts, v}, ...]}
  _lastTs: {}, // {name: last_ingested_ts}

  // ---------------------------------------------------------------------------------- X range

  xRange() {
    if(isFinite(this.range)) {
      const now = Date.now() / 1000;
      return [now - this.range, now];
    }
    const [lo, hi] = this._bufExtent();
    if(lo == null) {
      const now = Date.now() / 1000;
      return [now - 60, now];
    }
    const pad = Math.max((hi - lo) * 0.02, 1);
    return [lo - pad, hi + pad];
  },

  _bufExtent() {
    let lo = Infinity, hi = -Infinity;
    for(const pts of Object.values(this._buf)) {
      if(!pts.length) continue;
      if(pts[0].ts < lo) lo = pts[0].ts;
      if(pts[pts.length - 1].ts > hi) hi = pts[pts.length - 1].ts;
    }
    return isFinite(lo) ? [lo, hi] : [null, null];
  },

  // ------------------------------------------------------------------------------ Poll params

  gapThreshold() {
    const ms = parseInt(S.serial?.interval || 200);
    return Math.max(ms * 15 / 1000, 5);
  },

  readParams() {
    if(!S.monitor.size) return null;
    const vals = Object.values(this._lastTs);
    return {
      since: vals.length ? Math.max(0, Math.min(...vals)) : 0,
      names: [...S.monitor],
      limit: 5000,
    };
  },

  // ---------------------------------------------------------------------------- Ingest / trim

  ingest(rows) {
    if(!rows?.length) return;
    for(const row of rows) {
      for(const name of S.monitor) {
        if(row.ts <= (this._lastTs[name] || 0)) continue;
        if(!this._buf[name]) this._buf[name] = [];
        const col = name.replace(':', '_');
        let v = row[col] ?? null;
        if(v != null && typeof v !== 'number') {
          const reg = S.regs.find(r => r.name === name);
          if(reg) v = chartToNum(reg, v);
        }
        this._buf[name].push({ts: row.ts, v});
        this._lastTs[name] = row.ts;
      }
    }
    this.trim();
  },

  trim() {
    if(!isFinite(this.range)) return;
    const cutoff = Date.now() / 1000 - this.range;
    for(const buf of Object.values(this._buf))
      while(buf.length > 1 && buf[0].ts < cutoff) buf.shift();
  },

  // ---- Range / sync

  setRange(s) {
    this.range = s;
    const cutoff = isFinite(s) ? Date.now() / 1000 - s : 0;
    for(const n of Object.keys(this._lastTs))
      if(this._lastTs[n] > cutoff) this._lastTs[n] = cutoff;
    if(isFinite(s)) {
      for(const n of Object.keys(this._buf))
        this._buf[n] = (this._buf[n] || []).filter(p => p.ts >= cutoff);
    }
  },

  sync() {
    for(const n of Object.keys(this._buf))
      if(!S.monitor.has(n)) { delete this._buf[n]; delete this._lastTs[n]; }
    const backfill = isFinite(this.range) ? Date.now() / 1000 - this.range : 0;
    for(const n of S.monitor) {
      if(!(n in this._lastTs)) {
        this._lastTs[n] = backfill;
        this._buf[n] = [];
      }
    }
  },

  // --------------------------------------------------------------------------------- Grouping

  groups() {
    const out = {};
    let idx = 0;
    for(const name of S.monitor) {
      const reg = S.regs.find(r => r.name === name);
      if(!reg) continue;
      const key = chartGroupKey(reg);
      if(!out[key]) {
        const unit = Array.isArray(reg.unit) ? reg.unit[0] : (reg.unit || '');
        const grp = {unit, key, idx: idx++, stepped: chartIsStepped(reg), type: reg.type, names: []};
        if(reg.type === 'enum' && reg.enum) {
          grp.enumLabels = {};
          for(const [k, v] of Object.entries(reg.enum)) grp.enumLabels[parseInt(k)] = v;
        }
        out[key] = grp;
      }
      out[key].names.push(name);
    }
    return out;
  },

  // ------------------------------------------------------------------- Prepare data for chart

  prepare(names, stepped) {
    const [xMin, xMax] = this.xRange();
    const maps = {};
    const tsSet = new Set();
    for(const n of names) {
      const m = new Map();
      for(const p of (this._buf[n] || []))
        if(p.ts >= xMin) { m.set(p.ts, p.v); tsSet.add(p.ts); }
      maps[n] = m;
    }
    const times = [...tsSet].sort((a, b) => a - b);
    const ts = [], vals = names.map(() => []);
    const gap = stepped ? 0 : this.gapThreshold();
    const emit = (t, nil) => {
      ts.push(t);
      for(let s = 0; s < names.length; s++)
        vals[s].push(nil ? null : (maps[names[s]]?.get(t) ?? null));
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
    if(!times.length || times[times.length - 1] < xMax - 0.01)
      emit(xMax, true);
    return [ts, ...vals];
  },

  clear() { this._buf = {}; this._lastTs = {}; },
};