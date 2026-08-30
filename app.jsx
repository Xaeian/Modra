// app.jsx

// Top-level render driver. Decides when `render()` calls actually hit the
// DOM and preserves transient browser state (drags, <select> dropdowns,
// search focus) across full rebuilds.

//------------------------------------------------------------------------------------ Render guard

let root = null;
let _renderPending = false;
let _gesture = false;
let _rendering = false;

// Blur handlers use this to tell a mechanical blur (the field is being
// replaced by the rebuild) from the user leaving a field.
function isRendering() { return _rendering; }

let _flushTimer = null;

function _flush() {
  if(_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _gesture = false;
  if(_renderPending) render();
}
// A render between `pointerdown` and `click` tears sliders / selects out from
// under the user, and replaces the pressed element so the `click` lands on a
// detached tree. Clickless gestures (drags, scrollbars) fall through to the
// timer, sized past the `pointerup`→`click` gap.
document.addEventListener("pointerdown", () => { _gesture = true; });
document.addEventListener("pointerup", () => {
  _flushTimer = setTimeout(_flush, 80);
});
// Bubbles after the target button's own `onClick`, so the handler already ran
// on the intact DOM. Also covers keyboard Enter (synthetic click, no pointer).
document.addEventListener("click", _flush);
// A `pointerdown` with no `pointerup` (Alt+Tab mid-drag) leaves the flag stuck.
document.addEventListener("pointercancel", _flush);
window.addEventListener("blur", _flush);
// Leaving a text input releases the typing lock; defer so focus settles first.
document.addEventListener("focusout", () => {
  if(_renderPending) setTimeout(() => { if(_renderPending) render(); }, 0);
});
// Collapsing a selection releases the copy lock. Needed beside `click`, because
// deselecting with a key (arrow, Escape) sends no pointer event at all.
document.addEventListener("selectionchange", () => {
  if(_renderPending && !_selecting()) render();
});
// Column count tracks viewport width.
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if(!isUserEditing()) render(); }, 150);
});

//---------------------------------------------------------------------------------------- render()

// Text under selection, still attached. A rebuild would replace those very
// nodes and drop the selection halfway through a copy, so an arriving poll has
// to wait. A range left over detached nodes is stale and parks nothing.
//
// Bounded, and that bound is the important part. A selection can stand for as
// long as nobody clears it: left inside a field, or forgotten after a drag. An
// unbounded wait then stops every render in the app, so the window looks frozen
// while it is merely being polite. Long enough to reach Ctrl+C, short enough
// that nothing can wedge behind it.
const SELECT_HOLD_MS = 4000;
let _selectSince = 0;

function _selecting() {
  const sel = window.getSelection();
  if(!sel || sel.isCollapsed || !sel.anchorNode?.isConnected) {
    _selectSince = 0;
    return false;
  }
  if(!_selectSince) _selectSince = Date.now();
  return Date.now() - _selectSince < SELECT_HOLD_MS;
}

