// scripts/keys.js

// Bare-key shortcuts (Gmail/GitHub pattern). Suppressed while typing; modifier
// combos pass through so native browser bindings (Ctrl+F etc.) stay intact.

const _TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function _isTyping() {
  const el = document.activeElement;
  if(!el || el === document.body) return false;
  if(_TYPING_TAGS.has(el.tagName)) return true;
  return !!el.isContentEditable;
}

const BINDINGS = {
  i: () => toggleShowDisabled(),
  o: () => toggleSerial(),
  p: () => toggleChart(),
  // One key, so it takes the first widget this map offers. Anything past that
  // is a click: a shortcut that guesses which panel you meant is worse than no
  // shortcut at all.
  w: () => { const w = Widgets.active()[0]; if(w) toggleWidget(w.id); },
};

document.addEventListener("keydown", (e) => {
  if(e.ctrlKey || e.altKey || e.metaKey) return;
  if(_isTyping()) return;
  const handler = BINDINGS[e.key.toLowerCase()];
  if(!handler) return;
  e.preventDefault();
  handler();
});
