// scripts/alert.js

// Bottom-center toast stack. Deduped by message - repeats just rearm the
// existing toast so poll loops shouting "Connection lost" stay quiet.
// Capped at MAX; oldest evicted on overflow. Plain DOM because this loads
// before the JSX runtime.
// API: `alert.err / wrn / inf / ok (msg, ms?)`.
const alert = (() => {

  const OFFSET = 12;   // px from bottom of viewport
  const GAP = 6;       // px between stacked toasts
  const MAX = 5;       // hard cap on visible toasts
  const ICONS = { err: "🚨", wrn: "⚠️", inf: "ℹ️", ok: "✅" };

  // Map preserves insertion order so _evict() drops the oldest naturally.
  const _map = new Map();

  //---------------------------------------------------------- Layout

  // Re-stack bottom-up. Called on add/remove so heights compose cleanly.
  function _reflow() {
    let y = OFFSET;
    for(const { el } of _map.values()) {
      el.style.bottom = y + "px";
      y += el.offsetHeight + GAP;
    }
  }

  //---------------------------------------------------------- Lifecycle

  // 200ms must match the CSS transition duration in alert.css.
  function _close(msg) {
    const entry = _map.get(msg);
    if(!entry) return;
    clearTimeout(entry.timer);
    const { el } = entry;
    _map.delete(msg);
    el.style.opacity = "0";
    el.style.bottom = "-" + (el.offsetHeight + OFFSET) + "px";
    _reflow();
    setTimeout(() => el.remove(), 200);
  }

  function _arm(msg, ms) {
    const entry = _map.get(msg);
    if(entry && ms) entry.timer = setTimeout(() => _close(msg), ms);
  }

  function _evict() {
    while(_map.size > MAX) {
      const oldest = _map.keys().next().value;
      _close(oldest);
    }
  }

  //---------------------------------------------------------- DOM

  function _build(type, msg) {
    const el = document.createElement("div");
    el.className = "rb-alert rb-alert-" + type;
    const iconEl = document.createElement("span");
    iconEl.className = "rb-alert-icon";
    iconEl.textContent = ICONS[type] || ICONS.inf;
    const msgEl = document.createElement("span");
    msgEl.className = "rb-alert-msg";
    msgEl.textContent = msg;
    const closeBtn = document.createElement("button");
    closeBtn.className = "rb-alert-close";
    closeBtn.textContent = "×";
    closeBtn.onclick = () => _close(msg);
    el.appendChild(iconEl);
    el.appendChild(msgEl);
    el.appendChild(closeBtn);
    return el;
  }

  //---------------------------------------------------------- Public API

  // ms=0 → sticky (manual dismiss only).
  function show(type, msg, ms = 3000) {
    if(_map.has(msg)) {
      clearTimeout(_map.get(msg).timer);
      _arm(msg, ms);
      return;
    }
    const el = _build(type, msg);
    document.body.appendChild(el);
    // Force layout so the slide-in starts from the off-screen position set
    // in CSS instead of snapping into place.
    void el.offsetHeight;
    _map.set(msg, { el, timer: null });
    _arm(msg, ms);
    _evict();
    requestAnimationFrame(_reflow);
  }

  return {
    err: (msg, ms = 6000) => show("err", msg, ms),
    wrn: (msg, ms = 5000) => show("wrn", msg, ms),
    inf: (msg, ms = 4000) => show("inf", msg, ms),
    ok:  (msg, ms = 4000) => show("ok",  msg, ms),
  };
})();
