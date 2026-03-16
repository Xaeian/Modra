// monitor.js — data layer for real-time monitoring

const CHART_RANGES = [
  {label: '2m',   s: 120},
  {label: '10m',  s: 600},
  {label: '1h',   s: 3600},
  {label: '6h',   s: 21600},
  {label: '24h',  s: 86400},
];

const CHART_COLORS = [
  ['#4996FF', '#254B7F', '#3771BF', '#6CB4FF', '#122640'],
  ['#CD0D23', '#5C0002', '#94090D', '#E02D3A', '#4C1B22'],
  ['#45BF55', '#044D29', '#168039', '#82C677', '#1A4D2B'],
  ['#FFCE00', '#ED9200', '#F2CD5C', '#E0B241', '#8E5F1A'],
  ['#8B10C4', '#63208E', '#9749C9', '#A952D8', '#693E84'],
  ['#15BFD1', '#218E93', '#5BCECE', '#2AA2A8', '#287B7F'],
  ['#FF6C00', '#FF150A', '#FF9000', '#FF430A', '#B24D08'],
  ['#BF0058', '#7F003B', '#BA3879', '#E23795', '#701145'],
  ['#A66F3F', '#733924', '#93856D', '#513920', '#8C512E'],
];

// ---------------------------------------------------------------- Time format

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

// ---------------------------------------------------------------- Color / grouping

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

function chartEnumMap(reg) {
  if(!reg.enum) return {};
  const map = {};
  for(const [k, v] of Object.entries(reg.enum)) map[v] = parseInt(k);
  return map;
}

function chartToNum(reg, value) {
  if(value == null) return null;
  if(typeof value === 'number') return value;
  if(reg.type === 'enum' && reg.enum) {
    const map = chartEnumMap(reg);
    return map[value] ?? null;
  }
  if(reg.type === 'bool') return value ? 1 : 0;
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function chartTagColors() {
  const map = {};
  const groups = MonitData.groups();
  for(const grp of Object.values(groups)) {
    grp.names.forEach((name, i) => { map[name] = chartColor(grp.idx, i); });
  }
  return map;
}

// ---------------------------------------------------------------- CSV export

function chartFmtCSV(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

function chartExportCSV(names, buf) {
  const allTs = new Set();
  for(const n of names) for(const p of (buf[n] || [])) allTs.add(p.ts);
  const sorted = [...allTs].sort((a, b) => a - b);
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
  if(rows.length) CSV.save(`monitor@${fileStamp()}.csv`, rows, ['time', ...names]);
}

// ---------------------------------------------------------------- MonitData

const MonitData = {
  range: 600,
  _buf: {},
  _lastTs: {},

  gapThreshold() {
    const ms = parseInt(S.serial?.interval || 200);
    return Math.max(ms * 15 / 1000, 5);
  },

  /** Params for POST /read when monitor is active. null if no monitors. */
  readParams() {
    if(!S.monitor.size) return null;
    const vals = Object.values(this._lastTs);
    return {
      since: vals.length ? Math.min(...vals) : 0,
      names: [...S.monitor],
      limit: 5000,
    };
  },

  /** Process rows from backend response — per-name dedup. */
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
    const cutoff = Date.now() / 1000 - this.range;
    for(const n of Object.keys(this._buf)) {
      const buf = this._buf[n];
      while(buf.length > 1 && buf[0].ts < cutoff) buf.shift();
    }
  },

  /** Sync with S.monitor — remove old, backfill new. Preserves existing data. */
  sync() {
    for(const n of Object.keys(this._buf)) {
      if(!S.monitor.has(n)) { delete this._buf[n]; delete this._lastTs[n]; }
    }
    const backfill = Date.now() / 1000 - this.range;
    for(const n of S.monitor) {
      if(!(n in this._lastTs)) {
        this._lastTs[n] = backfill;
        this._buf[n] = [];
      }
    }
  },

  /** Range change — adjust all per-name lastTs, trim buffers. */
  setRange(s) {
    this.range = s;
    const cutoff = Date.now() / 1000 - s;
    for(const n of Object.keys(this._lastTs))
      this._lastTs[n] = Math.min(this._lastTs[n], cutoff);
    for(const n of Object.keys(this._buf))
      this._buf[n] = (this._buf[n] || []).filter(p => p.ts >= cutoff);
  },

  groups() {
    const out = {};
    let idx = 0;
    for(const name of S.monitor) {
      const reg = S.regs.find(r => r.name === name);
      if(!reg) continue;
      const key = chartGroupKey(reg);
      if(!out[key]) {
        const unit = Array.isArray(reg.unit) ? reg.unit[0] : (reg.unit || '');
        const grp = {
          unit, key,
          stepped: chartIsStepped(reg),
          type: reg.type,
          names: [], idx: idx++,
        };
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

  prepare(names, stepped) {
    const cutoff = Date.now() / 1000 - this.range;
    const tsSet = new Set();
    for(const n of names)
      for(const p of (this._buf[n] || []))
        if(p.ts >= cutoff) tsSet.add(p.ts);
    const times = [...tsSet].sort((a, b) => a - b);
    if(!times.length) return null;
    const maps = {};
    for(const n of names) {
      const m = new Map();
      for(const p of (this._buf[n] || []))
        if(p.ts >= cutoff) m.set(p.ts, p.v);
      maps[n] = m;
    }
    const ts = [], vals = names.map(() => []);
    const gap = stepped ? 0 : this.gapThreshold();
    const emit = (t, nil) => {
      ts.push(t);
      for(let s = 0; s < names.length; s++)
        vals[s].push(nil ? null : (maps[names[s]].get(t) ?? null));
    };
    emit(times[0], false);
    for(let i = 1; i < times.length; i++) {
      if(gap > 0 && times[i] - times[i - 1] > gap) {
        emit(times[i - 1] + 0.001, true);
        emit(times[i] - 0.001, true);
      }
      emit(times[i], false);
    }
    return [ts, ...vals];
  },

  clear() { this._buf = {}; this._lastTs = {}; },
};