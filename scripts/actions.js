// scripts/actions.js

// User-triggered side effects. Public actions end with `render()` so the DOM reflects S.

//----------------------------------------------------------------------------------------- Helpers

const VIEW_SAVE_DEBOUNCE_MS = 500;
const MIN_ADDR = 1;
const MAX_ADDR = 247;

// Batches partial view.json patches into one POST, so monitor and ignore
// edits in the same window don't clobber each other.
const _viewSaver = (() => {
  let timer = null;
  let pending = {};
  const flush = () => {
    const patch = pending; pending = {};
    if(!Object.keys(patch).length) return;
    API.view_set(patch);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, VIEW_SAVE_DEBOUNCE_MS);
  };
  return {
    monitor() {
      const groups = MonitData.groups();
      pending.monitor = Object.entries(groups).map(([key, grp]) => ({
        traces: grp.names,
        size: S.chartSizes[key] || CHART_SIZE_DEFAULT,
      }));
      schedule();
    },
    ignore() { pending.ignore = collapseIgnore(); schedule(); },
  };
})();

const saveMonitor = () => _viewSaver.monitor();

//------------------------------------------------------------------------------------ Edit / dirty

function edit(reg, val) { editSilent(reg, val); render(); }

// Merge a pending edit without rendering (bulk import, per-keystroke typing).
// Back to the cached value means no edit at all - drop the entry.
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

// Setting a null counts as a pick, so autosend writes it - like an enum click.
function toggleNull(reg) {
  const cur = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  if(cur == null) resetOne(reg); else editSend(reg, null);
}

//---------------------------------------------------------------------------- Send single register

const shouldAutosend = (reg) => S.serial?.autosend && S.connected && reg.name in S.dirty;

// Value already on the wire per register - collapses a blur autosend and an
// immediate 🎯 on the same field into a single write.
const _sending = new Map();

async function _writeOne(reg, val) {
  const cache = await API.write({ [reg.name]: val });
  if(cache && !cache.error) { applyCache(cache); delete S.dirty[reg.name]; }
  else alert.err(cache?.error || "Write failed");
}

// Per-row 🎯: stages the value even when it equals the cache, so an unchanged
// value can be re-sent.
function sendOne(reg) {
  if(!S.connected) return;
  S.dirty[reg.name] = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  if(shouldAutosend(reg)) autosendOne(reg);
  render();
}

async function autosendOne(reg) {
  const val = S.dirty[reg.name];
  // Don't autosend a wrapping value; leave it staged for the explicit Send.
  if(Reg.willWrap(reg, val)) {
    alert.wrn(`${reg.name} would be stored as `
      + `${Reg.display(reg, Reg.wrapPreview(reg, val))} on the device - not sent`);
    render();
    return;
  }
  if(_sending.has(reg.name) && Reg.same(_sending.get(reg.name), val)) return;
  _sending.set(reg.name, val);
  try { await _writeOne(reg, val); }
  finally { _sending.delete(reg.name); }
  render();
}

function editSend(reg, val) {
  edit(reg, val);
  if(shouldAutosend(reg)) autosendOne(reg);
}

//-------------------------------------------------------------------------------------- UI toggles

function toggleMonitor(reg) {
  const adding = !S.monitor.has(reg.name);
  if(adding) S.monitor.add(reg.name);
  else S.monitor.delete(reg.name);
  render();
  // First mount creates the chart host, the second reattaches after ChartStack rebuilds.
  Monitor.mount();
  Monitor.refresh();
  Monitor.mount();
  saveMonitor();
  // Backfill the new trace: works offline, inside a frozen window, and skips the throttle.
  if(adding) Monitor.refetch();
}

function toggleUtil(reg) {
  S.utilOpen = (S.utilOpen === reg.name) ? null : reg.name;
  render();
}

function toggleChart() { S.showChart = !S.showChart; render(); }

// Per-machine preference, so it lives in localStorage like the page zoom.
const WIDGETS_KEY = "modra.widgets";

function toggleWidgets() {
  if(!Widgets.any()) return;
  S.showWidgets = !S.showWidgets;
  try { localStorage.setItem(WIDGETS_KEY, S.showWidgets ? "1" : "0"); }
  catch(e) { /* storage disabled - the toggle still works for this session */ }
  render();
}

// Boot only, once the catalog is loaded so `Widgets.any()` is meaningful.
function restoreWidgets() {
  try { S.showWidgets = Widgets.any() && localStorage.getItem(WIDGETS_KEY) === "1"; }
  catch(e) { S.showWidgets = false; }
}

function search(q) { S.query = q; render(); }

// Fading misses (the default) holds the grid still while the query narrows.
function toggleSearchHide() { S.searchHide = !S.searchHide; render(); }

function toggleSerial() { S.serialOpen = !S.serialOpen; render(); }

