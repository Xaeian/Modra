// scripts/Toolbar.jsx

// Header strip: port + addr + lightning (connect toggle), Send/Read/Reset,
// search, right-cluster view toggles. Send and Reset replace the Read button
// whenever there are pending edits so the primary action is always visible.

const Toolbar = () => {
  const dc = Object.keys(S.dirty).length;
  const lineUp = S.serial_open || S.connected;
  // Send reddens on a pending OOR (write still goes through); a wrap is the
  // harsher case and Send confirms first.
  let dirtyOor = false, dirtyWrap = false;
  for(const [name, val] of Object.entries(S.dirty)) {
    const reg = Reg.byName(name);
    if(!reg) continue;
    if(Reg.outOfRange(reg, val)) dirtyOor = true;
    if(Reg.willWrap(reg, val)) dirtyWrap = true;
  }
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
        ? <button class={cls("rb-tbtn rb-send", (dirtyOor || dirtyWrap) && "oor", dirtyWrap && "wrap")} onClick={send} disabled={!S.connected}
            title={dirtyWrap ? "Send pending changes (some are too large for their register and will be stored differently)"
                 : dirtyOor ? "Send pending changes (some out of range)"
                 : "Send pending changes"}>⬆ Send ({dc})</button>
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
        onClick={toggleChart}
        title="Toggle charts (p)">📈</button>
      {/* Only offered when a widget actually matches this device's register map. */}
      {Widgets.any() &&
        <button class={cls("rb-tbtn", S.showWidgets && "active")}
          onClick={toggleWidgets}
          title="Toggle device widgets (w)">🧩</button>}
      <button class={cls("rb-tbtn", S.showDisabled && "active")}
        onClick={toggleShowDisabled}
        title="Show ignored (i)">🚫</button>
      <button class={cls("rb-tbtn", S.serialOpen && "active")} onClick={toggleSerial}
        title="Settings (o)">☰</button>
    </div>
  );
};
