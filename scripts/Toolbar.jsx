const Toolbar = () => {
  const dc = Object.keys(S.dirty).length;
  const on = S.serial_open || S.connected;
  return (
    <div class="rb-toolbar">
      <select class="rb-port" value={S.portInput}
        onChange={(e) => { S.portInput = e.target.value; render(); }}
        disabled={!S.ports.length}
        onBlur={() => _renderPending && render()}>
        {S.ports.map(p => <option value={p}>{p}</option>)}
      </select>
      <input class="rb-addr" type="text" value={S.addrInput}
        placeholder="addr" title="Modbus device address (1–247)"
        onInput={(e) => { S.addrInput = e.target.value; }} />
      <button class={`rb-tbtn rb-conn${S.connected ? ' on' : S.serial_open ? ' open' : ''}`}
        onClick={toggleConnection}
        disabled={S.busy || (!on && !S.portInput)}>
        {S.busy ? '⏳' : '⚡'}
      </button>
      {dc
        ? <button class="rb-tbtn rb-send" onClick={send} disabled={!S.connected}
            title="Write pending changes">⬆ Send ({dc})</button>
        : <button class={`rb-tbtn${S.connected ? '' : ' off'}`} onClick={sync}
            disabled={!S.connected} title="Force full sync">⬇ Read</button>
      }
      <button class={`rb-tbtn${dc ? '' : ' off'}`} onClick={reset}
        disabled={!dc} title="Discard pending changes">✕ Reset</button>
      <input class="rb-search" type="text" placeholder="Search..."
        value={S.query || ''} onInput={(e) => search(e.target.value)} />
      <button class={`rb-tbtn${S.showChart ? ' active' : ''}`}
        onClick={() => { S.showChart = !S.showChart; render(); }}
        title="Toggle chart panel">📈</button>
      <button class={`rb-tbtn${S.showRegs ? ' active' : ''}`}
        onClick={() => { S.showRegs = !S.showRegs; render(); }}
        title="Toggle register panel">📋</button>
      <button class={`rb-tbtn${S.serialOpen ? ' active' : ''}`} onClick={toggleSerial}
        title="Settings">☰</button>
    </div>
  );
};