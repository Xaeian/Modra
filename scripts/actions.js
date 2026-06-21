// scripts/actions.js

// User-triggered side effects: edit, connect, send, sync, scan, serial,
// import/export. Public actions end with `render()` so the DOM reflects S.

//---------------------------------------------------------- Helpers

const VIEW_SAVE_DEBOUNCE_MS = 500;
const MIN_ADDR = 1;
const MAX_ADDR = 247;

const fileStamp = () => new Date().toISOString().slice(0, 10);

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

// Keeps `Monitor.jsx` / `monitor()` call sites stable when we batched the saver.
const saveMonitor = () => _viewSaver.monitor();

//---------------------------------------------------------- Edit / dirty

// Equal-to-cache means "user clicked back to the original" - drop the dirty
// entry instead of recording a no-op write.
function edit(reg, val) {
  if(Reg.same(S.values[reg.name], val)) delete S.dirty[reg.name];
  else S.dirty[reg.name] = val;
  render();
}

// Same merge as `edit` but no render. Used by `importConfig` (bulk load)
// and the numeric Input during typing (renders on blur, not per key).
function editSilent(reg, val) {
  if(Reg.same(S.values[reg.name], val)) delete S.dirty[reg.name];
  else S.dirty[reg.name] = val;
}

function resetOne(reg) { delete S.dirty[reg.name]; render(); }

function reset() { S.dirty = {}; render(); }

// Null checkbox: when `cur` is `null`, revert the pending edit; else set pending `null`.
function toggleNull(reg) {
  const cur = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  cur == null ? resetOne(reg) : edit(reg, null);
}

//---------------------------------------------------------- UI toggles

function monitor(reg) {
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
  // Kick a fresh poll so the new trace gets backfilled within the visible
  // window instead of waiting up to one tick (~100ms) with an empty series.
  if(adding) poll();
}

function utilOpen(reg) {
  S.utilOpen = (S.utilOpen === reg.name) ? null : reg.name;
  render();
}

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
      _viewSaver.monitor();
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
      S.errors = 0;
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
    const a = parseInt(S.addrInput);
    if(a >= MIN_ADDR && a <= MAX_ADDR) {
      const s = await API.set_addr(a);
      applyStatus(s);
      if(S.connected) startPoll();
      else alert.wrn(s?.error || `No response addr:${a}`);
    }
  }
  finally {
    S.busy = false;
    render();
  }
}

//---------------------------------------------------------- Write / Sync

// Replaces `S.values` with the returned cache rather than merging our
// pending edits - the backend may have clamped or rejected values.
async function send() {
  if(!S.connected || !Object.keys(S.dirty).length) return;
  const cache = await API.write(S.dirty);
  if(cache && !cache.error) {
    applyCache(cache);
    const n = Object.keys(S.dirty).length;
    S.dirty = {};
    alert.ok(`Write done (${n})`);
  }
  else alert.err(cache?.error || "Write failed");
  render();
}

async function sync() {
  if(!S.connected) return;
  await API.sync();
  alert.inf("Sync requested");
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
  alert.ok("Database cleared");
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
            editSilent({ name }, val);
            count++;
          }
        }
      }
      else if(v !== null && v !== "" && rwSet.has(k)) {
        editSilent({ name: k }, v);
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
        editSilent({ name }, val);
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
  CSV.save(`cfg@${fileStamp()}.csv`, rows, ["id", "hex", "name", "value", "unit", "desc"]);
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
  INI.save(`cfg@${fileStamp()}.ini`, data, {}, commentField);
}
