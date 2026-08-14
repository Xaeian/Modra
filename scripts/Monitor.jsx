// scripts/Monitor.jsx

// Chart pane glue. `_stack` and `_el` outlive renders because the chart
// canvas is expensive to rebuild; `Bar()` emits an empty `.rb-monitor-slot`
// and `mount()` reparents the persistent `_el` into it.

const Monitor = {

  _stack: null,       // ChartStack instance
  _el: null,          // <div class="rb-charts"> hosting the stack
  _keys: [],          // group keys aligned with _stack._entries
  _sig: null,         // built layout signature (keys + names per group)
  _rangeBusy: false,  // guards a window fetch against overlapping round-trips
  _zoomTimer: null,   // debounces drag-zoom into a single refetch

  //--------------------------------------------------------------------------------------- JSX bar

  // Returns null when nothing is monitored - upstream uses that as a hide signal.
  Bar() {
    if(!S.monitor.size) return null;
    const colors = chartTagColors();
    return (
      <div class="rb-monitor">
        <div class="rb-monitor-bar">
          {[...S.monitor].map(name => {
            const reg = Reg.byName(name);
            const c = colors[name];
            return (
              <span class="rb-monitor-tag" onClick={() => reg && toggleMonitor(reg)}>
                {c && <i class="rb-tag-dot" style={"background:" + c}></i>}
                {name} ✕
              </span>
            );
          })}
          <span class="rb-monitor-sep" />
          {chartRanges().map(r => (
            <button class={"rb-range-btn"
              + (MonitData.live && MonitData.range === r.s ? " active tier-" + MonitData.tier : "")
              + (Monitor._rangeBusy ? " busy" : "")}
              onClick={() => Monitor.changeRange(r.s)}
              disabled={Monitor._rangeBusy}
              title={MonitData.live && MonitData.range === r.s ? "tier: " + MonitData.tier : ""}
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

  //----------------------------------------------------------------------------- Mount / lifecycle

  // Class lookup: `Bar()` re-renders the slot, so no ref to it survives.
  mount() {
    const slot = document.querySelector(".rb-monitor-slot");
    if(!slot) return;
    if(!this._el) {
      this._el = document.createElement("div");
      this._el.className = "rb-charts";
    }
    slot.appendChild(this._el);
    this._stack?.syncRect();
  },

  // A frozen (zoomed) window sends no rows from poll, so ingest no-ops and
  // the view stays put.
  update(rows) {
    if(!S.monitor.size || !this._stack) return;
    // Rebuild BEFORE ingest. A rule-slot flip can drop a member while the key
    // stays, so compare key+names; otherwise the fed series count desyncs from
    // the panel and uPlot throws.
    if(this._groupSig() !== this._sig) {
      this.refresh();
      this.mount();
      return;
    }
    MonitData.ingest(rows);
    this._applyWindow();
    this._feedAll();
  },

  // Tear down + rebuild the stack from monitor membership. Preserves user zoom.
  refresh() {
    MonitData.sync();
    this._sig = this._groupSig();
    if(this._stack) {
      this._stack.destroy();
      this._stack = null;
    }
    this._keys = [];
    if(!S.monitor.size) {
      if(this._el) this._el.innerHTML = "";
      return;
    }
    if(!this._el) {
      this._el = document.createElement("div");
      this._el.className = "rb-charts";
    }
    this._el.innerHTML = "";
    const groups = MonitData.groups();
    this._stack = new ChartStack(this._el, {
      formatX: chartFmtAxisX(),
      formatXValue: chartFmtFull,
      onZoom: (a, b) => Monitor.onZoom(a, b),
    });
    for(const [key, grp] of Object.entries(groups)) {
      this._keys.push(key);
      this._stack.addPanel(this._panelCfg(key, grp));
    }
    this._stack.build();
    // Per-panel S/M/L cycle button; hung after `build()`, which creates the wrap.
    this._keys.forEach((key, i) => {
      const wrap = this._stack._entries[i]?.wrap;
      if(!wrap) return;
      const sz = S.chartSizes[key] || CHART_SIZE_DEFAULT;
      const btn = document.createElement("button");
      btn.className = "cs-size-btn";
      btn.textContent = sz;
      btn.onclick = () => {
        // Same fallback as `sz` above; a mismatch makes the first click
        // look like a no-op.
        const cur = S.chartSizes[key] || CHART_SIZE_DEFAULT;
        const idx = CHART_SIZE_CYCLE.indexOf(cur);
        S.chartSizes[key] = CHART_SIZE_CYCLE[(idx + 1) % CHART_SIZE_CYCLE.length];
        Monitor.refresh();
        Monitor.mount();
        saveMonitor();
      };
      wrap.appendChild(btn);
    });
    // Seed the axis so empty panels still render with a visible range.
    this._applyWindow();
    this._feedAll();
    this._stack.seedRange(this._stack._xMin, this._stack._xMax);
  },

  // Range button: a live window of length `s`, refetched at whatever tier fits.
  async changeRange(s) {
    MonitData.setRange(s);
    render();
    this.mount();
    await this.refetch();
    render();
    this.mount();
  },

  // Drag-zoom (a,b set) freezes the window and refetches at a finer tier;
  // double-click (a == null) returns to the live edge.
  onZoom(a, b) {
    if(a == null) MonitData.setRange(MonitData.range);
    else MonitData.setWindow(a, b);
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => { this.refetch(); render(); this.mount(); }, 150);
  },

  // Queries the DB directly, so it works with no device connected.
  async refetch() {
    if(this._rangeBusy) return;
    this._rangeBusy = true;
    const params = MonitData.fetchParams();
    if(params) {
      const res = await API.read(params);
      MonitData.ingest(res?.rows);
      if(res && "tier" in res) MonitData.tier = res.tier;
    }
    this._applyWindow();
    this._feedAll();
    this._rangeBusy = false;
  },

  // Monitor owns the window; the chart just renders it.
  _applyWindow() {
    if(!this._stack) return;
    const [xMin, xMax] = MonitData.window();
    this._stack._autoScroll = true;
    this._stack._zoomMin = null;
    this._stack._zoomMax = null;
    this._stack._xMin = xMin;
    this._stack._xMax = xMax;
  },

  exportCSV() {
    chartExportCSV([...S.monitor], MonitData._buf);
  },

  //------------------------------------------------------------------------------------- Internals

  // bool/enum keep `noTip`: the y-axis already spells out the state.
  _panelCfg(key, grp) {
    const cfg = {
      unit: grp.unit,
      // Full name: same-unit panels mix groups, so a short name is ambiguous.
      series: grp.names.map((name, i) => ({
        label: name,
        color: chartColor(grp.idx, i),
        stepped: grp.stepped,
      })),
    };
    if(grp.type === "bool") {
      cfg.yRange = [-0.2, 1.2];
      cfg.yFormat = v => v == null ? "-" : v >= 0.5 ? "ON" : "OFF";
      cfg.noTip = true;
    }
    else if(grp.type === "enum" && grp.enumLabels) {
      const keys = Object.keys(grp.enumLabels).map(Number);
      const lo = Math.min(...keys), hi = Math.max(...keys);
      const labels = grp.enumLabels;
      cfg.yRange = [lo - 0.5, hi + 0.5];
      cfg.yFormat = v => v == null ? "-" : (labels[Math.round(v)] ?? csFmtVal(v));
      cfg.noTip = true;
      // The enum's "unit" is its raw label map, not something to show.
      cfg.unit = "";
    }
    else if(grp.type === "bits" && grp.bitsLabels) {
      // A bitmask isn't legible from one y-position, so keep the shared tooltip.
      const labels = grp.bitsLabels;
      cfg.yFormat = v => (v == null || v < 0) ? "-" : bitsText(labels, Math.round(v));
    }
    const sz = CHART_SIZE_CYCLE.includes(S.chartSizes[key])
      ? S.chartSizes[key] : CHART_SIZE_DEFAULT;
    cfg.height = CHART_SIZES[sz];
    return cfg;
  },

  // Group key plus member names: a rule-slot flip can change members, not keys.
  _groupSig() {
    const groups = MonitData.groups();
    return Object.keys(groups).map(k => k + "=" + groups[k].names.join(",")).join("|");
  },

  _feedAll() {
    if(!this._stack) return;
    const groups = MonitData.groups();
    this._keys.forEach((key, i) => {
      const grp = groups[key];
      if(!grp) return;
      // Safety net: a series/panel count mismatch makes uPlot read past its
      // data array and throw. `update`'s signature check should have caught it.
      const panel = this._stack._panels[i];
      if(panel && grp.names.length !== panel.series.length) return;
      const data = MonitData.prepare(grp.names);
      if(data) this._stack.setData(i, data);
    });
  },
};
