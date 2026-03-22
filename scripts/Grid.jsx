// scripts/Grid.jsx

const Grid = {

  Row: ({ reg }) => {
    const inactive = Reg.isInactive(reg);
    const disconnected = !S.connected;
    const val = (inactive || disconnected) ? null : (reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name]);
    const isDirty = !inactive && !disconnected && (reg.name in S.dirty);
    const isMonitored = S.monitor.has(reg.name);
    const isUtilOpen = !inactive && !disconnected && S.utilOpen === reg.name;
    const ro = Reg.ro(reg) || inactive || disconnected;
    return (
      <div class="rb-row-wrap">
        <div class={`rb-reg${isDirty ? ' rb-dirty' : ''}${(inactive || disconnected) ? ' rb-inactive' : ''}${Reg.outOfRange(reg, val) ? ' rb-oor' : ''}`} title={Reg.tooltip(reg)}>
          <span class="rb-id">{Reg.label(reg)}</span>
          <span class="rb-name">{reg.name}</span>
          <Control.For reg={reg} value={val} isDirty={isDirty} ro={ro} />
          {!Reg.isEnum(reg) && !Reg.isBool(reg) && <span class="rb-unit">{inactive ? '' : Reg.unit(reg)}</span>}
          <button class={`rb-icon-btn${isMonitored ? ' active' : ''}`}
            onClick={() => monitor(reg)} title="Monitor">📊</button>
          {Reg.isNumeric(reg) && !ro &&
            <button class={`rb-icon-btn${isUtilOpen ? ' active' : ''}`}
              onClick={() => utilOpen(reg)} title="Misc">⚙</button>
          }
          <span class={Reg.rwsClass(reg)}>{Reg.rws(reg)}</span>
        </div>
        {isUtilOpen && <Misc.Panel reg={reg} value={val} />}
      </div>
    );
  },

  Block: ({ regs }) => (
    <div class="rb-block">
      <div class="rb-head">
        {Reg.lo(regs[0])}–{Reg.hi(regs.at(-1))} <span class="rb-cnt">({regs.length})</span>
      </div>
      {regs.map(r => <Grid.Row reg={r} />)}
    </div>
  ),
};