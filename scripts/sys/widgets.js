// scripts/sys/widgets.js

// Registry of device widgets - per-family panels for what the register grid cannot
// show. Frontend only; the host component lives in App.jsx. Two gates, both must pass:
// the `widgets` list in app.ini and the widget's own `match(regs)`.
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

  return { register, active, any: () => active().length > 0 };
})();
