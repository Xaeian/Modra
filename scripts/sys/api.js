// scripts/api.js

const API = {
  MODE: "http", // "webview" | "http"
  BASE: "http://localhost:8000",
  isReady: null,
  waitForReady() {
    if(this.MODE !== "webview") return Promise.resolve();
    if(window.pywebview?.api) return Promise.resolve();
    if(!this.isReady) {
      this.isReady = new Promise(resolve => {
        window.addEventListener("pywebviewready", resolve, {once: true});
      });
    }
    return this.isReady;
  },
  call: async function(method, params = null, mute=false) {
    await API.waitForReady();
    if(API.MODE === "webview") {
      if(!mute) console.log("API →", "pywebview."+method, params !== null ? params : "");
      const t0 = performance.now();
      try {
        const out = params !== null
          ? await window.pywebview.api[method](params)
          : await window.pywebview.api[method]();
        if(!mute) console.log("API ←", "pywebview."+method, Math.round(performance.now() - t0)+"ms", out);
        return out;
      } catch(e) {
        if(!mute) {
          console.log("API ✖", "pywebview."+method, Math.round(performance.now() - t0)+"ms", e);
          alert.err(String(e));
        }
        return null;
      }
    }
    else {
      const url = `${API.BASE}/${method}`;
      if(!mute) console.log("API →", url, params !== null ? params : "");
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: params !== null ? "POST" : "GET",
          headers: params !== null ? {"Content-Type": "application/json"} : {},
          body: params !== null ? JSON.stringify(params) : undefined,
        });
        const json = await res.json();
        if(!mute) console.log("API ←", url, res.status, Math.round(performance.now() - t0)+"ms", json);
        return json;
      } catch(e) {
        if(!mute) {
          console.log("API ✖", url, Math.round(performance.now() - t0)+"ms", e);
          alert.err('Connection lost');
        }
        return null;
      }
    }
  },
  sync:       ()       => API.call("sync"),
  status:     ()       => API.call("status"),
  info:       ()       => API.call("info"),
  serial:     ()       => API.call("serial"),
  config:     ()       => API.call("config"),
  disconnect: ()       => API.call("disconnect"),
  read:       ()       => API.call("read", null, true),
  scan:       ()       => API.call("scan", null, true),
  connect:    (port)   => API.call("connect",    {port}),
  set_addr:   (addr)   => API.call("set_addr",   {addr}),
  scan_addrs: (addrs)  => API.call("scan_addrs", {addrs}),
  set_serial: (params) => API.call("set_serial",  params),
  set_config: (data)   => API.call("set_config",  data),
  write:      (data)   => API.call("write",        data),
};