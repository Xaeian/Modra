// scripts/sys/widgets.js

// Registry of device widgets - per-family panels for what the register grid cannot
// show. Frontend only; the host component lives in App.jsx. Two gates, both must pass:
// the `widgets` list in app.ini and the widget's own `match(regs)`.
//
// Also the seam a widget drives the rest of the app through. A widget knows one
// device deeply and modra knows none, so the useful split is: the widget says
// WHICH registers matter now, modra decides how to show them. Everything a
// widget is meant to reach for lives in this file, so a widget never has to
// learn how the grid filters or how the chart is mounted.
//
// JSX-free on purpose: the dev server serves `.js` verbatim, only `.jsx` gets Babel.

// Quoted: an undefined app.ini var expands to the empty string, which must parse.
const WIDGETS_ENABLED = "{{widgets}}";

const Widgets = (() => {

  const _all = [];
  const _allow = new Set(WIDGETS_ENABLED.split(",").map(s => s.trim()).filter(Boolean));

  // The bundler puts every `.js` before every `.jsx`, so this registry exists before
  // widgets self-register. An unlisted widget is dropped here: it ships, but stays inert.
  function register(widget) {
    if(!widget?.id || !_allow.has(widget.id)) return;
    if(_all.some(w => w.id === widget.id)) {
      console.warn("Widget already registered:", widget.id);
      return;
    }
    _all.push(widget);
  }

  // Cached on the catalog reference: the backend builds it once. A throwing `match`
  // disqualifies the widget instead of breaking render.
  let _active = null, _activeSrc = null;
  function active() {
    if(_activeSrc !== S.regs) {
      _activeSrc = S.regs;
      _active = [];
      for(const w of _all) {
        try { if(w.match(S.regs)) _active.push(w); }
        catch(e) { console.warn("Widget match failed:", w.id, e); }
      }
    }
    return _active;
  }

  // Open panels only; `active()` stays the full list, because the toolbar has to
  // offer a switch for a widget precisely when that widget is closed. A widget
  // that reads alongside the grid asks for `beside` and then stays in view while
  // the grid scrolls, which is the whole point: what it highlights has to be
  // visible at the same time as what it says.
  const shown = () => active().filter(w => S.widgetsOn.has(w.id));
  const beside = () => shown().filter(w => w.beside);
  const over = () => shown().filter(w => !w.beside);

  //------------------------------------------------------------------------------- Driving the app

  // The operator's own view, captured on the first call and handed back by
  // `release()`. Written through to storage as well: closing the app while a
  // widget still holds the view would otherwise make the widget's version
  // theirs, and there would be nothing left to restore.
  const WAS_KEY = "modra.widgets.was";
  let _was = null;
  try { _was = JSON.parse(localStorage.getItem(WAS_KEY)) || null; }
  catch(e) { /* first run, or storage refused */ }

  const _keep = () => {
    if(_was) return;
    _was = { query: S.query, strict: S.searchStrict, monitor: [...S.monitor],
      chart: S.showChart, ignore: [...S.ignore], sizes: { ...S.chartSizes } };
    try { localStorage.setItem(WAS_KEY, JSON.stringify(_was)); }
    catch(e) { /* the session still restores it */ }
  };
  const _drop = () => {
    _was = null;
    try { localStorage.removeItem(WAS_KEY); } catch(e) { /* nothing to drop */ }
  };
  const _same = (a, b) => a.length === b.length && a.every(n => b.includes(n));

  // The chart is one persistent element reparented into a freshly rendered host:
  // the first mount builds that host, the second reattaches after the stack
  // rebuilds, and the refetch backfills traces that were not there before.
  const _remount = () => {
    Monitor.mount();
    Monitor.refresh();
    Monitor.mount();
    Monitor.refetch();
  };

  // Highlight these registers in the grid. The query is the same one the search
  // box takes, so `|` joins alternatives; strict mode is forced because a
  // widget's list is written as exact names, not as something to guess at.
  function focus(query) {
    _keep();
    if(!S.searchStrict) toggleSearchStrict();
    search(query || "");
  }

  // Chart exactly these registers and nothing else. `big` names the few that
  // earn a taller panel; everything else gets the small one, so a screenful of
  // traces stays a screenful.
  //
  // An ignored register is never polled, so charting one would draw a flat line
  // and quietly lie; the ignore is lifted for anything asked for here. A widget
  // asking to plot is asking to be watched, so the chart opens too.
  function plot(names, big) {
    _keep();
    const want = (names || []).filter(n => Reg.byName(n));
    for(const name of want) {
      if(S.ignore.has(name)) toggleIgnore(Reg.byName(name));
    }
    S.monitor.clear();
    for(const name of want) S.monitor.add(name);
    S.showChart = want.length > 0;
    // Panels group by unit, so importance is declared per register and lands on
    // whichever panel that register ends up in.
    const tall = new Set((big || []).filter(n => Reg.byName(n))
      .map(n => chartGroupKey(Reg.byName(n))));
    for(const key of Object.keys(MonitData.groups())) {
      S.chartSizes[key] = tall.has(key) ? "M" : "S";
    }
    saveMonitor();
    render();
    _remount();
  }

  // One widget asking another for something.
  //
  // Panels are separate on purpose, so they do not reach into each other: a
  // message names the widget it is for and says what it wants, and a widget
  // that is not shipped, not enabled or not interested simply does not answer.
  // The sender learns whether anyone did, and is expected to carry on either
  // way - a panel the operator turned off is not an error.
  function tell(id, msg) {
    const w = active().find(x => x.id === id);
    if(!w?.receive) return false;
    try { return w.receive(msg) !== false; }
    catch(e) {
      console.warn("Widget message failed:", id, e);
      return false;
    }
  }

  // Mark one register in the grid: a static highlight, held for as long as a
  // name is pointed at. Nothing is written, so nothing needs undoing.
  //
  // A pin outlives the pointing. `reveal` scrolls the grid to a row, and the
  // pointer necessarily leaves the text on the way there, so without a pin the
  // mark would go out exactly when it was finally worth looking at.
  let _pin = null;

  function point(name) {
    const next = name || _pin;
    if(S.pointed === next) return;
    S.pointed = next;
    render();
  }

  // Take the grid to a register and leave it marked. Calling it on the row
  // already pinned lets go again, so the same click both fetches and releases.
  function reveal(name) {
    _pin = _pin === name ? null : name;
    point(name);
    if(!_pin) return;
    const row = document.querySelector(`.rb-reg[data-reg="${CSS.escape(name)}"]`);
    if(row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Take these out of the poll cycle: plain names or globs, added to whatever
  // the operator already ignores. `spare` wins over all of it.
  //
  // Additive on purpose. Keeping only a declared list would silence every
  // register the widget did not think of, and a grid row that quietly stopped
  // updating is worse than a slow cycle. What belongs here is what takes no
  // part in tuning at all - a journal, a counter, a serial-port setting - and
  // that set is the widget's to name, because only it knows the device.
  //
  // `spare` is how a widget keeps its own word. A register it points at, names
  // in an instruction or draws must keep arriving, whether a pattern here
  // happens to cover it or the operator had ignored it earlier. Telling someone
  // to watch a number and freezing it in the same breath is the one outcome
  // this seam must not produce.
  function mute(patterns, spare) {
    _keep();
    const add = new Set(S.ignore);
    for(const p of patterns || []) {
      if(!/[*?]/.test(p)) { if(Reg.byName(p)) add.add(p); continue; }
      const re = new RegExp("^" + globSource(p) + "$");
      for(const reg of S.regs) if(re.test(reg.name)) add.add(reg.name);
    }
    for(const name of spare || []) add.delete(name);
    if(add.size !== S.ignore.size
      || [...add].some(n => !S.ignore.has(n))) setIgnore([...add]);
  }

  // Put back what the operator had: their filter, their charts, their ignore
  // list. Anything they changed in the meantime is theirs and stays, so this
  // hands back only what it still owns.
  function release() {
    if(!_was) return;
    const was = _was;
    _drop();
    _pin = null;
    point(null);
    if(S.searchStrict !== was.strict) toggleSearchStrict();
    search(was.query || "");
    if(!_same([...S.ignore], was.ignore)) setIgnore(was.ignore);
    if(!_same([...S.monitor], was.monitor)) {
      S.monitor.clear();
      for(const name of was.monitor) S.monitor.add(name);
      saveMonitor();
    }
    S.chartSizes = was.sizes || {};
    S.showChart = was.chart;
    render();
    _remount();
  }

  return { register, active, shown, beside, over, any: () => active().length > 0,
    focus, plot, mute, point, reveal, release, tell };
})();
