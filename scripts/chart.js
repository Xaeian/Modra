// scripts/chart.js

// ChartStack: multi-panel uPlot wrapper. One uPlot per panel; cursor and
// x-zoom are shared through uPlot's sync key, so a drag on any panel zooms
// all of them.
//
// Usage:
//   const stack = new ChartStack(container, { formatX, formatXValue });
//   stack.addPanel({ unit, series: [{ label, color, stepped }] });
//   stack.build();
//   stack.setData(0, [tsArr, ...seriesArrs]);

//---------------------------------------------------------------------------------------- Defaults

const CS_DEFAULTS = {
  height: 160,
  xSize: 36,               // x-axis gutter (px)
  ySize: 50,               // y-axis gutter (px)
  yPad: 0.1,               // headroom above/below auto-range
  lineWidth: 1.5,
  padding: [12, 8, 4, 0],  // [top, right, bottom, left]
  font: "10px Roboto, sans-serif",
  axisStroke: "#999",
  gridStroke: "#eee",
  tickStroke: "#ccc",
};

//--------------------------------------------------------------------------------- Value formatter

// Fewer digits as magnitude grows: y-axis labels are narrow, but small
// values must keep their significance.
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

//------------------------------------------------------------------------------------ Color helper

function csDarken(hex, pct) {
  let c = hex.replace("#", "");
  if(c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c, 16);
  const f = 1 - pct / 100;
  const r = Math.round(((n >> 16) & 0xFF) * f);
  const g = Math.round(((n >> 8) & 0xFF) * f);
  const b = Math.round((n & 0xFF) * f);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Requires sorted input. Aligns tooltip readouts across panels whose
// sample rates differ.
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

// The x array carries synthetic points that break a line across a hole; they
// hold no values. A readout lands on the nearest index where some series has one.
function csRealIdx(data, idx) {
  const has = (i) => i >= 0 && i < data[0].length && data.some((s, k) => k > 0 && s[i] != null);
  for(const d of [0, -1, 1, -2, 2]) if(has(idx + d)) return idx + d;
  return null;
}

//---------------------------------------------------------------------------------- Tooltip plugin

// Hijacks uPlot's built-in legend as a floating tooltip. Styled inline so
// the plugin carries no stylesheet dependency.
//
// Visibility comes from the cursor alone: the panel that owns the pointer event
// shows the tooltip, a synced sibling does not, and no cursor means none.
// Hiding waits a frame, because a page rebuild under the pointer lets the
// browser report a leave and an enter in one go; acting on the leave at once
// would blink the tooltip at the render rate.
function csTipPlugin(stack) {
  let legend, over, hide = 0;
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
      },
      setCursor(u) {
        if(!legend || !over) return;
        const { left, top, idx } = u.cursor;
        const owner = u.cursor.event != null;
        if(!owner || idx == null || left < 0 || !u.data?.[0]?.length) {
          if(!hide) hide = requestAnimationFrame(() => {
            hide = 0;
            legend.style.display = "none";
            stack._hover(u, false);
          });
          return;
        }
        if(hide) { cancelAnimationFrame(hide); hide = 0; }
        stack._hover(u, true);
        legend.style.display = "";
        legend.innerHTML = stack._buildTipHTML(u, idx);
        const lw = legend.offsetWidth || 120;
        const lh = legend.offsetHeight || 40;
        const ow = over.clientWidth;
        const oh = over.clientHeight;
        const flipLeft = left + 16 + lw > ow;
        const x = flipLeft ? left - lw - 8 : left + 16;
        const y = Math.max(4, Math.min(top - 10, oh - lh - 4));
        legend.style.transform = "translate(" + x + "px," + y + "px)";
      },
    },
  };
}

//---------------------------------------------------------------------------- Bottom border plugin

// uPlot's default axes leave the plot bottom open - panels look detached without it.
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

//-------------------------------------------------------------------------------------- ChartStack

class ChartStack {

  // opts (over CS_DEFAULTS):
  //   syncKey - cursor/zoom sync key (auto-generated if omitted)
  //   formatX - x-axis tick formatter (bottom panel only)
  //   formatXValue - tooltip header formatter (full timestamp)
  //   onZoom - (min, max) on drag-zoom, (null, null) on dblclick reset
  //   onHover - (true) when a pointer settles on a panel, (false) when it leaves
  constructor(container, opts = {}) {
    this._el = container;
    this._cfg = { ...CS_DEFAULTS, ...opts };
    this._cfg.syncKey = opts.syncKey || ("cs_" + Math.random().toString(36).slice(2, 6));
    this._formatX = opts.formatX || null;
    this._formatXValue = opts.formatXValue || null;
    this._onZoom = opts.onZoom || null;
    this._onHover = opts.onHover || null;
    this.hovered = false;   // a pointer rests on one of the panels
    this._xMin = null;
    this._xMax = null;
    this._panels = [];
    this._entries = [];
    this._syncing = false;
    this._resetting = false;
    // Auto-scroll tracks the live right edge; a drag freezes the window at
    // `_zoomMin`/`_zoomMax` until dblclick resets.
    this._autoScroll = true;
    this._zoomMin = null;
    this._zoomMax = null;
  }

