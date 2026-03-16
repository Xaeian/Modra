// main.jsx

let root = null;
let _renderPending = false;

function render() {
  if(document.activeElement?.tagName === 'SELECT') {
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
  applyStatus(scan);
  S.portInput = S.port || serial.port || '';
  S.addrInput = S.addr ? String(S.addr) : (serial.addr ? String(serial.addr) : '');
  if(S.connected) startPoll();
  startPortScan();
  document.body.classList.add('app');
  render();
})();