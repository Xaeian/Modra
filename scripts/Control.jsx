// scripts/Control.jsx

const Control = {

  Enum: ({ reg, value, isDirty, ro }) => (
    <div class="rb-btns">
      {Object.entries(reg.enum).map(([k, v]) => (
        <button
          class={`rb-btn${value === v ? ' on' : ''}${isDirty && value === v ? ' dirty' : ''}`}
          disabled={ro}
          onClick={() => !ro && edit(reg, v)}
        >{v}</button>
      ))}
    </div>
  ),

  Bool: ({ reg, value, isDirty, ro }) => (
    <div class="rb-btns">
      <button
        class={`rb-btn${value === true ? ' on' : ''}${isDirty && value === true ? ' dirty' : ''}`}
        disabled={ro} onClick={() => !ro && edit(reg, true)}
      >HIGH</button>
      <button
        class={`rb-btn${value === false || value == null ? ' on' : ''}${isDirty && value === false ? ' dirty' : ''}`}
        disabled={ro} onClick={() => !ro && edit(reg, false)}
      >LOW</button>
    </div>
  ),

  Ver: ({ reg, value }) => (
    <span class="rb-ro">{Reg.display(reg, value) || '—'}</span>
  ),

  Input: ({ reg, value, isDirty, ro }) => (
    <div class="rb-val-wrap">
      <input
        class={`rb-val${isDirty ? ' dirty' : ''}${Reg.outOfRange(reg, value) ? ' oor' : ''}`}
        type="text"
        value={Reg.display(reg, value)}
        placeholder="—"
        disabled={ro}
        onInput={(e) => !ro && editSilent(reg, Reg.parse(reg, e.target.value))}
        onBlur={(e) => {
          if(!ro && isDirty && S.dirty[reg.name] === null) resetOne(reg);
          else render();
        }}
      />
      {isDirty &&
        <button class="rb-val-reset" onClick={() => resetOne(reg)} title="Discard">✕</button>
      }
    </div>
  ),

  For: (props) => {
    if(Reg.isEnum(props.reg)) return <Control.Enum {...props} />;
    if(Reg.isBool(props.reg)) return <Control.Bool {...props} />;
    if(Reg.isVer(props.reg)) return <Control.Ver {...props} />;
    return <Control.Input {...props} />;
  },
};