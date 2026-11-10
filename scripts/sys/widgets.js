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

  /**
   * A device widget entered in the registry, from the last line of its own `.jsx`:
   * every `.js` loads before any `.jsx`, so the registry is there by then.
   * An id the `widgets` list in app.ini leaves out is dropped: the widget ships, but stays inert.
   * @param {object} widget
   * @param {string} widget.id  the name the `widgets` list in app.ini enables it by
   * @param {(regs: object[]) => boolean} widget.match  whether the loaded map is its device's,
   *   judged by register names, never by a device id
   * @param {() => *} widget.View  panel content, built anew on every render,
   *   so anything it must not lose lives on the widget object
   * @param {string} [widget.title]  panel heading and toolbar tooltip, the `id` by default
   * @param {string} [widget.icon]  glyph of its toolbar switch
   * @param {boolean} [widget.beside]  a side panel that stays in view while the grid scrolls
   * @param {(msg: *) => *} [widget.receive]  answers `tell`, or returns `false` to turn it down
   */
  function register(widget) {
    if(!widget?.id || !_allow.has(widget.id)) return;
    if(_all.some(w => w.id === widget.id)) {
      console.warn("Widget already registered:", widget.id);
      return;
    }
    _all.push(widget);
  }

  // Cached on the catalog reference: the backend builds it once
  let _active = null, _activeSrc = null;
  /**
   * Widgets whose `match` accepts the loaded map, panel open or not.
   * `match` runs once per map, and a throwing one disqualifies its widget
   * instead of breaking render.
   */
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

  /**
   * Active widgets whose panel the operator has open.
   * `active()` stays the full list,
   * because the toolbar has to offer a switch for a widget precisely when that widget is closed.
   */
  const shown = () => active().filter(w => S.widgetsOn.has(w.id));
  /**
   * Open widgets that read alongside the grid, having asked for `beside`.
   * Such a panel stays in view while the grid scrolls, which is the whole point:
   * what it highlights has to be visible at the same time as what it says.
   */
  const beside = () => shown().filter(w => w.beside);
  /** Open widgets without `beside`, shown above the grid. */
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

  /**
   * These registers highlighted in the grid.
   * The query is the same one the search box takes, so `|` joins alternatives;
   * strict mode is forced, because a widget's list is written as exact names,
   * not as something to guess at.
   * @param {string} query  names or globs; a bare name also hits any name it is part of
   */
  function focus(query) {
    _keep();
    if(!S.searchStrict) toggleSearchStrict();
    search(query || "");
  }

  /**
   * Exactly these registers charted and nothing else.
   * A widget asking to plot is asking to be watched, so the chart opens too;
   * an empty list closes it.
   * An ignored register is never polled, so charting one would draw a flat line
   * and quietly lie: the ignore is lifted for anything asked for here.
   * @param {string[]} names  a name the map lacks is skipped
   * @param {string[]} [big]  the few that earn a taller panel; the rest get the small one,
   *   so a screenful of traces stays a screenful
   */
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
    Monitor.rebuild(true);
  }

  /**
   * One widget asking another for something.
   * Panels are separate on purpose, so they do not reach into each other:
   * a widget not shipped, not enabled or not interested simply does not answer,
   * and the sender is expected to carry on either way. A closed panel still hears it.
   * @param {string} id  the widget the message is for
   * @param {*} msg  what it wants, in terms the receiving widget sets
   * @returns {boolean} whether a widget took it
   */
  function tell(id, msg) {
    const w = active().find(x => x.id === id);
    if(!w?.receive) return false;
    try { return w.receive(msg) !== false; }
    catch(e) {
      console.warn("Widget message failed:", id, e);
      return false;
    }
  }

  // A pin outlives the pointing. `reveal` scrolls the grid to a row, and the
  // pointer necessarily leaves the text on the way there, so without a pin the
  // mark would go out exactly when it was finally worth looking at.
  let _pin = null;

  /**
   * One register marked in the grid, held for as long as its name is pointed at.
   * The highlight is static and nothing is written, so nothing needs undoing.
   * @param {string|null} name  `null` lets go, back to whatever `reveal` pinned
   */
  function point(name) {
    const next = name || _pin;
    if(S.pointed === next) return;
    S.pointed = next;
    render();
  }

  /**
   * One register scrolled into view in the grid and left marked.
   * Calling it on the row already pinned lets go again,
   * so the same click both fetches and releases.
   */
  function reveal(name) {
    _pin = _pin === name ? null : name;
    point(name);
    if(!_pin) return;
    const row = document.querySelector(`.rb-reg[data-reg="${CSS.escape(name)}"]`);
    if(row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /**
   * These registers out of the poll cycle, added to whatever the operator already ignores.
   * Additive on purpose: keeping only a declared list would silence every register
   * the widget did not think of, and a grid row that quietly stopped updating
   * is worse than a slow cycle.
   * What belongs here takes no part in tuning at all:
   * a journal, a counter, a serial-port setting.
   * `spare` wins over all of it, the operator's earlier ignores included:
   * telling someone to watch a number and freezing it in the same breath
   * is the one outcome this seam must not produce.
   * @param {string[]} patterns  plain names or globs
   * @param {string[]} [spare]  what the widget points at, names in an instruction or draws
   */
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

  /**
   * The operator's own view put back: their filter, their charts, their ignore list,
   * as they stood before a widget first took the view with `focus`, `plot` or `mute`.
   * A change made in between goes with the widget's view.
   */
  function release() {
    if(!_was) return;
    const was = _was;
    _drop();
    _pin = null;
    point(null);
    if(S.searchStrict !== was.strict) toggleSearchStrict();
    search(was.query || "");
    // Sizes before any save: a saved panel takes the size standing at that moment,
    // and `plot` already saved the widget's, even where the traces end up the same
    S.chartSizes = was.sizes || {};
    if(!_same([...S.ignore], was.ignore)) setIgnore(was.ignore);
    if(!_same([...S.monitor], was.monitor)) {
      S.monitor.clear();
      for(const name of was.monitor) S.monitor.add(name);
    }
    saveMonitor();
    S.showChart = was.chart;
    render();
    Monitor.rebuild(true);
  }

  return {
    register, active, shown, beside, over,
    focus, plot, mute, point, reveal, release, tell,
  };
})();
