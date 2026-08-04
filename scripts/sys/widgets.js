// scripts/sys/widgets.js

// Registry of device widgets - panels for one device family, expressing what the
// generic register grid cannot (a lookup table, a tuning curve). Frontend only.
//
// Two gates, both must pass: the `widgets` list in app.ini, and the widget's own
// `match(regs)` against the loaded catalog.
//
// JSX-free on purpose: the dev server serves `.js` verbatim, only `.jsx` gets
// Babel. The host component lives in App.jsx.

// Quoted: an undefined app.ini var expands to the empty string, which must parse.
const WIDGETS_ENABLED = "{{widgets}}";

const Widgets = (() => {

  const _all = [];
  const _allow = new Set(WIDGETS_ENABLED.split(",").map(s => s.trim()).filter(Boolean));

  // Widgets self-register at load time; the bundler puts every `.js` before every
  // `.jsx`, so this registry exists first. Dropping an unlisted widget here keeps
  // the rest of the app unaware of it - the source still ships, only inert.
  function register(widget) {
    if(!widget?.id || !_allow.has(widget.id)) return;
    if(_all.some(w => w.id === widget.id)) {
      console.warn("Widget already registered:", widget.id);
      return;
    }
    _all.push(widget);
  }

  // Cached on the catalog reference - the backend builds it once and never
  // rebuilds it. A throwing `match` disqualifies the widget instead of breaking
  // render.
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

  return { register, active, any: () => active().length > 0 };
})();
