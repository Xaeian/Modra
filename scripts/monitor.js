// monitor.js — data layer for real-time monitoring

const CHART_RANGES = [
  {label: '2min',  s: 120},
  {label: '10min', s: 600},
  {label: '1h',    s: 3600},
  {label: '6h',    s: 21600},
  {label: '24h',   s: 86400},
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
  _histLoaded: new Set(),
  _loading: false,

  gapThreshold() {
    const ms = parseInt(S.serial?.interval || 200);
    return Math.max(ms * 15 / 1000, 5);
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

  push(values) {
    if(!S.monitor.size) return;
    const ts = Date.now() / 1000;
    const cutoff = ts - this.range;
    for(const name of S.monitor) {
      if(!this._buf[name]) this._buf[name] = [];
      const buf = this._buf[name];
      let v = values[name] ?? null;
      if(v != null && typeof v !== 'number') {
        const reg = S.regs.find(r => r.name === name);
        if(reg) v = chartToNum(reg, v);
      }
      buf.push({ts, v});
      while(buf.length > 1 && buf[0].ts < cutoff) buf.shift();
    }
  },

  async load() {
    if(!S.monitor.size) return;
    this._loading = true;
    const t0 = Date.now() / 1000 - this.range;
    const interval_s = parseInt(S.serial?.interval || 200) / 1000;
    const limit = Math.min(Math.ceil(this.range / interval_s * 1.2), 50000);
    for(const grp of Object.values(this.groups())) {
      const need = grp.names.filter(n => !this._histLoaded.has(n));
      if(!need.length) continue;
      try {
        const rows = await API.history({names: grp.names, t0, limit});
        if(!rows?.length) continue;
        for(const name of grp.names) {
          const col = name.replace(':', '_');
          const reg = S.regs.find(r => r.name === name);
          const hist = rows.map(r => {
            let v = r[col] ?? null;
            if(v != null && typeof v !== 'number' && reg) v = chartToNum(reg, v);
            return {ts: r.ts, v};
          });
          const live = this._buf[name] || [];
          const liveStart = live.length ? live[0].ts : Infinity;
          this._buf[name] = [...hist.filter(p => p.ts < liveStart), ...live];
          this._histLoaded.add(name);
        }
      } catch(e) { console.error('MonitData.load:', e); }
    }
    this._loading = false;
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

  async rebuild() {
    for(const n of Object.keys(this._buf))
      if(!S.monitor.has(n)) { delete this._buf[n]; this._histLoaded.delete(n); }
    if([...S.monitor].some(n => !this._histLoaded.has(n)))
      await this.load();
  },

  async setRange(seconds) {
    this.range = seconds;
    this._histLoaded.clear();
    const cutoff = Date.now() / 1000 - seconds;
    for(const n of Object.keys(this._buf))
      this._buf[n] = (this._buf[n] || []).filter(p => p.ts >= cutoff);
    await this.load();
  },

  clear() { this._buf = {}; this._histLoaded.clear(); },
};