function render() {
  // Re-entrant call: replaceChild detaching the focused field fires blur
  // synchronously, and a render() from that handler would swap `root` out
  // mid-replaceChild (NotFoundError, focus lost). Park it for the flush.
  if(_rendering) {
    _renderPending = true;
    return;
  }
  const active = document.activeElement;
  // A caret in a text input is never disturbed by arriving data: async
  // renders (no `window.event`) park until the field blurs or a user acts.
  if(_gesture || _selecting() || active?.tagName === "SELECT"
    || (active?.tagName === "INPUT" && active.type === "text" && !window.event)) {
    _renderPending = true;
    return;
  }
  _renderPending = false;
  // Rebuild parks focus on <body>; capture enough to restore it.
  const wasSearch = active?.classList.contains("rb-search");
  const wasAddr = active?.classList.contains("rb-addr");
  const regFocus = active?.classList.contains("rb-val") ? active.dataset.reg : null;
  const regSel = (wasAddr || regFocus) ? [active.selectionStart, active.selectionEnd] : null;
  const regText = regFocus ? active.value : null;
  _rendering = true;
  try {
    const el = <App />;
    // `root` may be detached out-of-band (a deferred render races a handler
    // that reparents body, an extension wipes the tree); `replaceChild` would
    // then throw NotFoundError.
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
    else if(wasAddr || regFocus) {
      const f = wasAddr ? root.querySelector(".rb-addr") : valInput(regFocus);
      if(f && !f.disabled) {
        f.focus();
        // Keep the mid-edit text while it still parses to the staged value -
        // the canonical re-render reformats ("12." -> "12") under the caret.
        if(regFocus) {
          const reg = Reg.byName(regFocus);
          const staged = regFocus in S.dirty ? S.dirty[regFocus] : S.values[regFocus];
          if(reg && f.value !== regText && Reg.same(Reg.parse(reg, regText), staged))
            f.value = regText;
        }
        f.setSelectionRange(regSel[0], regSel[1]);
      }
    }
  }
  finally { _rendering = false; }
}

//-------------------------------------------------------------------------------------------- Boot

// `skipPrompt` is the Continue button: the map question was just answered.
async function boot(skipPrompt = false) {
  // Empty shell on failure so the toolbar and alerts stay usable.
  const [scan, regs, serial, view] = await Promise.all([
    API.scan(), API.info(), API.serial(), API.view_get(),
  ]);
  if(!scan || !regs) {
    document.body.classList.add("app");
    render();
    alert.err("Backend unavailable", 0);
    startPortScan();
    return;
  }

  S.askMap = view?.ask_map !== false;
  // Asked every start so the map can be swapped without touching files. A pick
  // reloads the page, so it carries its own skip across the reload.
  let skip = skipPrompt;
  try {
    if(sessionStorage.getItem(MAP_PICKED)) { sessionStorage.removeItem(MAP_PICKED); skip = true; }
  } catch(e) { /* storage disabled */ }
  if(!regs.length || (S.askMap && !skip)) {
    S.regs = regs;
    S.mapPrompt = true;
    document.body.classList.add("app");
    render();
    return;
  }
  S.mapPrompt = false;

  S.regs = regs;
  S.serial = serial;
  regs.forEach(r => { S.values[r.name] = null; });

  // Stale monitor traces (regs.csv changed) drop silently; ignored names are
  // taken verbatim so a temporarily-removed register comes back still ignored.
  if(view && typeof view === "object") {
    if(Array.isArray(view.ignore)) S.ignore = expandIgnore(view.ignore);
    for(const panel of (view.monitor || [])) {
      const traces = Array.isArray(panel.traces) ? panel.traces : [];
      const size = CHART_SIZE_CYCLE.includes(panel.size) ? panel.size : CHART_SIZE_DEFAULT;
      // Panel size is keyed by group; take the key from the first surviving trace.
      let groupKey = null;
      for(const name of traces) {
        const reg = Reg.byName(name);
        if(!reg || !Reg.isTelemetry(reg)) continue;
        S.monitor.add(name);
        if(!groupKey) groupKey = chartGroupKey(reg);
      }
      if(groupKey) S.chartSizes[groupKey] = size;
    }
    if(S.monitor.size) S.showChart = true;
  }

  // Needs the catalog: a widget only counts as available once its `match()`
  // has seen the register map.
  restoreWidgets();

  applyStatus(scan);
  // Seed toolbar inputs from the backend: serial.ini, or the live connection.
  S.portInput = S.port || serial.port || "";
  S.addrInput = S.addr ? String(S.addr) : (serial.addr ? String(serial.addr) : "");

  if(S.connected) startPoll();
  startPortScan();
  document.body.classList.add("app");
  render();

  // The container had no measurable size while the chart was hidden. Backfill
  // from the store too - history must show with no device connected.
  if(S.monitor.size) {
    Monitor.refresh();
    Monitor.mount();
    Monitor.refetch();
  }
}

boot();
