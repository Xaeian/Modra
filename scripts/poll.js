// scripts/poll.js

// Frontend polls backend at the same interval the backend uses to read the
// device - one source of truth in `serial.ini` / `S.serial.interval`. Floor
// keeps the UI sane if the user sets an interval near zero. Port enumeration
// runs slower and stays hardcoded (it's about hot-plug, not data freshness).
const POLL_MS_FLOOR = 50;
const PORT_SCAN_MS = 1000;

function _pollInterval() {
  const ms = parseInt(S.serial?.interval) || 500;
  return Math.max(POLL_MS_FLOOR, ms);
}

//---------------------------------------------------------- Address parsing

// Parse range expressions like "1-10, 12, 100-110" into a sorted dedup'd
// list of valid Modbus addresses (1..247).
function parseAddrRange(str) {
  const addrs = new Set();
  for(const part of str.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if(range) {
      const a = parseInt(range[1]);
      const b = parseInt(range[2]);
      for(let i = Math.min(a, b); i <= Math.max(a, b); i++) addrs.add(i);
    }
    else if(/^\d+$/.test(t)) addrs.add(parseInt(t));
  }
  return [...addrs]
    .filter(a => a >= 1 && a <= 247)
    .sort((a, b) => a - b);
}

//---------------------------------------------------------- Status & cache merge

// Touches only what the payload sets explicitly. `ports` mutates only on
// actual change so the Toolbar select doesn't wiggle on every tick.
function applyStatus(s) {
  if(!s) return;
  const newPorts = s.ports || S.ports;
  const samePorts = newPorts.length === S.ports.length
    && newPorts.every((p, i) => p === S.ports[i]);
  if(!samePorts) {
    S.ports = newPorts;
    if(!S.portInput || !newPorts.includes(S.portInput))
      S.portInput = newPorts[0] || "";
  }
  S.connected = s.connected || false;
  S.serial_open = s.serial_open || false;
  if(S.serial_open) {
    if("port" in s && s.port) S.port = s.port;
  }
  else S.port = null;
  if(S.connected) {
    if("addr" in s && s.addr) S.addr = s.addr;
  }
  else if(!S.serial_open) S.addr = null;
}

// Merge a decoded cache (grouped `{Group: {Name: val}}` or flat) into
// `S.values`. Returns true if any value changed so callers can skip
// no-op renders.
function applyCache(cache) {
  if(!cache) {
    for(const k in S.values) S.values[k] = null;
    return true;
  }
  let changed = false;
  for(const [k, v] of Object.entries(cache)) {
    if(typeof v === "object" && v !== null) {
      for(const [n, val] of Object.entries(v)) {
        const key = `${k}:${n}`;
        if(S.values[key] !== val) {
          S.values[key] = val;
          changed = true;
        }
      }
    }
    else if(S.values[k] !== v) {
      S.values[k] = v;
      changed = true;
    }
  }
  return changed;
}

//---------------------------------------------------------- User editing guard

// Resolves at focus time (not on every poll), so the poll loop can skip
// re-renders that would steal focus or blow away half-typed values.
const _EDITING_SELECTOR = ".rb-reg, .rb-toolbar, .rb-config, .rb-util";
let _userEditing = false;

document.addEventListener("focusin", (e) => {
  const el = e.target;
  if(!el || el === document.body) { _userEditing = false; return; }
  if(el.tagName === "SELECT") { _userEditing = true; return; }
  // A focused button carries no half-typed value, so it must not gate render.
  if(el.tagName === "BUTTON") { _userEditing = false; return; }
  _userEditing = !!el.closest?.(_EDITING_SELECTOR);
});
document.addEventListener("focusout", () => { _userEditing = false; });

function isUserEditing() { return _userEditing; }

//---------------------------------------------------------- Poll loop

let _polling = false;
let _pollTimer = null;

// One iteration: pull cache (+ monitor rows since last ts), reconcile S,
// push chart data, render unless the user is editing. `_polling` guards
// re-entrancy; the next tick picks up if a call stretches past POLL_MS.
async function poll() {
  if(_polling) return;
  _polling = true;
  try {
    const params = MonitData.readParams();
    const res = await API.read(params);
    if(!res) return;
    applyStatus(res);
    if(!S.connected) {
      stopPoll();
      applyCache(null);
      alert.err("Device disconnected");
      render();
      return;
    }
    if(!res.data) return;
    const changed = applyCache(res.data);
    if("tier" in res) MonitData.tier = res.tier;
    if(S.monitor.size) Monitor.update(res.rows);
    if(!changed || isUserEditing()) return;
    render();
  }
  catch(e) {
    console.error("poll error:", e);
    render();
  }
  finally { _polling = false; }
}

function startPoll() {
  if(_pollTimer) return;
  _pollTimer = setInterval(poll, _pollInterval());
  poll();
}

function stopPoll() {
  if(!_pollTimer) return;
  clearInterval(_pollTimer);
  _pollTimer = null;
}

// Rebind the tick interval when `S.serial.interval` changes. Cheap (one
// clear + one setInterval), called from `setSerial` after the backend
// confirms the new value.
function restartPoll() {
  if(!_pollTimer) return;
  clearInterval(_pollTimer);
  _pollTimer = setInterval(poll, _pollInterval());
}

// Hidden tabs get interval-throttled by the browser; force a poll on
// resume so we don't show stale data after a long sleep.
document.addEventListener("visibilitychange", () => {
  if(!document.hidden && _pollTimer) poll();
});

//---------------------------------------------------------- Port scanner

let _portTimer = null;
let _portScanning = false;

function startPortScan() {
  if(_portTimer) return;
  _portTimer = setInterval(async () => {
    if(_portScanning) return;
    _portScanning = true;
    try {
      const status = await API.scan();
      if(!status) return;
      const prevPorts = S.ports;
      const prev = { connected: S.connected, serial_open: S.serial_open };
      applyStatus(status);
      // Backend dropped us between ticks - stop polling and blank the
      // cache so the UI doesn't keep displaying stale numbers.
      if(prev.connected && !S.connected) {
        stopPoll();
        applyCache(null);
      }
      if(S.ports !== prevPorts
        || prev.connected !== S.connected
        || prev.serial_open !== S.serial_open) render();
    }
    finally { _portScanning = false; }
  }, PORT_SCAN_MS);
}
