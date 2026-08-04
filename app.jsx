// app.jsx

// Top-level render driver. Decides when `render()` calls actually hit the
// DOM and preserves transient browser state (drags, <select> dropdowns,
// search focus) across full rebuilds.

//---------------------------------------------------------- Render guard

let root = null;
let _renderPending = false;
let _gesture = false;
let _rendering = false;

// True while render() is swapping the DOM. Blur handlers use this to tell a
// mechanical blur (the focused field is being replaced by the rebuild) from
// the user actually leaving a field.
function isRendering() { return _rendering; }

// Mid-gesture renders tear sliders / selects out from under the user.
// Defer until the gesture ends.
let _flushTimer = null;

function _flush() {
  if(_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _gesture = false;
  if(_renderPending) render();
}
// A gesture owns the DOM from `pointerdown` until its `click` has bubbled:
// a render inside that window replaces the pressed element and the `click`,
// aimed at the old node, lands on a detached tree - the press is lost.
// Clickless gestures (drags, scrollbars) fall through to the timer, sized
// past the `pointerup`→`click` gap.
document.addEventListener("pointerdown", () => { _gesture = true; });
document.addEventListener("pointerup", () => {
  _flushTimer = setTimeout(_flush, 80);
});
// Bubbles after the target button's own `onClick`, so the handler already ran
// on the intact DOM. Also covers keyboard Enter (synthetic click, no pointer).
document.addEventListener("click", _flush);
// Safety nets: a `pointerdown` with no `pointerup` (browser steals the
// gesture, user Alt+Tabs mid-drag) would otherwise leave the flag stuck.
document.addEventListener("pointercancel", _flush);
window.addEventListener("blur", _flush);
// Focus leaving a text input releases the typing lock; land anything parked
// once the browser settles focus on the next element.
document.addEventListener("focusout", () => {
  if(_renderPending) setTimeout(() => { if(_renderPending) render(); }, 0);
});
// Column count tracks viewport width; re-render (debounced) on resize.
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if(!isUserEditing()) render(); }, 150);
});

//---------------------------------------------------------- render()

function render() {
  // Re-entrant call: replaceChild detaching the focused field fires its blur
  // synchronously, and a render() from that handler would swap `root` out
  // from under the in-flight replaceChild (NotFoundError, focus lost).
  // Park it; the pending-flush machinery lands it after this pass.
  if(_rendering) {
    _renderPending = true;
    return;
  }
  const active = document.activeElement;
  // A caret in a text input is never disturbed by arriving data: async
  // renders (no `window.event`) park until the field blurs or a user
  // action renders. User-event renders proceed and restore focus below.
  if(_gesture || active?.tagName === "SELECT"
    || (active?.tagName === "INPUT" && active.type === "text" && !window.event)) {
    _renderPending = true;
    return;
  }
  _renderPending = false;
  // Rebuild parks focus on <body>; restore it - the search box, the addr box,
  // or a register field with caret and text.
  const wasSearch = active?.classList.contains("rb-search");
  const wasAddr = active?.classList.contains("rb-addr");
  const regFocus = active?.classList.contains("rb-val") ? active.dataset.reg : null;
  const regSel = (wasAddr || regFocus) ? [active.selectionStart, active.selectionEnd] : null;
  const regText = regFocus ? active.value : null;
  _rendering = true;
  try {
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
    else if(wasAddr || regFocus) {
      const f = wasAddr ? root.querySelector(".rb-addr") : valInput(regFocus);
      if(f && !f.disabled) {
        f.focus();
        // Keep the mid-edit text while it still parses to the staged value -
        // the canonical re-render reformats ("12." -> "12") under the caret.
        // Once the edit is reset or replaced underneath, canonical wins.
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

//---------------------------------------------------------- Boot

// `skipPrompt` is the Continue button: the map question was just answered.
async function boot(skipPrompt = false) {
  // Independent reads run in parallel. Empty shell on failure so the toolbar
  // and alerts stay usable.
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
  // Asked on every start so a map can be updated without touching files, and
  // unconditionally when there is none. A pick reloads the page, so it carries
  // its own skip across that reload.
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

  // Restore UI state from view.json. Stale monitor traces (regs.csv changed)
  // drop silently; ignored names are accepted verbatim - we don't validate
  // against the current catalog so a temporarily-removed register can come
  // back ignored.
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
          const reg = Reg.byName(name);
          if(reg) groupKey = chartGroupKey(reg);
        }
      }
      if(groupKey) S.chartSizes[groupKey] = size;
    }
    if(S.monitor.size) S.showChart = true;
  }

  // Needs the catalog: a widget only counts as available once its `match()`
  // has seen the register map.
  restoreWidgets();

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
  // Refresh now that it's on screen, then backfill the window from the
  // store - history must show even when no device is connected.
  if(S.monitor.size) {
    Monitor.refresh();
    Monitor.mount();
    Monitor.refetch();
  }
}

boot();
