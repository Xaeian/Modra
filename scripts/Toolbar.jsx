const Toolbar = () => {
  const dc = Object.keys(S.dirty).length;
  const portClass = `rb-port${S.portsAdded.size ? ' ports-added' : S.portsRemoved.size ? ' ports-removed' : ''}`;
  const portChange = (e) => { clearPortChanges(); e.target.value ? connect(e.target.value) : disconnect(); };
  return (
    <div class="rb-toolbar">
      <select class={portClass} value={S.port ?? ''}
        onChange={portChange} onClick={clearPortChanges}
        onBlur={() => _renderPending && render()}>
        <option value="">—</option>
        {S.ports.map(p => <option value={p}>{p}</option>)}
      </select>
      <input class="rb-addr" type="text" value={S.addr ?? ''}
        title="Modbus device address (1–247)"
        disabled={!S.serial_open}
        onBlur={(e) => { const v = parseInt(e.target.value); if(v >= 1 && v <= 247) addr(v); }} />
      {S.connected
        ? <button class={`rb-tbtn rb-conn on${S.errors ? ' warn' : ''}`} onClick={disconnect}
            title={S.errors ? `Errors: ${S.errors}/3` : 'Disconnect'}>
            ⚡{S.errors ? ` ⚠${S.errors}` : ''}
          </button>
        : <button class="rb-tbtn rb-conn" onClick={() => addr(S.addr || 1)}
            disabled={!S.serial_open || !S.addr}
            title="Connect to device">⚡ OFF</button>
      }
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
      <button class={`rb-tbtn${S.serialOpen ? ' active' : ''}`} onClick={toggleSerial}
        title="Settings">☰</button>
    </div>
  );
};