// scripts/chart.js

// ChartStack: synchronized multi-panel uPlot wrapper. Each panel is its own
// uPlot instance; cursor and x-zoom are shared via uPlot's sync key so
// dragging on any panel zooms all of them. Bottom panel owns the x-axis
// label; the rest hide their tick labels for a continuous look.
//
// Usage:
//   const stack = new ChartStack(container, { formatX, formatXValue });
//   stack.addPanel({ unit, series: [{ label, color, stepped }] });
//   stack.build();
//   stack.setData(0, [tsArr, ...seriesArrs]);

//---------------------------------------------------------- Defaults

const CS_DEFAULTS = {
  height: 160,
  xSize: 36,           // x-axis label gutter height (px)
  ySize: 50,           // y-axis label gutter width (px)
  yPad: 0.1,           // 10% headroom above/below auto-range
  lineWidth: 1.5,
  padding: [12, 8, 4, 0],   // uPlot canvas padding: [top, right, bottom, left]
  font: "10px Roboto, sans-serif",
  axisStroke: "#999",
  gridStroke: "#eee",
  tickStroke: "#ccc",
};

//---------------------------------------------------------- Value formatter

// Adaptive-precision number formatter sized for narrow y-axis labels while
// keeping significance for small values. Null/undefined → "-".
function csFmtVal(v) {
  if(v == null) return "-";
  const a = Math.abs(v);
  if(a === 0) return "0";
  if(a >= 10000) return (v / 1000).toFixed(1) + "k";
  if(a >= 100) return v.toFixed(1);
  if(a >= 1) return v.toFixed(2);
  if(a >= 0.01) return v.toFixed(3);
  if(a >= 0.001) return v.toFixed(4);
  if(a >= 0.0001) return v.toFixed(5);
  return v.toFixed(6);
}

//---------------------------------------------------------- Color helper