  //------------------------------------------------------------------------------------ Public API

  // Queue a panel config. Call before `build()`; ignored after.
  addPanel(cfg) {
    this._panels.push({
      unit: cfg.unit || "",
      series: cfg.series || [],
      height: cfg.height || this._cfg.height,
      yRange: cfg.yRange || null,
      yFormat: cfg.yFormat || null,
      noTip: cfg.noTip || false,
    });
  }

  // Idempotent: destroys and rebuilds every panel on re-call.
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

  // Gives empty panels a visible axis before real data arrives.
  seedRange(min, max) {
    for(let i = 0; i < this._entries.length; i++) {
      if(this._entries[i]?.plot?.data[0]?.length > 0) continue;
      const data = [[min, max]];
      for(let s = 0; s < this._panels[i].series.length; s++) data.push([null, null]);
      this.setData(i, data);
    }
  }

  // Used to follow live data on the right edge.
  setXRange(min, max) {
    this._xMin = min;
    this._xMax = max;
    this._syncing = true;
    for(const e of this._entries) {
      if(e?.plot) e.plot.setScale("x", { min, max });
    }
    this._syncing = false;
  }

  // uPlot caches the pointer-origin rect, refreshing only on resize, scroll
  // or mouseenter; the chart element is re-parented on every render.
  syncRect() {
    for(const e of this._entries) e?.plot?.syncRect?.(true);
  }

  // Wired to dblclick on any plot.
  resetZoom() {
    this._autoScroll = true;
    this._zoomMin = null;
    this._zoomMax = null;
    this._resetting = true;
    if(this._xMin != null) this.setXRange(this._xMin, this._xMax);
    // Clear on next frame so the setScale hook ignores our synthetic call.
    requestAnimationFrame(() => { this._resetting = false; });
    this._onZoom?.(null, null); // back to the live edge
  }

  destroy() {
    this._destroyAll();
    this._panels = [];
  }

  //------------------------------------------------------------------------------------- Internals

  // Hover is per stack: the panels share one cursor, so one pointer at a time.
  _hover(u, on) {
    if(on === this.hovered) return;
    this.hovered = on;
    this._onHover?.(on);
  }

  _currentRange() {
    if(!this._autoScroll && this._zoomMin != null) return [this._zoomMin, this._zoomMax];
    if(this._xMin != null) return [this._xMin, this._xMax];
    return [0, 1];
  }

  // One row per series across every panel, timestamps aligned to plot `u`.
  _buildTipHTML(u, idx) {
    idx = csRealIdx(u.data, idx);
    if(idx == null) return "";
    const ts = u.data[0][idx];
    let html = "<div class=\"cs-tip-ts\">"
      + (this._formatXValue ? this._formatXValue(ts) : String(ts))
      + "</div>";
    for(let p = 0; p < this._entries.length; p++) {
      const pe = this._entries[p];
      if(!pe?.plot?.data?.[0]?.length) continue;
      const panel = this._panels[p];
      if(panel.noTip) continue; // discrete bool/enum: state reads off the y-axis
      const pidx = (pe.plot === u) ? idx
        : csRealIdx(pe.plot.data, csClosestIdx(pe.plot.data[0], ts));
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

  // Only the bottom panel shows x ticks, so the stack reads as one chart.
  _buildOne(idx, isLast) {
    const panel = this._panels[idx];
    const cfg = this._cfg;
    const h = isLast ? panel.height + cfg.xSize : panel.height;

    const wrap = document.createElement("div");
    wrap.className = "cs-panel";

    // Darker than the series so the axis reads as owned by it, not a copy.
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
        // Page zoom scales the plot's bounding rect (the pointer origin) but not
        // its own width, so a raw pointer reads Z times too far along. Synced
        // sibling panels arrive already in plot px and carry no pointer event.
        move: (u, left, top) => {
          if(u.cursor.event == null) return [left, top];
          const z = parseFloat(document.body.style.zoom) || 1;
          return [left / z, top / z];
        },
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
          // Pad the auto-range so points never touch the panel edges.
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
          // `_syncing` / `_resetting` guard against feedback loops from our
          // own setScale calls.
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
          self._onZoom?.(min, max); // refetch this window at a finer tier
        }],
      },
      legend: { show: true, live: true },
    };

    const plot = new uPlot(opts, [[]], chartEl);
    plot.root.addEventListener("dblclick", () => self.resetZoom());

    // uPlot needs an explicit setSize on reflow; below 60px it isn't worth drawing.
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0].contentRect.width);
      if(w > 60) plot.setSize({ width: w, height: h });
    });
    ro.observe(wrap);
    this._entries[idx] = { plot, wrap, ro };
  }
}
