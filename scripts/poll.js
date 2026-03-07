// poll.js

function parseAddrRange(str) {
  const addrs = new Set();
  for(const part of str.split(',')) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if(range) {
      const a = parseInt(range[1]);
      const b = parseInt(range[2]);
      for(let i = Math.min(a, b); i <= Math.max(a, b); i++) addrs.add(i);
    } else if(/^\d+$/.test(t)) {
      addrs.add(parseInt(t));
    }
  }
  return [...addrs]
    .filter(a => a >= 1 && a <= 247)
    .sort((a, b) => a - b);
}

function applyStatus(s) {
  if(!s) return;
  const newPorts = s.ports || S.ports;
  const same = newPorts.length === S.ports.length
    && newPorts.every((p, i) => p === S.ports[i]);
  if(!same) S.ports = newPorts;
  S.connected = s.connected || false;
  S.serial_open = s.serial_open || false;
  if(S.serial_open) {
    if('port' in s && s.port) S.port = s.port;
  } else {
    S.port = null;
  }
  if(S.connected) {
    if('addr' in s && s.addr) S.addr = s.addr;
  } else if(!S.serial_open) {
    S.addr = null;
  }
}

function applyCache(cache) {
  if(!cache) {
    for(const k in S.values) S.values[k] = null;
    return true;
  }
  let changed = false;
  for(const [k, v] of Object.entries(cache)) {
    if(typeof v === 'object' && v !== null) {
      for(const [n, val] of Object.entries(v)) {
        const key = `${k}:${n}`;
        if(S.values[key] !== val) {
          S.values[key] = val;
          changed = true;
        }
      }
    } else {
      if(S.values[k] !== v) {
        S.values[k] = v;
        changed = true;
      }
    }
  }
  return changed;
}

function isUserEditing() {
  const el = document.activeElement;
  if(!el || el === document.body) return false;
  if(el.tagName === 'SELECT') return true;
  if(el.closest?.('.rb-reg, .rb-toolbar, .rb-serial, .rb-util')) return true;
  return false;
}

let _polling = false;
async function poll() {
  if(_polling) return;
  _polling = true;
  try {
    const res = await API.read();
    if(!res) return;
    // Always apply connection status from backend
    applyStatus(res);
    if(!S.connected) {
      stopPoll();
      applyCache(null);
      S.errors = 0;
      alert.err('Device disconnected');
      render();
      return;
    }
    if(!res.data) return;
    S.errors = 0;
    const changed = applyCache(res.data);
    if(S.monitor.size) Monitor.update();
    if(!changed || isUserEditing()) return;
    render();
  } catch(e) {
    S.errors++;
    console.error('poll error:', e);
    render();
  } finally {
    _polling = false;
  }
}

let _pollTimer = null;
function startPoll() {
  if(_pollTimer) return;
  _pollTimer = setInterval(poll, 100);
  poll();
}

function stopPoll() {
  if(!_pollTimer) return;
  clearInterval(_pollTimer);
  _pollTimer = null;
}

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
      if(prev.connected && !S.connected) {
        stopPoll();
        applyCache(null);
      }
      if(S.ports !== prevPorts ||
         prev.connected !== S.connected ||
         prev.serial_open !== S.serial_open) render();
    } finally {
      _portScanning = false;
    }
  }, 1000);
}