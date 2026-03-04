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
  if(wasSearch) {
    const s = root.querySelector('.rb-search');
    if(s) { s.focus(); s.selectionStart = s.selectionEnd = S.query.length; }
  }
}

(async () => {
  const [status, regs, serial, config] = await Promise.all([
    API.status(), API.info(), API.serial(), API.config(),
  ]);
  if(!status || !regs) {
    document.body.classList.add('app');
    render();
    alert_err('Backend unavailable', 0);
    startPortScan();
    return;
  }
  S.regs = regs;
  S.serial = serial;
  S.config = config;
  regs.forEach(r => { S.values[r.name] = null; });
  applyStatus(status);
  if(S.connected) startPoll();
  startPortScan();
  document.body.classList.add('app');
  render();
})();