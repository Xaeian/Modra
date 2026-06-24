// app.jsx

// Top-level render driver. Decides when `render()` calls actually hit the
// DOM and preserves transient browser state (drags, <select> dropdowns,
// search focus) across full rebuilds.

//---------------------------------------------------------- Render guard

let root = null;
let _renderPending = false;
let _pointerDown = false;

// Mid-gesture renders tear sliders / selects out from under the user.
// Defer until the gesture ends.
let _flushTimer = null;

function _flush() {
  if(_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _pointerDown = false;
  if(_renderPending) render();
}
document.addEventListener("pointerdown", () => { _pointerDown = true; });
// When an input loses focus to a button, its `onBlur` commit queues a
// deferred render. Flushing it here on `pointerup` would rebuild the DOM and
// replace the button *before* its `click` arrives, so the first click only
// commits the input and the button needs a second click. Instead defer the
// flush by a macrotask: the `click` fires synchronously right after
// `pointerup`, runs the button's handler on the still-intact DOM, and flushes
// via the `click` listener below. Only a gesture with no trailing click
// (a drag, a slider release) falls through to the timer.
document.addEventListener("pointerup", () => {
  _pointerDown = false;
  _flushTimer = setTimeout(_flush, 0);
});
// Bubbles after the target button's own `onClick`, so the handler already ran
// on the intact DOM. Also covers keyboard Enter (synthetic click, no pointer).
document.addEventListener("click", _flush);
// Safety nets: a `pointerdown` with no `pointerup` (browser steals the
// gesture, user Alt+Tabs mid-drag) would otherwise leave the flag stuck.
document.addEventListener("pointercancel", _flush);
window.addEventListener("blur", _flush);
// Column count tracks viewport width; re-render (debounced) on resize.
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if(!isUserEditing()) render(); }, 150);
});

//---------------------------------------------------------- render()

function render() {
  if(_pointerDown || document.activeElement?.tagName === "SELECT") {
    _renderPending = true;
    return;
  }
  _renderPending = false;
  // Rebuild parks focus on <body>; restore it on the search input if that's
  // where the user was typing.
  const wasSearch = document.activeElement?.classList.contains("rb-search");
  const el = <App />;
  // `root` may be detached out-of-band: a deferred render races with an
  // async handler that reparents body, or an extension wipes the tree.
  // `replaceChild` then throws NotFoundError. Check parentage and fall
  // back to a plain append so render never hard-fails.
  if(root?.parentNode === document.body) {
    document.body.replaceChild(el, root);
  } else {
    if(root?.parentNode) root.parentNode.removeChild(root);
    document.body.appendChild(el);
  }
  root = el;
  Monitor.mount();
  if(wasSearch) {
    const s = root.querySelector(".rb-search");
    if(s) {
      s.focus();
      s.selectionStart = s.selectionEnd = S.query.length;
    }
  }
}

//---------------------------------------------------------- Boot

(async () => {
  // Independent reads run in parallel. Empty shell on failure so the toolbar
  // and alerts stay usable.
  const [scan, regs, serial] = await Promise.all([
    API.scan(), API.info(), API.serial(),
  ]);
  if(!scan || !regs) {
    document.body.classList.add("app");
    render();
    alert.err("Backend unavailable", 0);
    startPortScan();
    return;
  }

  S.regs = regs;
  S.serial = serial;
  regs.forEach(r => { S.values[r.name] = null; });

  // Restore UI state from view.json. Stale monitor traces (regs.csv changed)
  // drop silently; ignored names are accepted verbatim - we don't validate
  // against the current catalog so a temporarily-removed register can come
  // back ignored.
  const view = await API.view_get();
  if(view && typeof view === "object") {
    if(Array.isArray(view.ignore)) {
      for(const n of view.ignore) S.ignore.add(String(n));
    }
    const known = new Set(regs.map(r => r.name));
    for(const panel of (view.monitor || [])) {
      const traces = Array.isArray(panel.traces) ? panel.traces : [];
      const size = CHART_SIZE_CYCLE.includes(panel.size) ? panel.size : CHART_SIZE_DEFAULT;
      // Panel size is keyed by group, so pick the key from the first
      // surviving trace.
      let groupKey = null;
      for(const name of traces) {
        if(!known.has(name)) continue;
        S.monitor.add(name);
        if(!groupKey) {
          const reg = regs.find(r => r.name === name);
          if(reg) groupKey = chartGroupKey(reg);
        }
      }
      if(groupKey) S.chartSizes[groupKey] = size;
    }
    if(S.monitor.size) S.showChart = true;
  }

  applyStatus(scan);
  // Seed toolbar inputs from whatever the backend reports - values it
  // persisted in serial.ini, or the current live connection.
  S.portInput = S.port || serial.port || "";
  S.addrInput = S.addr ? String(S.addr) : (serial.addr ? String(serial.addr) : "");

  if(S.connected) startPoll();
  startPortScan();
  document.body.classList.add("app");
  render();

  // Chart wasn't visible before, so its container had no measurable size.
  // Refresh now that it's on screen.
  if(S.monitor.size) {
    Monitor.refresh();
    Monitor.mount();
  }
})();
