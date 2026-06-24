// scripts/Grid.jsx

// Dirty takes precedence over the live cache; disconnected or rule-inactive
// collapse to null so the control renders blank.
function _resolveValue(reg, inactive, disconnected) {
  if(inactive || disconnected) return null;
  return reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
}

const _rowClass = (isDirty, ghosted, oor, isIgnored) =>
  cls("rb-reg",
    isDirty && "rb-dirty",
    ghosted && "rb-inactive",
    oor && "rb-oor",
    isIgnored && "rb-ignored");

const Grid = {

  // `Misc.Panel` renders as a sibling (not child) so its dropdown layout
  // flows naturally beneath the row.
  Row: ({ reg }) => {
    const inactive = Reg.isInactive(reg);
    const disconnected = !S.connected;
    const ghosted = inactive || disconnected;
    const val = _resolveValue(reg, inactive, disconnected);
    const isDirty = !ghosted && (reg.name in S.dirty);
    const isMonitored = S.monitor.has(reg.name);
    const isIgnored = S.ignore.has(reg.name);
    const isUtilOpen = !ghosted && S.utilOpen === reg.name;
    // R/O when the register is read-only OR not editable right now
    // (no device, rule slot inactive).
    const ro = Reg.ro(reg) || ghosted;
    const oor = Reg.outOfRange(reg, val);
    const showUnit = !Reg.isEnum(reg) && !Reg.isBool(reg);
    // Slider only fits live editable scalar numerics. Pairs (uint32 has 4G
    // steps, float has arbitrary precision) don't map to a range input, and
    // ignored rows are showing historical context.
    const showMiscBtn = Reg.isNumeric(reg) && !ro && !isIgnored && !reg.rule?.pair;
    // Writable + live: explicit send so the current value can be (re)written.
    const showSendBtn = !ro && !isIgnored;
    return (
      <div class="rb-row-wrap">
        <div class={_rowClass(isDirty, ghosted, oor, isIgnored)} title={Reg.tooltip(reg)}>
          <span class="rb-id">{Reg.label(reg)}</span>
          <span class="rb-name">{reg.name}</span>
          <Control.For reg={reg} value={val} isDirty={isDirty} ro={ro} />
          {showUnit && <span class="rb-unit">{inactive ? "" : Reg.unit(reg)}</span>}
          {showSendBtn &&
            <button class="rb-icon-btn" onClick={() => sendOne(reg)}
              title="Stage for Send (even if unchanged)">🎯</button>}
          <button class={cls("rb-icon-btn", isMonitored && "active")}
            onClick={() => monitor(reg)} title="Monitor">📊</button>
          <button class={cls("rb-icon-btn", isIgnored && "active")}
            onClick={() => toggleIgnore(reg)}
            title={isIgnored ? "Unhide" : "Ignore (skip polling, hide)"}>🚫</button>
          {showMiscBtn &&
            <button class={cls("rb-icon-btn", isUtilOpen && "active")}
              onClick={() => utilOpen(reg)} title="Slider">⚙</button>}
          <span class={Reg.rwsClass(reg)}>{Reg.rws(reg)}</span>
        </div>
        {isUtilOpen && <Misc.Panel reg={reg} value={val} />}
      </div>
    );
  },

  // Visual group: header (id range + count) followed by rows.
  Block: ({ regs }) => (
    <div class="rb-block">
      <div class="rb-head">
        {Reg.lo(regs[0])}-{Reg.hi(regs.at(-1))} <span class="rb-cnt">({regs.length})</span>
      </div>
      {regs.map(r => <Grid.Row reg={r} />)}
    </div>
  ),
};
