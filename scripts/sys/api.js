// scripts/sys/api.js

// Dual-mode backend client. `webview` bridges via `window.pywebview.api.*`,
// `http` falls back to plain fetch. `mute=true` (poll-style read/scan)
// suppresses console + toast noise.

const MODE = "{{mode}}";       // substituted at build/serve time from app.ini
const BASE = "http://localhost:8000";
const IS_WEBVIEW = MODE === "webview";

//---------------------------------------------------------- Logging

// Shared format for request/response/error: → request, ← response, ✖ failure.
function _log(label, info, t0, kind, mute) {
  if(mute) return;
  const ms = t0 != null ? Math.round(performance.now() - t0) + "ms" : "";
  console.log("API " + kind, label, ms, info ?? "");
}

//---------------------------------------------------------- Webview / HTTP backends

// Resolves once pywebview injects its js_api bridge. Cached so cold boot
// only attaches one listener.
let _readyPromise = null;
function _waitReady() {
  if(!IS_WEBVIEW) return Promise.resolve();
  if(window.pywebview?.api) return Promise.resolve();
  if(!_readyPromise) {
    _readyPromise = new Promise(resolve => {
      window.addEventListener("pywebviewready", resolve, { once: true });
    });
  }
  return _readyPromise;
}

async function _callWebview(method, params, mute) {
  const label = "pywebview." + method;
  _log(label, params, null, "→", mute);
  const t0 = performance.now();
  try {
    const out = params !== null
      ? await window.pywebview.api[method](params)
      : await window.pywebview.api[method]();
    _log(label, out, t0, "←", mute);
    return out;
  }
  catch(e) {
    _log(label, e, t0, "✖", mute);
    if(!mute) alert.err(String(e));
    return null;
  }
}

async function _callHttp(method, params, mute) {
  const url = BASE + "/" + method;
  _log(url, params, null, "→", mute);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: params !== null ? "POST" : "GET",
      headers: params !== null ? { "Content-Type": "application/json" } : {},
      body: params !== null ? JSON.stringify(params) : undefined,
    });
    const json = await res.json();
    _log(url, res.status + " " + JSON.stringify(json), t0, "←", mute);
    return json;
  }
  catch(e) {
    _log(url, e, t0, "✖", mute);
    if(!mute) alert.err("Connection lost");
    return null;
  }
}

//---------------------------------------------------------- Public surface

const API = {
  MODE,

  // Generic dispatcher. Prefer the named helpers below; `call()` exists so
  // ad-hoc callers still flow through the logging/error pipeline.
  call: async (method, params = null, mute = false) => {
    await _waitReady();
    return IS_WEBVIEW
      ? _callWebview(method, params, mute)
      : _callHttp(method, params, mute);
  },

  //---------------------------------------------------------- Connection

  scan:         ()       => API.call("scan",         null,  true),
  serial:       ()       => API.call("serial"),
  connect:      (port)   => API.call("connect",      { port }),
  disconnect:   ()       => API.call("disconnect",   {}),
  set_addr:     (addr)   => API.call("set_addr",     { addr }),
  scan_addrs:   (addrs)  => API.call("scan_addrs",   { addrs }),
  set_serial:   (params) => API.call("set_serial",   params),

  //---------------------------------------------------------- Data

  info:         ()       => API.call("info"),
  set_map:      (text)   => API.call("set_map",      { text }),
  read:         (params) => API.call("read",         params || null, true),
  sync:         ()       => API.call("sync"),
  write:        (data)   => API.call("write",        data),

  //---------------------------------------------------------- View state

  view_get:     ()       => API.call("view_get"),
  view_set:     (patch)  => API.call("view_set",     patch),

  //---------------------------------------------------------- Database

  delete_database: ()    => API.call("delete_database", {}),
};
