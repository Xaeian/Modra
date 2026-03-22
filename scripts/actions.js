// scripts/actions.js

function fileStamp() {
  return new Date().toISOString().slice(0, 10);
}

let _saveMonTimer = null;
function saveMonitor() {
  clearTimeout(_saveMonTimer);
  _saveMonTimer = setTimeout(() => {
    const groups = MonitData.groups();
    const panels = Object.entries(groups).map(([key, grp]) => {
      const panel = {traces: grp.names};
      panel.size = S.chartSizes[key] || CHART_SIZE_DEFAULT;
      return panel;
    });
    API.monitor_save(panels);
  }, 500);
}

function edit(reg, val) {
  if(Reg.same(S.values[reg.name], val)) delete S.dirty[reg.name];
  else S.dirty[reg.name] = val;
  render();
}

function editSilent(reg, val) {
  if(Reg.same(S.values[reg.name], val)) delete S.dirty[reg.name];
  else S.dirty[reg.name] = val;
}

function resetOne(reg) { delete S.dirty[reg.name]; render(); }

function reset() { S.dirty = {}; render(); }

function monitor(reg) {
  if(S.monitor.has(reg.name)) S.monitor.delete(reg.name);
  else S.monitor.add(reg.name);
  render();
  Monitor.mount();
  Monitor.refresh();
  Monitor.mount();
  saveMonitor();
}

function utilOpen(reg) {
  S.utilOpen = (S.utilOpen === reg.name) ? null : reg.name;
  render();
}

function search(q) { S.query = q; render(); }

function toggleSerial() { S.serialOpen = !S.serialOpen; render(); }

async function toggleConnection() {
  if(S.busy) return;
  S.busy = true; render();
  // Connected → disconnect
  if(S.connected) {
    stopPoll();
    applyStatus(await API.disconnect());
    applyCache(null);
    S.errors = 0;
    S.busy = false; render();
    return;
  }
  // Not connected → advance
  const port = S.portInput;
  if(!port) { S.busy = false; render(); return; }
  if(!S.serial_open || S.port !== port) {
    if(S.serial_open) {
      applyStatus(await API.disconnect());
      applyCache(null);
    }
    const s = await API.connect(port);
    applyStatus(s);
    if(!S.serial_open) {
      alert.err(s?.error || `Failed to open ${port}`);
      S.busy = false; render(); return;
    }
  }
  const a = parseInt(S.addrInput);
  if(a >= 1 && a <= 247) {
    const s = await API.set_addr(a);
    applyStatus(s);
    if(S.connected) startPoll();
    else alert.wrn(s?.error || `No response addr:${a}`);
  }
  S.busy = false; render();
}

async function send() {
  if(!S.connected || !Object.keys(S.dirty).length) return;
  const cache = await API.write(S.dirty);
  if(cache && !cache.error) {
    applyCache(cache);
    const n = Object.keys(S.dirty).length;
    S.dirty = {};
    alert.ok(`Write done (${n})`);
  } else {
    alert.err(cache?.error || 'Write failed');
  }
  render();
}

async function sync() {
  if(!S.connected) return;
  await API.sync();
  alert.inf('Sync requested');
}

async function scanAddrs() {
  if(!S.serial_open || S.addrScanning) return;
  const addrs = parseAddrRange(S.addrScanInput);
  if(!addrs.length) { alert.wrn('Enter address range (e.g. 1-10)'); return; }
  S.addrScanning = true; S.addrScanResults = null; render();
  S.addrScanResults = await API.scan_addrs(addrs);
  S.addrScanning = false;
  if(S.addrScanResults.length) alert.ok(`Found ${S.addrScanResults.length} device(s)`);
  else alert.wrn('No devices found');
  render();
}

async function setSerial(params) {
  const prev = {...S.serial};
  S.serial = await API.set_serial(params);
  const changed = ['baudrate','parity','stopbits','timeout'].some(k => S.serial[k] !== prev[k]);
  if(changed && S.serial_open) {
    S.connected = false; S.serial_open = false; stopPoll(); applyCache(null);
    alert.wrn('Serial params changed, reconnect needed');
  }
  render();
}

async function importConfig() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.ini,.csv';
  const file = await new Promise(res => {
    input.onchange = () => res(input.files[0] || null);
    input.oncancel = () => res(null);
    input.click();
  });
  if(!file) return;
  let count = 0;
  const rwSet = new Set(
    S.regs.filter(r => r.rws === 'RW' || r.rws === 'RWs').map(r => r.name)
  );
  const ext = file.name.split('.').pop().toLowerCase();
  if(ext === 'ini') {
    const ini = await INI.load(file);
    if(!ini) return;
    for(const [k, v] of Object.entries(ini)) {
      if(typeof v === 'object' && v !== null) {
        for(const [n, val] of Object.entries(v)) {
          const name = `${k}:${n}`;
          if(val !== null && val !== '' && rwSet.has(name)) { editSilent({name}, val); count++; }
        }
      } else {
        if(v !== null && v !== '' && rwSet.has(k)) { editSilent({name: k}, v); count++; }
      }
    }
  } else if(ext === 'csv') {
    const rows = await CSV.load(file);
    for(const row of rows) {
      const name = row.name, val = row.value;
      if(name && val !== null && val !== '' && rwSet.has(name)) { editSilent({name}, val); count++; }
    }
  }
  if(count) alert.inf(`Loaded ${count} registers from ${file.name}`);
  else alert.wrn('No matching registers found');
  render();
}

function exportConfigCSV() {
  const rows = [];
  for(const reg of S.regs) {
    if(reg.rws !== 'RWs') continue;
    const ci = reg.name.indexOf(':');
    const group = ci >= 0 ? reg.name.slice(0, ci) : null;
    const name = ci >= 0 ? reg.name.slice(ci + 1) : reg.name;
    const val = group ? S.config[group]?.[name] : S.config[name];
    const unit = Array.isArray(reg.unit) ? reg.unit.join('/') : (reg.unit || '');
    rows.push({id: reg.id, hex: reg.hex, name: reg.name, value: val ?? '', unit, desc: reg.desc || ''});
  }
  CSV.save(`cfg@${fileStamp()}.csv`, rows, ['id', 'hex', 'name', 'value', 'unit', 'desc']);
}

function exportConfigINI() {
  const data = {}, commentField = {};
  for(const reg of S.regs) {
    if(reg.rws !== 'RWs') continue;
    const ci = reg.name.indexOf(':');
    const group = ci >= 0 ? reg.name.slice(0, ci) : null;
    const name = ci >= 0 ? reg.name.slice(ci + 1) : reg.name;
    const val = group ? S.config[group]?.[name] : S.config[name];
    const unit = Array.isArray(reg.unit) ? reg.unit.join('/') : (reg.unit || '');
    if(group) {
      if(!data[group]) { data[group] = {}; commentField[group] = {}; }
      data[group][name] = val ?? null;
      if(unit) commentField[group][name] = unit;
    } else {
      data[name] = val ?? null;
      if(unit) { if(!commentField[null]) commentField[null] = {}; commentField[null][name] = unit; }
    }
  }
  INI.save(`cfg@${fileStamp()}.ini`, data, {}, commentField);
}