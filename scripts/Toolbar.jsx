// scripts/Toolbar.jsx

// Header strip: port + addr + lightning (connect toggle), Send/Read/Reset,
// search, right-cluster view toggles. Send and Reset replace the Read button
// whenever there are pending edits so the primary action is always visible.

const Toolbar = () => {
  const dc = Object.keys(S.dirty).length;
  const lineUp = S.serial_open || S.connected;
  // Send turns red as a warning when any pending edit is OOR; the write
  // still goes through and the firmware decides what to do.
  const dirtyOor = Object.entries(S.dirty).some(([name, val]) => {
    const reg = S.regs.find(r => r.name === name);
    return reg && Reg.outOfRange(reg, val);
  });
  return (
    <div class="rb-toolbar">
      <select class="rb-port" value={S.portInput}
        onChange={(e) => { S.portInput = e.target.value; if(e.target.value === "SIM") S.addrInput = "1"; render(); }}
        disabled={!S.ports.length}
        onBlur={() => _renderPending && render()}>
        {S.ports.map(p => <option value={p}>{p}</option>)}
      </select>
      <input class="rb-addr" type="text" value={S.addrInput}
        placeholder="addr" title="Modbus device address (1-247)"
        disabled={S.portInput === "SIM"}
        onInput={(e) => { S.addrInput = e.target.value; }} />
      <button class={cls("rb-tbtn rb-conn", S.connected && "on", S.serial_open && !S.connected && "open")}
        onClick={toggleConnection}
        disabled={S.busy || (!lineUp && !S.portInput)}>
        {S.busy ? "⏳" : "⚡"}
      </button>
      {dc
        ? <button class={cls("rb-tbtn rb-send", dirtyOor && "oor")} onClick={send} disabled={!S.connected}
            title={dirtyOor ? "Send pending changes (some out of range)" : "Send pending changes"}>⬆ Send ({dc})</button>
        : <button class={cls("rb-tbtn", !S.connected && "off")} onClick={sync}
            disabled={!S.connected} title="Read all registers">⬇ Read</button>}
      <button class={cls("rb-tbtn", !dc && "off")} onClick={reset}
        disabled={!dc} title="Discard pending changes">✕ Reset</button>
      <div class="rb-search-wrap">
        <input class="rb-search" type="text" placeholder="Search..."
          value={S.query || ""} onInput={(e) => search(e.target.value)} />
        {S.query && (
          <button class="rb-search-clear" title="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => search("")}>✕</button>
        )}
      </div>
      {ZOOM.enabled && <button class="rb-tbtn" onClick={ZOOM.out} title="Zoom out (Ctrl -)">A-</button>}
      {ZOOM.enabled && <button class="rb-tbtn" onClick={ZOOM.in} title="Zoom in (Ctrl +)">A+</button>}
      <button class={cls("rb-tbtn", S.showChart && "active")}
        onClick={() => { S.showChart = !S.showChart; render(); }}
        title="Toggle charts (p)">📈</button>
      <button class={cls("rb-tbtn", S.showDisabled && "active")}
        onClick={toggleShowDisabled}
        title="Show ignored (i)">🚫</button>
      <button class={cls("rb-tbtn", S.serialOpen && "active")} onClick={toggleSerial}
        title="Settings (o)">☰</button>
    </div>
  );
};
