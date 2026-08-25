// scripts/Grid.jsx

// Inactive or disconnected collapse to null so the control renders blank.
function _resolveValue(reg, inactive, disconnected) {
  if(inactive || disconnected) return null;
  return reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
}

const _rowClass = (isDirty, ghosted, oor, isIgnored, match) =>
  cls("rb-reg",
    isDirty && "rb-dirty",
    ghosted && "rb-inactive",
    oor && "rb-oor",
    isIgnored && "rb-ignored",
    match && ("rb-" + match));

const Grid = {

  // `Misc.Panel` is a sibling, not a child, so it flows beneath the row.
  Row: ({ reg }) => {
    const inactive = Reg.isInactive(reg);
    const disconnected = !S.connected;
    const ghosted = inactive || disconnected;
    const val = _resolveValue(reg, inactive, disconnected);
    const isDirty = !ghosted && (reg.name in S.dirty);
    const isMonitored = S.monitor.has(reg.name);
    const isIgnored = S.ignore.has(reg.name);
    const isUtilOpen = !ghosted && S.utilOpen === reg.name;
    const ro = Reg.ro(reg) || ghosted;
    const oor = Reg.outOfRange(reg, val) || Reg.willWrap(reg, val);
    // enum/bool/bits have no unit; ver shows its field names where one would go.
    const showUnit = Reg.isScalar(reg) || Reg.isVer(reg);
    const unitText = Reg.isVer(reg) ? (reg.ver || "") : Reg.unit(reg);
    // Pairs don't map to a range input (uint32 has 4G steps, float arbitrary
    // precision); ignored rows are historical context, not live.
    const showMiscBtn = Reg.isScalar(reg) && !ro && !isIgnored && !reg.rule?.pair;
    const showSendBtn = !ro && !isIgnored;
    return (
      <div class="rb-row-wrap">
        <div class={_rowClass(isDirty, ghosted, oor, isIgnored, Reg.match(reg))}
          title={Reg.tooltip(reg)}>
          <span class="rb-id">{Reg.label(reg)}</span>
          <span class="rb-name">{reg.name}</span>
          <Control.For reg={reg} value={val} isDirty={isDirty} ro={ro} />
          {showUnit && <span class="rb-unit">{inactive ? "" : unitText}</span>}
          {showSendBtn &&
            <button class="rb-icon-btn" onClick={() => sendOne(reg)}
              title="Stage for Send (even if unchanged)">🎯</button>}
          {Reg.isTelemetry(reg) &&
            <button class={cls("rb-icon-btn", isMonitored && "active")}
              onClick={() => toggleMonitor(reg)} title="Monitor">📊</button>}
          <button class={cls("rb-icon-btn", isIgnored && "active")}
            onClick={() => toggleIgnore(reg)}
            title={isIgnored ? "Unhide" : "Ignore (skip polling, hide)"}>🚫</button>
          {showMiscBtn &&
            <button class={cls("rb-icon-btn", isUtilOpen && "active")}
              onClick={() => toggleUtil(reg)} title="Slider">⚙</button>}
          <span class={Reg.rwsClass(reg)}>{Reg.rws(reg)}</span>
        </div>
        {isUtilOpen && <Misc.Panel reg={reg} value={val} />}
      </div>
    );
  },

  Block: ({ regs }) => (
    <div class="rb-block">
      <div class="rb-head">
        {Reg.lo(regs[0])}-{Reg.hi(regs.at(-1))} <span class="rb-cnt">({regs.length})</span>
      </div>
      {regs.map(r => <Grid.Row reg={r} />)}
    </div>
  ),
};