// Darken a hex color by N% lightness - used for the y-axis stroke so it
// reads as "owned by" the first series without matching it exactly.
function csDarken(hex, pct) {
  let c = hex.replace("#", "");
  if(c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c, 16);
  const f = 1 - pct / 100;
  const r = Math.round(((n >> 16) & 0xFF) * f);
  const g = Math.round(((n >>  8) & 0xFF) * f);
  const b = Math.round(( n        & 0xFF) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Binary search for the nearest index in a sorted timestamp array. Used
// to align tooltip readouts across panels with different sample rates.
function csClosestIdx(data0, ts) {
  if(!data0?.length) return null;
  let lo = 0, hi = data0.length - 1;
  while(lo < hi) {
    const mid = (lo + hi) >> 1;
    if(data0[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  if(lo > 0 && Math.abs(data0[lo - 1] - ts) < Math.abs(data0[lo] - ts)) lo--;
  return lo;
}

//---------------------------------------------------------- Tooltip plugin

// "legendAsTooltip" pattern: hijack uPlot's built-in legend as a floating
// tooltip that follows the cursor. Styled inline because uPlot creates the
// legend at init time and we'd rather not depend on the stylesheet.
function csTipPlugin(stack) {
  let legend, over, isHovered = false;
  return {
    hooks: {
      init(u) {
        legend = u.root.querySelector(".u-legend");
        if(!legend) return;
        over = u.over;
        legend.classList.remove("u-inline");
        Object.assign(legend.style, {
          textAlign: "left", pointerEvents: "none",
          display: "none", position: "absolute",
          left: "0", top: "0", zIndex: "100",
          background: "rgba(50,50,50,.92)", color: "#fff",
          border: "none", borderRadius: "3px",
          padding: "6px 10px", fontSize: "10px",
          fontFamily: "Roboto, sans-serif",
          boxShadow: "0 2px 8px rgba(0,0,0,.3)",
          whiteSpace: "nowrap", lineHeight: "1.6",
        });
        over.style.overflow = "visible";
        over.appendChild(legend);
        over.addEventListener("mouseenter", () => {
          isHovered = true;
          if(legend) legend.style.display = "";
        });
        over.addEventListener("mouseleave", () => {
          isHovered = false;
          if(legend) legend.style.display = "none";
        });
      },
      setCursor(u) {
        if(!legend || !over || !isHovered) return;
        const { left, top, idx } = u.cursor;
        if(idx == null || !u.data?.[0]?.length) {
          legend.style.display = "none";
          return;
        }
        legend.innerHTML = stack._buildTipHTML(u, idx);
        const lw = legend.offsetWidth || 120;
        const lh = legend.offsetHeight || 40;
        const ow = over.clientWidth;
        const oh = over.clientHeight;
        // Place the tooltip to the right of the cursor unless it would
        // overflow the plot; in that case flip to the left.
        const x = left + 16 + lw > ow ? left - lw - 8 : left + 16;
        const y = Math.max(4, Math.min(top - 10, oh - lh - 4));
        legend.style.transform = "translate(" + x + "px," + y + "px)";
      },
    },
  };
}

//---------------------------------------------------------- Bottom border plugin

// 1px line along the bottom of the plot area. uPlot's default axes don't
// draw one, so panels look detached without it.
function csBottomLine(cfg) {
  return {
    hooks: {
      draw(u) {
        const { left, top, width, height } = u.bbox;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = cfg.gridStroke;
        ctx.lineWidth = devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(left, top + height);
        ctx.lineTo(left + width, top + height);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}

//---------------------------------------------------------- ChartStack

class ChartStack {

  // opts (over CS_DEFAULTS):
  //   syncKey       - shared cursor/zoom key (auto-generated if omitted)
  //   formatX       - uPlot x-axis values formatter (bottom panel only)
  //   formatXValue  - tooltip header formatter (full timestamp)
  constructor(container, opts = {}) {
    this._el = container;
    this._cfg = { ...CS_DEFAULTS, ...opts };
    this._cfg.syncKey = opts.syncKey || ("cs_" + Math.random().toString(36).slice(2, 6));
    this._formatX = opts.formatX || null;
    this._formatXValue = opts.formatXValue || null;
    // Auto-scroll tracks the latest data on the right edge. A user drag
    // freezes the window at `_zoomMin/_zoomMax` until dblclick resets.
    this._xMin = null;
    this._xMax = null;
    this._panels = [];
    this._entries = [];
    this._syncing = false;
    this._resetting = false;
    this._autoScroll = true;
    this._zoomMin = null;
    this._zoomMax = null;
  }

  //---------------------------------------------------------- Public API

  // Queue a panel config. Call before `build()`; ignored after.
  addPanel(cfg) {
    this._panels.push({
      unit: cfg.unit || "",
      series: cfg.series || [],
      height: cfg.height || this._cfg.height,
      yRange: cfg.yRange || null,
      yFormat: cfg.yFormat || null,
    });
  }

  // Materialize all queued panels. Idempotent: destroys + rebuilds on re-call.
  build() {
    this._destroyAll();
    this._el.innerHTML = "";
    const n = this._panels.length;
    for(let i = 0; i < n; i++) this._buildOne(i, i === n - 1);
  }

  // Re-clamps the x-scale to whatever range is active (auto-scroll OR zoom).
  setData(idx, data) {
    const e = this._entries[idx];
    if(!e?.plot || !data) return;
    const [min, max] = this._currentRange();
    this._syncing = true;
    e.plot.batch(() => {
      e.plot.setData(data, false);
      e.plot.setScale("x", { min, max });
    });
    this._syncing = false;
  }

  // `[[min, max], [null, null], ...]` = "axis defined, series empty". Lets
  // empty panels render with a visible axis before real data arrives.
  seedRange(min, max) {
    for(let i = 0; i < this._entries.length; i++) {
      if(this._entries[i]?.plot?.data[0]?.length > 0) continue;
      const data = [[min, max]];
      for(let s = 0; s < this._panels[i].series.length; s++) data.push([null, null]);
      this.setData(i, data);
    }
  }

  // Override x-window on every panel atomically. Used to follow live data.
  setXRange(min, max) {
    this._xMin = min;
    this._xMax = max;
    this._syncing = true;
    for(const e of this._entries) {
      if(e?.plot) e.plot.setScale("x", { min, max });
    }
    this._syncing = false;
  }

  getXRange() { return [this._xMin, this._xMax]; }

  // Drop user zoom, return to auto-scroll. Triggered by dblclick on a plot.
  resetZoom() {
    this._autoScroll = true;
    this._zoomMin = null;
    this._zoomMax = null;
    this._resetting = true;
    if(this._xMin != null) this.setXRange(this._xMin, this._xMax);
    // Clear on next frame so the setScale hook ignores our synthetic call.
    requestAnimationFrame(() => { this._resetting = false; });
  }

  get length() { return this._panels.length; }
  get autoScroll() { return this._autoScroll; }

  destroy() {
    this._destroyAll();
    this._panels = [];
  }

  //---------------------------------------------------------- Internals

  _currentRange() {
    if(!this._autoScroll && this._zoomMin != null) return [this._zoomMin, this._zoomMax];
    if(this._xMin != null) return [this._xMin, this._xMax];
    return [0, 1];
  }

  // Tooltip HTML for cursor index `idx` on plot `u`. One row per series
  // across all panels; `csClosestIdx` aligns timestamps when sample rates
  // differ between panels.
  _buildTipHTML(u, idx) {
    const ts = u.data[0][idx];
    if(ts == null) return "";
    let html = "<div class=\"cs-tip-ts\">"
      + (this._formatXValue ? this._formatXValue(ts) : String(ts))
      + "</div>";
    for(let p = 0; p < this._entries.length; p++) {
      const pe = this._entries[p];
      if(!pe?.plot?.data?.[0]?.length) continue;
      const panel = this._panels[p];
      const pidx = (pe.plot === u) ? idx : csClosestIdx(pe.plot.data[0], ts);
      if(pidx == null) continue;
      for(let s = 0; s < panel.series.length; s++) {
        const val = pe.plot.data[s + 1]?.[pidx];
        html += "<div class=\"cs-tip-row\">"
          + "<i class=\"cs-tip-dot\" style=\"background:" + panel.series[s].color + "\"></i>"
          + "<span class=\"cs-tip-label\">" + panel.series[s].label + "</span>"
          + "<span class=\"cs-tip-val\">"
          + (panel.yFormat || csFmtVal)(val)
          + (panel.unit ? " " + panel.unit : "")
          + "</span></div>";
      }
    }
    return html;
  }

  _destroyAll() {
    for(const e of this._entries) {
      if(e.ro) e.ro.disconnect();
      if(e.plot) e.plot.destroy();
    }
    this._entries = [];
  }

  // `isLast` toggles the x-axis label gutter - only the bottom panel shows
  // ticks; the rest hide them so the stack reads as one continuous chart.
  _buildOne(idx, isLast) {
    const panel = this._panels[idx];
    const cfg = this._cfg;
    const h = isLast ? panel.height + cfg.xSize : panel.height;

    const wrap = document.createElement("div");
    wrap.className = "cs-panel";

    // Darker than the first series so it reads as "owned by" the panel
    // without matching the series color exactly.
    const yColor = panel.series.length
      ? csDarken(panel.series[0].color, 25)
      : cfg.axisStroke;

    if(panel.unit) {
      const lbl = document.createElement("span");
      lbl.className = "cs-unit";
      lbl.textContent = "[" + panel.unit + "]";
      lbl.style.color = csDarken(yColor, 15);
      lbl.style.left = (cfg.ySize + 5) + "px";
      wrap.appendChild(lbl);
    }

    const chartEl = document.createElement("div");
    chartEl.className = "cs-plot";
    wrap.appendChild(chartEl);
    this._el.appendChild(wrap);

    // First uPlot series is the x-axis itself (timestamps); zero-width
    // space label so the legend leads with the first real series.
    const series = [{ label: "​" }];
    for(const s of panel.series) {
      series.push({
        label: s.label,
        stroke: s.color,
        width: s.width || cfg.lineWidth,
        paths: s.stepped ? uPlot.paths.stepped({ align: 1 }) : undefined,
      });
    }

    const self = this;
    const opts = {
      width: wrap.clientWidth || 800,
      height: h,
      padding: cfg.padding,
      series,
      plugins: [csTipPlugin(this), csBottomLine(cfg)],
      cursor: {
        sync: { key: cfg.syncKey, setSeries: true, scales: ["x", null] },
        drag: { x: true, y: false, setScale: true },
        points: { size: 6, width: 1.5 },
      },
      axes: [
        {
          show: true,
          stroke: cfg.axisStroke,
          font: cfg.font,
          values: isLast
            ? (this._formatX || ((u, vals) => vals.map(v => String(v))))
            : (u, vals) => vals.map(() => ""),
          ticks: { show: isLast, stroke: cfg.tickStroke, width: 1, size: 5 },
          grid: { show: true, stroke: cfg.gridStroke, width: 1 },
          size: isLast ? cfg.xSize : 0,
          gap: 4,
        },
        {
          show: true,
          stroke: yColor,
          font: cfg.font,
          size: cfg.ySize,
          ticks: { show: true, stroke: cfg.tickStroke, width: 1, size: 4 },
          border: { show: true, stroke: yColor, width: 1 },
          grid: { show: true, stroke: cfg.gridStroke, width: 1 },
          gap: 2,
          values: (u, vals) => vals.map(panel.yFormat || csFmtVal),
        },
      ],
      scales: {
        x: { time: false },
        y: {
          auto: !panel.yRange,
          // Fixed yRange (bool/enum) wins; otherwise pad the auto-range
          // so points never touch the panel edges.
          range: panel.yRange
            ? () => panel.yRange
            : (u, dmin, dmax) => {
              if(dmin == null || dmax == null) return [0, 1];
              if(dmin === dmax) {
                const d = Math.abs(dmin) * cfg.yPad || 1;
                return [dmin - d, dmax + d];
              }
              const pad = (dmax - dmin) * cfg.yPad;
              return [dmin - pad, dmax + pad];
            },
        },
      },
      hooks: {
        setScale: [(u, key) => {
          // User drag-zoom: lock manual range, propagate to siblings.
          // `_syncing` / `_resetting` flags prevent feedback loops when
          // we're the one issuing the setScale call.
          if(key !== "x" || self._syncing || self._resetting) return;
          const { min, max } = u.scales.x;
          self._autoScroll = false;
          self._zoomMin = min;
          self._zoomMax = max;
          self._syncing = true;
          for(const e of self._entries) {
            if(e?.plot && e.plot !== u) e.plot.setScale("x", { min, max });
          }
          self._syncing = false;
        }],
      },
      legend: { show: true, live: true },
    };

    const plot = new uPlot(opts, [[]], chartEl);
    plot.root.addEventListener("dblclick", () => self.resetZoom());

    // Plots need explicit setSize when their container reflows. 60px is a
    // sanity floor; below that the chart isn't usefully visible.
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0].contentRect.width);
      if(w > 60) plot.setSize({ width: w, height: h });
    });
    ro.observe(wrap);
    this._entries[idx] = { plot, wrap, ro };
  }
}
