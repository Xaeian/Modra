// scripts/Monitor.jsx

const Monitor = {
  _stack: null,
  _el: null,
  _keys: [],
  _rangeBusy: false,

  Bar() {
    if(!S.monitor.size) return null;
    const colors = chartTagColors();
    return (
      <div class="rb-monitor">
        <div class="rb-monitor-bar">
          {[...S.monitor].map(name => {
            const reg = S.regs.find(r => r.name === name);
            const c = colors[name];
            return (
              <span class="rb-monitor-tag" onClick={() => reg && monitor(reg)}>
                {c && <i class="rb-tag-dot" style={'background:' + c}></i>}
                {name} ✕
              </span>
            );
          })}
          <span class="rb-monitor-sep" />
          {CHART_RANGES.map(r => (
            <button
              class={`rb-range-btn${MonitData.range === r.s ? ' active' : ''}${Monitor._rangeBusy ? ' busy' : ''}`}
              onClick={() => Monitor.changeRange(r.s)}
              disabled={Monitor._rangeBusy}
            >{r.label}</button>
          ))}
          <span class="rb-monitor-sep" />
          <button class="rb-range-btn" onClick={() => Monitor.exportCSV()}
            title="Export CSV">💾</button>
        </div>
        <div class="rb-monitor-slot"></div>
      </div>
    );
  },

  mount() {
    const slot = document.querySelector('.rb-monitor-slot');
    if(!slot) return;
    if(!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'rb-charts';
    }
    slot.appendChild(this._el);
  },

  update(rows) {
    if(!S.monitor.size || !this._stack) return;
    if(rows?.length) MonitData.ingest(rows);
    const [xMin, xMax] = MonitData.xRange();
    if(this._stack.autoScroll) {
      this._stack._xMin = xMin;
      this._stack._xMax = xMax;
    } else if(this._stack._zoomMax != null && xMax - this._stack._zoomMax < 2) {
      const w = this._stack._zoomMax - this._stack._zoomMin;
      this._stack._zoomMin = xMax - w;
      this._stack._zoomMax = xMax;
    }
    this._feedAll();
  },

  refresh() {
    MonitData.sync();
    let savedRange = null;
    let savedZoom = null;
    if(this._stack) {
      savedRange = this._stack.getXRange();
      if(!this._stack.autoScroll && this._stack._zoomMin != null)
        savedZoom = [this._stack._zoomMin, this._stack._zoomMax, this._stack._autoScroll];
      this._stack.destroy();
      this._stack = null;
    }
    this._keys = [];
    if(!S.monitor.size) {
      if(this._el) this._el.innerHTML = '';
      return;
    }
    if(!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'rb-charts';
    }
    this._el.innerHTML = '';
    const groups = MonitData.groups();
    const [xMin, xMax] = MonitData.xRange();
    this._stack = new ChartStack(this._el, {
      formatX: chartFmtAxisX(),
      formatXValue: chartFmtFull,
    });
    for(const [key, grp] of Object.entries(groups)) {
      this._keys.push(key);
      const panelCfg = {
        unit: grp.unit,
        series: grp.names.map((name, i) => ({
          label: name.includes(':') ? name.split(':').pop() : name,
          color: chartColor(grp.idx, i),
          stepped: grp.stepped,
        })),
      };
      if(grp.type === 'bool') {
        panelCfg.yRange = [-0.2, 1.2];
        panelCfg.yFormat = v => v == null ? '—' : v >= 0.5 ? 'ON' : 'OFF';
      } else if(grp.type === 'enum' && grp.enumLabels) {
        const keys = Object.keys(grp.enumLabels).map(Number);
        const lo = Math.min(...keys), hi = Math.max(...keys);
        panelCfg.yRange = [lo - 0.5, hi + 0.5];
        const labels = grp.enumLabels;
        panelCfg.yFormat = v => v == null ? '—' : (labels[Math.round(v)] ?? csFmtVal(v));
      }
      const sz = CHART_SIZE_CYCLE.includes(S.chartSizes[key]) ? S.chartSizes[key] : CHART_SIZE_DEFAULT;
      panelCfg.height = CHART_SIZES[sz];
      this._stack.addPanel(panelCfg);
    }
    this._stack.build();
    this._keys.forEach((key, i) => {
      const wrap = this._stack._entries[i]?.wrap;
      if(!wrap) return;
      const sz = S.chartSizes[key] || CHART_SIZE_DEFAULT;
      const btn = document.createElement('button');
      btn.className = 'cs-size-btn';
      btn.textContent = sz;
      btn.onclick = () => {
        const cur = S.chartSizes[key] || 'S';
        const idx = CHART_SIZE_CYCLE.indexOf(cur);
        S.chartSizes[key] = CHART_SIZE_CYCLE[(idx + 1) % CHART_SIZE_CYCLE.length];
        Monitor.refresh();
        Monitor.mount();
        saveMonitor();
      };
      wrap.appendChild(btn);
    });
    if(savedZoom) {
      this._stack._autoScroll = savedZoom[2];
      this._stack._zoomMin = savedZoom[0];
      this._stack._zoomMax = savedZoom[1];
    }
    if(savedRange && savedRange[0] != null) {
      this._stack._xMin = savedRange[0];
      this._stack._xMax = savedRange[1];
    } else {
      this._stack._xMin = xMin;
      this._stack._xMax = xMax;
    }
    this._feedAll();
    this._stack.seedRange(this._stack._xMin, this._stack._xMax);
  },

  async changeRange(s) {
    if(this._rangeBusy) return;
    this._rangeBusy = true;
    if(MonitData.range !== s) MonitData.setRange(s);
    render();
    this.mount();
    const params = MonitData.readParams();
    if(params) {
      const res = await API.read(params);
      if(res?.rows?.length) MonitData.ingest(res.rows);
    }
    if(this._stack) {
      this._stack._autoScroll = true;
      this._stack._zoomMin = null;
      this._stack._zoomMax = null;
      const [xMin, xMax] = MonitData.xRange();
      this._stack._xMin = xMin;
      this._stack._xMax = xMax;
      this._feedAll();
    }
    this._rangeBusy = false;
    render();
    this.mount();
  },

  destroy() {
    if(this._stack) { this._stack.destroy(); this._stack = null; }
    MonitData.clear();
    this._keys = [];
    if(this._el) { this._el.remove(); this._el = null; }
  },

  exportCSV() {
    chartExportCSV([...S.monitor], MonitData._buf);
  },

  _feedAll() {
    if(!this._stack) return;
    const groups = MonitData.groups();
    this._keys.forEach((key, i) => {
      const grp = groups[key];
      if(!grp) return;
      const data = MonitData.prepare(grp.names, grp.stepped);
      if(data) this._stack.setData(i, data);
    });
  },
};