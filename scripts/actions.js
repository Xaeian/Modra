// scripts/actions.js

// User-triggered side effects: edit, connect, send, sync, scan, serial,
// import/export. Public actions end with `render()` so the DOM reflects S.

//---------------------------------------------------------- Helpers

const VIEW_SAVE_DEBOUNCE_MS = 500;
const MIN_ADDR = 1;
const MAX_ADDR = 247;

// Debounced batched persist for view.json. Collects partial patches and
// flushes them in a single POST so monitor + ignore edits land race-free
// when multiple actions hit the same 500ms window.
const _viewSaver = (() => {
  let timer = null;
  let pending = {};
  const flush = () => {
    const patch = pending; pending = {};
    if(!Object.keys(patch).length) return;
    API.view_set(patch);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, VIEW_SAVE_DEBOUNCE_MS); };
  return {
    monitor() {
      const groups = MonitData.groups();
      pending.monitor = Object.entries(groups).map(([key, grp]) => ({
        traces: grp.names,
        size: S.chartSizes[key] || CHART_SIZE_DEFAULT,
      }));
      schedule();
    },
    ignore() { pending.ignore = [...S.ignore]; schedule(); },
  };
})();

// Stable alias for the debounced monitor saver.
const saveMonitor = () => _viewSaver.monitor();

//---------------------------------------------------------- Edit / dirty

// Equal-to-cache means "user clicked back to the original" - drop the dirty
// entry instead of recording a no-op write.
function edit(reg, val) { editSilent(reg, val); render(); }

// Merge a pending edit without rendering (bulk import, per-keystroke typing).
function editSilent(reg, val) {
  if(Reg.same(S.values[reg.name], val)) delete S.dirty[reg.name];
  else S.dirty[reg.name] = val;
}

function resetOne(reg) { delete S.dirty[reg.name]; render(); }

function reset() {
  const n = Object.keys(S.dirty).length;
  S.dirty = {};
  if(n) alert.inf(`Discarded ${n} pending edit${n === 1 ? "" : "s"}`);
  render();
}

// Toggle a pending device-null between set and reverted. Setting it counts
// as a pick, so autosend writes it immediately - same contract as an enum click.
function toggleNull(reg) {
  const cur = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  cur == null ? resetOne(reg) : editSend(reg, null);
}

//---------------------------------------------------------- Send single register

// Autosend fires for an editable reg with a pending value while connected.
const shouldAutosend = (reg) => S.serial?.autosend && S.connected && reg.name in S.dirty;

// Value already on the wire per register - collapses a blur autosend and an
// immediate 🎯 on the same field into a single write.
const _sending = new Map();

// Write one register and adopt the device-confirmed cache; drops its pending edit.
async function _writeOne(reg, val) {
  const cache = await API.write({ [reg.name]: val });
  if(cache && !cache.error) { applyCache(cache); delete S.dirty[reg.name]; }
  else alert.err(cache?.error || "Write failed");
}

// Per-row 🎯: stage the current value (pending edit, else live) into the Send
// batch even if it equals the cache, so an unchanged value can be re-sent.
// Autosend flushes it at once; otherwise it waits for Send.
function sendOne(reg) {
  if(!S.connected) return;
  S.dirty[reg.name] = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  if(shouldAutosend(reg)) autosendOne(reg);
  render();
}

// Autosend a single reg: flush its pending value, then adopt the device cache.
async function autosendOne(reg) {
  const val = S.dirty[reg.name];
  // Don't autosend a wrapping value; leave it staged for the explicit Send.
  if(Reg.willWrap(reg, val)) {
    alert.wrn(`${reg.name} would be stored as ${Reg.display(reg, Reg.wrapPreview(reg, val))} on the device - not sent`);
    render();
    return;
  }
  if(_sending.has(reg.name) && Reg.same(_sending.get(reg.name), val)) return;
  _sending.set(reg.name, val);
  try { await _writeOne(reg, val); }
  finally { _sending.delete(reg.name); }
  render();
}

// Enum/bool pick: set the value, and in autosend mode write it on the spot.
function editSend(reg, val) {
  edit(reg, val);
  if(shouldAutosend(reg)) autosendOne(reg);
}

//---------------------------------------------------------- UI toggles

function toggleMonitor(reg) {
  const adding = !S.monitor.has(reg.name);
  if(adding) S.monitor.add(reg.name);
  else S.monitor.delete(reg.name);
  render();
  // Two mount calls bracket refresh: first ensures the chart host exists in
  // the rendered DOM, second reattaches after ChartStack rebuilds panels.
  Monitor.mount();
  Monitor.refresh();
  Monitor.mount();
  saveMonitor();
  // Backfill the new trace from the store right away: lands with no device
  // connected, inside a frozen (zoomed) window, and skips the live throttle.
  if(adding) Monitor.refetch();
}

function toggleUtil(reg) {
  S.utilOpen = (S.utilOpen === reg.name) ? null : reg.name;
  render();
}

function toggleChart() { S.showChart = !S.showChart; render(); }

function search(q) { S.query = q; render(); }

