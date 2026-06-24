// scripts/zoom.js

// Page zoom for the desktop (webview) build, where the browser's own Ctrl +/-
// is unavailable. Scales the whole UI via `body.style.zoom`, persisted across
// launches. No-op under HTTP - the browser handles zoom there.
const ZOOM = (() => {
  const KEY = "modra.zoom";
  const MIN = 0.5, MAX = 2.5, STEP = 0.1;
  let z = parseFloat(localStorage.getItem(KEY)) || 1.0;

  const apply = () => {
    document.body.style.zoom = z;
    localStorage.setItem(KEY, z.toFixed(2));
  };
  const set = (v) => { z = Math.max(MIN, Math.min(MAX, Math.round(v * 10) / 10)); apply(); };

  const enabled = API.MODE === "webview";
  if(enabled) {
    set(z);   // clamp+apply a possibly stale/corrupt stored value
    document.addEventListener("keydown", (e) => {
      if(!e.ctrlKey) return;
      if(e.key === "=" || e.key === "+") { set(z + STEP); e.preventDefault(); }
      else if(e.key === "-") { set(z - STEP); e.preventDefault(); }
      else if(e.key === "0") { set(1.0); e.preventDefault(); }
    });
    document.addEventListener("wheel", (e) => {
      if(!e.ctrlKey) return;
      set(z + (e.deltaY < 0 ? STEP : -STEP));
      e.preventDefault();
    }, { passive: false });
  }

  return { enabled, in: () => set(z + STEP), out: () => set(z - STEP) };
})();