// view.json may hold globs (`Journal:*`); `S.ignore` works in plain names, so
// expand on load and collapse on save. Everything between stays a set lookup.
function expandIgnore(patterns) {
  const out = new Set();
  for(const p of patterns) {
    const s = String(p).trim();
    if(!s) continue;
    if(!s.includes("*") && !s.includes("?")) { out.add(s); continue; }
    const re = new RegExp("^" + s.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    for(const r of S.regs) if(re.test(r.name)) out.add(r.name);
  }
  return out;
}

// A fully ignored group persists as one pattern, which then also covers
// registers added to that group later - the point of writing it as a group.
function collapseIgnore() {
  const groups = {};
  for(const r of S.regs) (groups[r.name.split(":")[0]] ??= []).push(r.name);
  const out = [], folded = new Set();
  for(const [group, names] of Object.entries(groups)) {
    if(names.length < 2 || !names.every(n => S.ignore.has(n))) continue;
    out.push(group + ":*");
    names.forEach(n => folded.add(n));
  }
  for(const n of S.ignore) if(!folded.has(n)) out.push(n);
  return out;
}

// Ignored regs stop polling, so a pending edit never confirms and a trace never grows.
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

//-------------------------------------------------------------------------------------- Connection

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
    const addr = S.portInput === "SIM" ? 1 : parseInt(S.addrInput);
    if(addr >= MIN_ADDR && addr <= MAX_ADDR) {
      const s = await API.set_addr(addr);
      applyStatus(s);
      if(S.connected) {
        startPoll();
        alert.ok(S.portInput === "SIM" ? "Simulator connected" : `Connected to addr ${addr}`);
      }
      else alert.wrn(s?.error || `No response addr:${addr}`);
    }
  }
  finally {
    S.busy = false;
    render();
  }
}

//------------------------------------------------------------------------------------ Write / Sync

// Overflowing values wrap to a different number. False only when the user cancels.
function _confirmWraps(batch) {
  const bad = Object.entries(batch)
    .map(([name, val]) => [Reg.byName(name), val])
    .filter(([reg, val]) => reg && Reg.willWrap(reg, val));
  if(!bad.length || typeof confirm !== "function") return true;
  const lines = bad.map(([reg, val]) =>
    `  ${reg.name}: ${Reg.display(reg, val)} → `
    + `${Reg.display(reg, Reg.wrapPreview(reg, val))}`).join("\n");
  return confirm(`${bad.length} value(s) are too large for their register and will be `
    + `stored as a different number on the device:\n\n${lines}\n\nSend anyway?`);
}

// Adopt the returned cache instead of our edits - the backend may clamp or reject.
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

//----------------------------------------------------------------------------------- Widget writes

// Direct write, bypassing `S.dirty`: a widget drives a control loop, not a
// pending-edit list, so there is nothing for Send/Reset to flush. Caller renders.
async function writeNow(patch) {
  if(!S.connected || !patch || !Object.keys(patch).length) return false;
  const cache = await API.write(patch);
  if(!cache || cache.error) {
    alert.err(cache?.error || "Write failed");
    return false;
  }
  applyCache(cache);
  return true;
}

//------------------------------------------------------------------------------------ Address scan

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

//----------------------------------------------------------------------------------- Serial config

// A wire-level change invalidates the open port, so force a UI disconnect.
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

//---------------------------------------------------------------------------------------- Database

// Clear the live buffer too, or the panels keep showing samples that no
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

//---------------------------------------------------------------------------------------- Defaults

// Ignored regs are excluded: they hold no pending edits by design (see `toggleIgnore`).
const defaultRegs = () => S.regs.filter(r =>
  r.default != null && (r.rws === "RW" || r.rws === "RWs") && !S.ignore.has(r.name));

// A `/`-list in `default` holds one value per device variant.
const variantCount = () => Math.max(1, ...S.regs.map(r =>
  Array.isArray(r.default) ? r.default.length : 1));

// Stage rather than write, so Send applies the same guards as a hand edit.
// `editSilent` drops what the device already holds, leaving the real diff.
function restoreDefaults() {
  const before = Object.keys(S.dirty).length;
  for(const reg of defaultRegs()) {
    const d = reg.default;
    editSilent(reg, Array.isArray(d) ? (d[S.variant] ?? d[0]) : d);
  }
  const n = Object.keys(S.dirty).length - before;
  if(n) alert.inf(`Staged ${n} default${n === 1 ? "" : "s"} - review, then Send`);
  else alert.ok("Already at defaults");
  render();
}

//--------------------------------------------------------------------------------- Import / Export

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

// The whole UI is generated from the register map, so a new map means a reload.
// The flag keeps the startup prompt from returning on the reload it caused.
const MAP_PICKED = "modra.mapPicked";

async function pickMap() {
  const file = await _pickFile(".csv");
  if(!file) return;
  const res = await API.set_map(await file.text());
  if(!res || res.error) { alert.err(res?.error || "Could not read that file"); return; }
  try { sessionStorage.setItem(MAP_PICKED, "1"); } catch(e) { /* storage disabled */ }
  location.reload();
}

// Kept in view.json, not localStorage - it belongs to the install, not the browser.
function toggleAskMap() {
  S.askMap = !S.askMap;
  API.view_set({ ask_map: S.askMap });
  render();
}

// Bulk-load RW/RWs values from .ini or .csv into `S.dirty`.
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
    // Excel under a PL/DE locale writes ';' separators, "1,5" decimals and a
    // UTF-8 BOM. Normalize here so the CSV lib stays a plain comma parser.
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

// One row per RWs register - R/W hold no user-configurable state.
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

// Groups → [sections], leaf RWs → keys; unit rides as a trailing comment.
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
