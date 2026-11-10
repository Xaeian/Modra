// scripts/sys/api.js

// Dual-mode backend client: `webview` bridges via `window.pywebview.api.*`, `http`
// falls back to fetch. `mute` suppresses console + toast noise for poll-style calls.

const MODE = "{{mode}}"; // substituted at build/serve time from app.ini
const BASE = "http://localhost:8000";
const IS_WEBVIEW = MODE === "webview";

//----------------------------------------------------------------------------------------- Logging

// → request, ← response, ✖ failure.
function _log(label, info, t0, kind, mute) {
  if(mute) return;
  const ms = t0 != null ? Math.round(performance.now() - t0) + "ms" : "";
  console.log("API " + kind, label, ms, info ?? "");
}

//------------------------------------------------------------------------- Webview / HTTP backends

// Resolves once pywebview injects its bridge; cached so cold boot attaches one listener.
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

//---------------------------------------------------------------------------------- Public surface

const API = {
  /** Transport the page talks over, `"webview"` or `"http"`, filled in from app.ini. */
  MODE,

  /**
   * Any backend method by name, kept in the logging and error path; prefer a named helper.
   * Never rejects: a call that fails on the way is toasted and resolves `null`,
   * and a refusal from the backend arrives as `{ error }`.
   * @param {object|null} [params]  the JSON argument, none when `null`
   * @param {boolean} [mute]  no console log and no toast, for a call made every poll
   */
  call: async (method, params = null, mute = false) => {
    await _waitReady();
    return IS_WEBVIEW
      ? _callWebview(method, params, mute)
      : _callHttp(method, params, mute);
  },

  //------------------------------------------------------------------------------------ Connection

  /**
   * Connection status after a fresh look for serial ports, muted for the port poll:
   * `ports`, `port`, `serial_open`, `connected` and `addr`.
   */
  scan: () => API.call("scan", null, true),
  /** Serial and poll settings as the backend keeps them, every key present. */
  serial: () => API.call("serial"),
  /** Connection status after opening `port`, with `error` when it does not open. */
  connect: (port) => API.call("connect", { port }),
  /** Connection status after closing the port. */
  disconnect: () => API.call("disconnect", {}),
  /** Connection status after a switch to address `addr`, with `error` when it does not answer. */
  set_addr: (addr) => API.call("set_addr", { addr }),
  /** Addresses among `addrs` that answer, as `{ found }`. */
  scan_addrs: (addrs) => API.call("scan_addrs", { addrs }),
  /** Serial settings once `params`, any subset of them, are applied. */
  set_serial: (params) => API.call("set_serial", params),

  //------------------------------------------------------------------------------------------ Data

  /** Register map the backend loaded, one object per register, empty when there is none. */
  info: () => API.call("info"),
  /** A register map adopted from its CSV text, dropping the connection: `{ ok, count }`. */
  set_map: (text) => API.call("set_map", { text }),
  /**
   * One poll, muted: device values and connection status,
   * plus chart `rows` and their `tier` when `params` asks for a window.
   * @param {object|null} [params]  `{ from, to, names, max_points }`, times in seconds
   */
  read: (params) => API.call("read", params || null, true),
  /** A full re-read of the map, done on the next read cycle; `error` when not connected. */
  sync: () => API.call("sync"),
  /**
   * Every device value once `data` is written and the written registers are read back,
   * so the answer is what the device kept, not an echo; `{ error }` when it fails.
   * @param {object} data  register name -> value
   */
  write: (data) => API.call("write", data),

  //------------------------------------------------------------------------------------ View state

  /** Saved view: charted traces, ignored registers and whether to ask for a map at start. */
  view_get: () => API.call("view_get"),
  /** The saved view with `patch` merged in, as `{ ok, view }`; a key left out stays as it was. */
  view_set: (patch) => API.call("view_set", patch),

  //-------------------------------------------------------------------------------------- Database

  /** Every stored poll sample deleted; `error` while the database file is in use. */
  delete_database: () => API.call("delete_database", {}),
};
