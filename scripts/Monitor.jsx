// Monitor.jsx — monitoring UI (uses ChartStack from lib/chart.js)

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
              class={`rb-range-btn${MonitData.range === r.s ? ' active' : ''}`}
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

  update() {
    if(!S.monitor.size || !this._stack) return;
    MonitData.push(S.values);
    const now = Date.now() / 1000;
    if(this._stack.autoScroll) {
      this._stack._xMin = now - MonitData.range;
      this._stack._xMax = now;
    } else if(this._stack._zoomMax != null && now - this._stack._zoomMax < 2) {
      const w = this._stack._zoomMax - this._stack._zoomMin;
      this._stack._zoomMin = now - w;
      this._stack._zoomMax = now;
    }
    this._feedAll();
  },

  async refresh() {
    await MonitData.rebuild();
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
    const now = Date.now() / 1000;
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
      this._stack.addPanel(panelCfg);
    }
    this._stack.build();
    // Set range BEFORE feed so _currentRange() has valid values
    if(savedZoom) {
      this._stack._autoScroll = savedZoom[2];
      this._stack._zoomMin = savedZoom[0];
      this._stack._zoomMax = savedZoom[1];
    }
    if(savedRange && savedRange[0] != null) {
      this._stack._xMin = savedRange[0];
      this._stack._xMax = savedRange[1];
    } else {
      this._stack._xMin = now - MonitData.range;
      this._stack._xMax = now;
    }
    this._feedAll();
    this._stack.seedRange(this._stack._xMin, this._stack._xMax);
  },

  async changeRange(s) {
    if(MonitData.range === s || this._rangeBusy) return;
    this._rangeBusy = true;
    MonitData.range = s;
    render();
    this.mount();
    await MonitData.setRange(s);
    if(this._stack) {
      this._stack._autoScroll = true;
      this._stack._zoomMin = null;
      this._stack._zoomMax = null;
      const now = Date.now() / 1000;
      this._stack._xMin = now - s;
      this._stack._xMax = now;
      this._feedAll();
    }
    this._rangeBusy = false;
    render();
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