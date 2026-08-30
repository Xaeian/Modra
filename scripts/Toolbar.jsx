// scripts/Toolbar.jsx

// Send replaces Read whenever there are pending edits, so the primary action
// is always visible.

const Toolbar = () => {
  const dc = Object.keys(S.dirty).length;
  const lineUp = S.serial_open || S.connected;
  // OOR still writes through; a wrap is harsher, so Send confirms first.
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
        onChange={(e) => {
          S.portInput = e.target.value;
          if(e.target.value === "SIM") S.addrInput = "1";
          render();
        }}
        disabled={!S.ports.length}
        onBlur={() => _renderPending && render()}>
        {S.ports.map(p => <option value={p}>{p}</option>)}
      </select>
      <input class="rb-addr" type="text" value={S.addrInput}
        placeholder="addr" title="Modbus device address (1-247)"
        disabled={S.portInput === "SIM"}
        onInput={(e) => { S.addrInput = e.target.value; }} />
      <button onClick={toggleConnection}
        class={cls("rb-tbtn rb-conn", S.connected && "on",
          S.serial_open && !S.connected && "open")}
        disabled={S.busy || (!lineUp && !S.portInput)}>
        {S.busy ? "⏳" : "⚡"}
      </button>
      {dc
        ? <button onClick={send} disabled={!S.connected}
            class={cls("rb-tbtn rb-send", (dirtyOor || dirtyWrap) && "oor", dirtyWrap && "wrap")}
            title={dirtyWrap
              ? "Send pending changes (some are too large for their register"
                + " and will be stored differently)"
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
      {ZOOM.enabled &&
        <button class="rb-tbtn" onClick={ZOOM.out} title="Zoom out (Ctrl -)">A-</button>}
      {ZOOM.enabled &&
        <button class="rb-tbtn" onClick={ZOOM.in} title="Zoom in (Ctrl +)">A+</button>}
      <button class={cls("rb-tbtn", S.showChart && "active")}
        onClick={toggleChart}
        title="Toggle charts (p)">📈</button>
      {Widgets.active().map(w =>
        <button class={cls("rb-tbtn", S.widgetsOn.has(w.id) && "active")}
          onClick={() => toggleWidget(w.id)}
          title={"Toggle " + (w.title || w.id)}>{w.icon || "🧩"}</button>)}
      <button class={cls("rb-tbtn", S.showDisabled && "active")}
        onClick={toggleShowDisabled}
        title="Show ignored (i)">🚫</button>
      <button class={cls("rb-tbtn", S.serialOpen && "active")} onClick={toggleSerial}
        title="Settings (o)">☰</button>
    </div>
  );
};
