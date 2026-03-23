// app.jsx

let root = null;
let _renderPending = false;
let _pointerDown = false;

document.addEventListener('pointerdown', () => { _pointerDown = true; });
document.addEventListener('pointerup', () => {
  _pointerDown = false;
  if(_renderPending) render();
});
document.addEventListener('click', () => {
  _pointerDown = false;
  if(_renderPending) render();
});

function render() {
  if(_pointerDown || document.activeElement?.tagName === 'SELECT') {
    _renderPending = true;
    return;
  }
  _renderPending = false;
  const wasSearch = document.activeElement?.classList.contains('rb-search');
  const el = <App />;
  if(root) document.body.replaceChild(el, root);
  else document.body.appendChild(el);
  root = el;
  Monitor.mount();
  if(wasSearch) {
    const s = root.querySelector('.rb-search');
    if(s) { s.focus(); s.selectionStart = s.selectionEnd = S.query.length; }
  }
}

(async () => {
  const [scan, regs, serial, config] = await Promise.all([
    API.scan(), API.info(), API.serial(), API.config(),
  ]);
  if(!scan || !regs) {
    document.body.classList.add('app');
    render();
    alert.err('Backend unavailable', 0);
    startPortScan();
    return;
  }
  S.regs = regs;
  S.serial = serial;
  S.config = config;
  regs.forEach(r => { S.values[r.name] = null; });
  const monCfg = await API.monitor_load();
  if(Array.isArray(monCfg)) {
    const known = new Set(regs.map(r => r.name));
    for(const panel of monCfg) {
      const traces = Array.isArray(panel.traces) ? panel.traces : [];
      const size = CHART_SIZE_CYCLE.includes(panel.size) ? panel.size : CHART_SIZE_DEFAULT;
      let groupKey = null;
      for(const name of traces) {
        if(!known.has(name)) continue;
        S.monitor.add(name);
        if(!groupKey) {
          const reg = regs.find(r => r.name === name);
          if(reg) groupKey = chartGroupKey(reg);
        }
      }
      if(groupKey) S.chartSizes[groupKey] = size;
    }
    if(S.monitor.size) S.showChart = true;
  }
  applyStatus(scan);
  S.portInput = S.port || serial.port || '';
  S.addrInput = S.addr ? String(S.addr) : (serial.addr ? String(serial.addr) : '');
  if(S.connected) startPoll();
  startPortScan();
  document.body.classList.add('app');
  render();
  if(S.monitor.size) {
    Monitor.refresh();
    Monitor.mount();
  }
})();