function toggleSerial() { S.serialOpen = !S.serialOpen; render(); }

// Adding to ignore tidies derivative state: drops pending edits (would
// never poll back) and removes any chart trace (no new samples coming).
function toggleIgnore(reg) {
  if(S.ignore.has(reg.name)) {
    S.ignore.delete(reg.name);
  }
  else {
    S.ignore.add(reg.name);
    delete S.dirty[reg.name];
    if(S.monitor.has(reg.name)) {
      S.monitor.delete(reg.name);
      saveMonitor();
      Monitor.refresh();
      Monitor.mount();
    }
  }
  _viewSaver.ignore();
  render();
}

function toggleShowDisabled() { S.showDisabled = !S.showDisabled; render(); }

//---------------------------------------------------------- Connection

// One button covers connect (open port → probe addr) and disconnect.
// Stage failures roll back the relevant slice without flushing the rest of S.
async function toggleConnection() {
  if(S.busy) return;
  S.busy = true; render();
  try {
    if(S.connected) {
      stopPoll();
      applyStatus(await API.disconnect());
      applyCache(null);
      alert.inf("Disconnected");
      return;
    }
    const port = S.portInput;
    if(!port) return;
    // Reopen if the port is closed or the user picked a different one.
    if(!S.serial_open || S.port !== port) {
      if(S.serial_open) {
        applyStatus(await API.disconnect());
        applyCache(null);
      }
      const s = await API.connect(port);
      applyStatus(s);
      if(!S.serial_open) {
        alert.err(s?.error || `Failed to open ${port}`);
        return;
      }
    }
    const a = S.portInput === "SIM" ? 1 : parseInt(S.addrInput);
    if(a >= MIN_ADDR && a <= MAX_ADDR) {
      const s = await API.set_addr(a);
      applyStatus(s);
      if(S.connected) {
        startPoll();
        alert.ok(S.portInput === "SIM" ? "Simulator connected" : `Connected to addr ${a}`);
      }
      else alert.wrn(s?.error || `No response addr:${a}`);
    }
  }
  finally {
    S.busy = false;
    render();
  }
}

//---------------------------------------------------------- Write / Sync

// Confirm before sending values that overflow their register (they wrap to a
// different number). False only when the user cancels.
function _confirmWraps(batch) {
  const bad = Object.entries(batch)
    .map(([name, val]) => [Reg.byName(name), val])
    .filter(([reg, val]) => reg && Reg.willWrap(reg, val));
  if(!bad.length || typeof confirm !== "function") return true;
  const lines = bad.map(([reg, val]) =>
    `  ${reg.name}: ${Reg.display(reg, val)} → ${Reg.display(reg, Reg.wrapPreview(reg, val))}`).join("\n");
  return confirm(`${bad.length} value(s) are too large for their register and will be stored as a different number on the device:\n\n${lines}\n\nSend anyway?`);
}

// Replaces `S.values` with the returned cache rather than merging our
// pending edits - the backend may have clamped or rejected values.
async function send() {
  if(!S.connected || !Object.keys(S.dirty).length) return;
  if(!_confirmWraps(S.dirty)) return;
  const cache = await API.write(S.dirty);
  if(cache && !cache.error) {
    applyCache(cache);
    const n = Object.keys(S.dirty).length;
    S.dirty = {};
    alert.ok(`Saved ${n} register${n === 1 ? "" : "s"} to device`);
  }
  else alert.err(cache?.error || "Write failed");
  render();
}

async function sync() {
  if(!S.connected) return;
  await API.sync();
  alert.inf("Reading all registers from device");
}

//---------------------------------------------------------- Address scan

async function scanAddrs() {
  if(!S.serial_open || S.addrScanning) return;
  const addrs = parseAddrRange(S.addrScanInput);
  if(!addrs.length) { alert.wrn("Enter address range (e.g. 1-10)"); return; }
  S.addrScanning = true; S.addrScanResults = null; render();
  S.addrScanResults = await API.scan_addrs(addrs);
  S.addrScanning = false;
  if(S.addrScanResults.length) alert.ok(`Found ${S.addrScanResults.length} device(s)`);
  else alert.wrn("No devices found");
  render();
}

//---------------------------------------------------------- Serial config

// A change to a wire-level field (baudrate/parity/stopbits/timeout)
// invalidates the open port. Force a UI disconnect and tell the user.
async function setSerial(params) {
  const prev = { ...S.serial };
  S.serial = await API.set_serial(params);
  const WIRE_FIELDS = ["baudrate", "parity", "stopbits", "timeout"];
  const changed = WIRE_FIELDS.some(k => S.serial[k] !== prev[k]);
  if(changed && S.serial_open) {
    S.connected = false;
    S.serial_open = false;
    stopPoll();
    applyCache(null);
    alert.wrn("Serial params changed, reconnect needed");
  }
  else if(S.serial.interval !== prev.interval) restartPoll();
  render();
}

//---------------------------------------------------------- Database

