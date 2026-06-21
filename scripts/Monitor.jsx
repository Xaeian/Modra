// scripts/Monitor.jsx

// Chart pane glue. `_stack` and `_el` outlive renders because the chart
// canvas is expensive to rebuild; `Bar()` emits an empty `.rb-monitor-slot`
// and `mount()` reparents the persistent `_el` into it.

const Monitor = {

  _stack: null,        // ChartStack instance (persists across renders)
  _el: null,           // <div class="rb-charts"> hosting the stack
  _keys: [],           // group keys aligned with _stack._entries
  _sig: null,          // built layout signature (keys + names per group)
  _rangeBusy: false,   // guards a window fetch against overlapping round-trips
  _zoomTimer: null,    // debounces drag-zoom into a single refetch

  //---------------------------------------------------------- JSX bar

  // Tag row + range picker + export. Returns `null` when nothing is
  // monitored - upstream uses that as a hide signal.
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

  //---------------------------------------------------------- Mount / lifecycle

  // Class-based lookup is intentional: the slot is rendered by `Bar()` and
  // we don't have a direct ref to it after a re-render.
  mount() {
    const slot = document.querySelector(".rb-monitor-slot");
    if(!slot) return;
    if(!this._el) {
      this._el = document.createElement("div");
      this._el.className = "rb-charts";
    }
    slot.appendChild(this._el);
  },

  // Live poll: replace the buffer with the freshly fetched window and redraw.
  // A frozen (zoomed) window sends no rows from poll, so ingest no-ops and the
  // view stays put.
  update(rows) {
    if(!S.monitor.size || !this._stack) return;
    // Rebuild on a layout change BEFORE ingest. A rule slot flip can leave a
    // same-unit co-member behind (a group keeps its key but loses a member),
    // so compare the full key+names signature, not just keys, or the fed
    // series count desyncs from the panel and uPlot throws.
    if(this._groupSig() !== this._sig) {
      this.refresh();
      this.mount();
      return;
    }
    MonitData.ingest(rows);
    this._applyWindow();
    this._feedAll();
  },

  // Tear down + rebuild the stack from current monitor membership. Used on
  // trace toggle, panel size change, and boot. Preserves user zoom.
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
      const panelCfg = {
        unit: grp.unit,
        series: grp.names.map((name, i) => ({
          label: name.includes(":") ? name.split(":").pop() : name,
          color: chartColor(grp.idx, i),
          stepped: grp.stepped,
        })),
      };
      // Discrete y-axes: bool snaps to ON/OFF, enum maps integers back to
      // labels so the axis reads as states, not numbers.
      if(grp.type === "bool") {
        panelCfg.yRange = [-0.2, 1.2];
        panelCfg.yFormat = v => v == null ? "-" : v >= 0.5 ? "ON" : "OFF";
      }
      else if(grp.type === "enum" && grp.enumLabels) {
        const keys = Object.keys(grp.enumLabels).map(Number);
        const lo = Math.min(...keys), hi = Math.max(...keys);
        panelCfg.yRange = [lo - 0.5, hi + 0.5];
        const labels = grp.enumLabels;
        panelCfg.yFormat = v => v == null ? "-" : (labels[Math.round(v)] ?? csFmtVal(v));
      }
      const sz = CHART_SIZE_CYCLE.includes(S.chartSizes[key]) ? S.chartSizes[key] : CHART_SIZE_DEFAULT;
      panelCfg.height = CHART_SIZES[sz];
      this._stack.addPanel(panelCfg);
    }
    this._stack.build();
    // Per-panel S/M/L cycle button. Must be hung after `build()` because
    // it needs the panel wrap to exist.
    this._keys.forEach((key, i) => {
      const wrap = this._stack._entries[i]?.wrap;
      if(!wrap) return;
      const sz = S.chartSizes[key] || CHART_SIZE_DEFAULT;
      const btn = document.createElement("button");
      btn.className = "cs-size-btn";
      btn.textContent = sz;
      btn.onclick = () => {
        // Must use the same fallback as `sz` above; a mismatch makes the
        // first click look like a no-op (the internal advance lands on
        // the size the label was already showing).
        const cur = S.chartSizes[key] || CHART_SIZE_DEFAULT;
        const idx = CHART_SIZE_CYCLE.indexOf(cur);
        S.chartSizes[key] = CHART_SIZE_CYCLE[(idx + 1) % CHART_SIZE_CYCLE.length];
        Monitor.refresh();
        Monitor.mount();
        saveMonitor();
      };
      wrap.appendChild(btn);
    });
    // Pin to the current window (live edge or frozen zoom) and feed; seed the
    // axis so empty panels still render with a visible range.
    this._applyWindow();
    this._feedAll();
    this._stack.seedRange(this._stack._xMin, this._stack._xMax);
  },

  // Range button: a live window of length `s`, refetched at whatever tier fits.
  async changeRange(s) {
    MonitData.setRange(s);
    render();
    this.mount();
    await this._refetch();
    render();
    this.mount();
  },

  // Drag-zoom (a,b set) freezes the window and refetches it at a finer tier;
  // double-click (a == null) returns to the live edge. Debounced so one drag
  // gesture fires one fetch.
  onZoom(a, b) {
    if(a == null) MonitData.setRange(MonitData.range);
    else MonitData.setWindow(a, b);
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => { this._refetch(); render(); this.mount(); }, 150);
  },

  // Fetch the current window and redraw. Shared by range buttons and zoom;
  // `_rangeBusy` shields against overlapping round-trips.
  async _refetch() {
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

  // Pin the stack x-scale to the current data window (live edge or frozen
  // zoom). Monitor owns the window; the chart just renders it.
  _applyWindow() {
    if(!this._stack) return;
    const [xMin, xMax] = MonitData.window();
    this._stack._autoScroll = true;
    this._stack._zoomMin = null;
    this._stack._zoomMax = null;
    this._stack._xMin = xMin;
    this._stack._xMax = xMax;
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

  //---------------------------------------------------------- Internals

  // Layout signature: each group key plus its member names. A rule-slot flip
  // can change a group's members while its key stays, so comparing this (not
  // keys alone) catches layouts that need a rebuild before the data desyncs.
  _groupSig() {
    const groups = MonitData.groups();
    return Object.keys(groups).map(k => k + "=" + groups[k].names.join(",")).join("|");
  },

  // Push each group's prepared data into its stack panel.
  _feedAll() {
    if(!this._stack) return;
    const groups = MonitData.groups();
    this._keys.forEach((key, i) => {
      const grp = groups[key];
      if(!grp) return;
      // Safety net: a series count != the panel's makes uPlot read past its
      // data array and throw. `update`'s signature check handles real layout
      // changes; this just refuses to crash if one ever slips through.
      const panel = this._stack._panels[i];
      if(panel && grp.names.length !== panel.series.length) return;
      const data = MonitData.prepare(grp.names);
      if(data) this._stack.setData(i, data);
    });
  },
};
