// scripts/lib/alert.jsx

const _map = new Map(); // msg → {el, timer}
const OFFSET = 12;
const GAP = 6;
const MAX = 5;

function _reflow() {
  let y = OFFSET;
  for(const {el} of _map.values()) {
    el.style.bottom = y + 'px';
    y += el.offsetHeight + GAP;
  }
}

function _close(msg) {
  const entry = _map.get(msg);
  if(!entry) return;
  clearTimeout(entry.timer);
  const {el} = entry;
  _map.delete(msg);
  el.style.opacity = '0';
  el.style.bottom = '-' + (el.offsetHeight + OFFSET) + 'px';
  _reflow(); // reposition remaining immediately
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

function alert_show(type, msg, ms = 3000) {
  if(_map.has(msg)) {
    clearTimeout(_map.get(msg).timer);
    _arm(msg, ms);
    return;
  }
  const el = (
    <div class={`rb-alert rb-alert-${type}`}>
      <span class="rb-alert-msg">{msg}</span>
      <button class="rb-alert-close" onClick={() => _close(msg)}>×</button>
    </div>
  );
  document.body.appendChild(el);
  el.offsetHeight; // force layout before transition
  _map.set(msg, {el, timer: null});
  _arm(msg, ms);
  _evict();
  requestAnimationFrame(() => _reflow());
}

const alert_err = (msg, ms = 4000) => alert_show('err', msg, ms);
const alert_wrn = (msg, ms = 3000) => alert_show('wrn', msg, ms);
const alert_inf = (msg, ms = 2500) => alert_show('inf', msg, ms);
const alert_ok  = (msg, ms = 2500) => alert_show('ok',  msg, ms);