// Wipe stored poll history. Confirms first (irreversible), then clears the
// live chart buffer so the panels don't show pre-delete samples that no
// longer exist on disk.
async function deleteDatabase() {
  if(typeof confirm === "function"
    && !confirm("Delete all stored history? This wipes data.db and cannot be undone.")) return;
  const res = await API.delete_database();
  if(res?.error) { alert.err(res.error); return; }
  MonitData.clear();
  if(S.monitor.size) { Monitor.refresh(); Monitor.mount(); }
  alert.ok("History database cleared");
  render();
}

//---------------------------------------------------------- Import / Export

// File picker for `importConfig`. Returns the picked File (or null on cancel)
// without leaking the temporary <input>.
function _pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// Bulk-load RW/RWs values from .ini or .csv into `S.dirty`. Uses
// `editSilent` to skip per-row renders; one final `render()` at the end.
async function importConfig() {
  const file = await _pickFile(".ini,.csv");
  if(!file) return;
  const rwSet = new Set(
    S.regs.filter(r => r.rws === "RW" || r.rws === "RWs").map(r => r.name)
  );
  // Parse to the register's type like keyboard input, so numerics stage as
  // numbers (range/wrap checks need that); enum/bool/ver stay strings.
  const stage = (name, val) => {
    const reg = Reg.byName(name);
    editSilent(reg || { name }, reg ? Reg.parse(reg, val) : val);
  };
  const ext = file.name.split(".").pop().toLowerCase();
  let count = 0;
  let srcNote = "";
  if(ext === "ini") {
    const ini = await INI.load(file);
    if(!ini) return;
    for(const [k, v] of Object.entries(ini)) {
      if(typeof v === "object" && v !== null) {
        for(const [n, val] of Object.entries(v)) {
          const name = `${k}:${n}`;
          if(val !== null && val !== "" && rwSet.has(name)) {
            stage(name, val);
            count++;
          }
        }
      }
      else if(v !== null && v !== "" && rwSet.has(k)) {
        stage(k, v);
        count++;
      }
    }
  }
  else if(ext === "csv") {
    let text = await file.text();
    // A PL/DE regional locale sets the list separator to ';' and the decimal
    // to ',', so a cfg CSV saved under it (commonly via Excel) comes back ';'
    // separated with "1,5" not "1.5", often with a UTF-8 BOM. Detect and
    // normalize here, at the app layer - the CSV lib stays a plain comma
    // parser. More ';' than ',' in the header is the tell.
    if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const head = text.split(/\r?\n/).find(l => l.trim()) || "";
    const localeCsv = (head.split(";").length - 1) > (head.split(",").length - 1);
    const rows = CSV.parse_text(text, localeCsv ? ";" : ",");
    for(const row of rows) {
      const name = row.name;
      let val = row.value;
      // With ';' as the separator the comma is free to be a decimal point.
      if(localeCsv && typeof val === "string") val = val.replace(/^(-?\d+),(\d+)$/, "$1.$2");
      if(name && val !== null && val !== "" && rwSet.has(name)) {
        stage(name, val);
        count++;
      }
    }
    if(localeCsv) srcNote = " (locale CSV: ';' separator, decimal comma)";
  }
  if(count) alert.inf(`Loaded ${count} registers from ${file.name}${srcNote}`);
  else alert.wrn("No matching registers found");
  render();
}

// One row per RWs register. R / W are skipped - they don't carry
// user-configurable state.
function exportConfigCSV() {
  const rows = [];
  for(const reg of S.regs) {
    if(reg.rws !== "RWs") continue;
    const unit = Array.isArray(reg.unit) ? reg.unit.join("/") : (reg.unit || "");
    rows.push({
      id: reg.id, hex: reg.hex, name: reg.name,
      value: S.values[reg.name] ?? "", unit,
      desc: reg.desc || "",
    });
  }
  const name = `cfg@${fileStamp()}.csv`;
  CSV.save(name, rows, ["id", "hex", "name", "value", "unit", "desc"]);
  alert.ok(`Exported ${rows.length} register${rows.length === 1 ? "" : "s"} to ${name}`);
}

// Groups → [sections], leaf RWs → section keys. Unit (e.g. "rpm") is attached
// as a trailing inline comment via `commentField`.
function exportConfigINI() {
  const data = {}, commentField = {};
  for(const reg of S.regs) {
    if(reg.rws !== "RWs") continue;
    const ci = reg.name.indexOf(":");
    const group = ci >= 0 ? reg.name.slice(0, ci) : null;
    const name = ci >= 0 ? reg.name.slice(ci + 1) : reg.name;
    const val = S.values[reg.name];
    const unit = Array.isArray(reg.unit) ? reg.unit.join("/") : (reg.unit || "");
    if(group) {
      if(!data[group]) { data[group] = {}; commentField[group] = {}; }
      data[group][name] = val ?? null;
      if(unit) commentField[group][name] = unit;
    }
    else {
      data[name] = val ?? null;
      if(unit) {
        if(!commentField[null]) commentField[null] = {};
        commentField[null][name] = unit;
      }
    }
  }
  const name = `cfg@${fileStamp()}.ini`;
  INI.save(name, data, {}, commentField);
  alert.ok(`Exported config to ${name}`);
}
