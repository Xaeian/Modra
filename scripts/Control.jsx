// scripts/Control.jsx

// Type-specialized value controls. `For` dispatches; each variant takes
// `{reg, value, isDirty, ro}` and commits through `edit()` / `editSilent()`.

// Highlight when the candidate matches the current value. `dirty` recolors
// so a pending pick reads differently from a confirmed one.
const _btnClass = (isActive, isDirty) =>
  cls("rb-btn", isActive && "on", isDirty && isActive && "dirty");

// Inline `null` toggle for writable nullable regs (Bool and Input share it).
const NullCheckbox = ({ reg }) => {
  const cur = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  return (
    <label class="rb-null-cb" title="Write null sentinel">
      <input type="checkbox" checked={cur == null} onChange={() => toggleNull(reg)} />
      null
    </label>
  );
};

const Control = {

  // Enum picker: one button per label, exclusive selection.
  Enum: ({ reg, value, isDirty, ro }) => (
    <div class="rb-btns">
      {Object.entries(reg.enum).map(([, v]) => (
        <button class={_btnClass(value === v, isDirty)}
          disabled={ro}
          onClick={() => !ro && edit(reg, v)}
        >{v}</button>
      ))}
    </div>
  ),

  // R/O nullable null shows the "null" label so it's not mistaken for a
  // never-polled cell. Non-nullable null maps to LOW (defined state).
  Bool: ({ reg, value, isDirty, ro }) => {
    if(ro && Reg.isNA(reg, value)) return <span class="rb-ro na">null</span>;
    const lowOn = value === false || (value == null && !reg.nullable);
    return (
      <div class="rb-btns">
        <button class={_btnClass(value === true, isDirty)} disabled={ro}
          onClick={() => !ro && edit(reg, true)}>HIGH</button>
        <button class={_btnClass(lowOn, isDirty && value === false)} disabled={ro}
          onClick={() => !ro && edit(reg, false)}>LOW</button>
        {reg.nullable && !ro && <NullCheckbox reg={reg} />}
      </div>
    );
  },

  // Version string from `Reg.display` (X.YY.ZZ). Always read-only.
  Ver: ({ reg, value }) => (
    <span class="rb-ro">{Reg.display(reg, value) || "-"}</span>
  ),

  // Free-text input for numerics. `editSilent` defers render until blur.
  Input: ({ reg, value, isDirty, ro }) => {
    const na = Reg.isNA(reg, value);
    // Non-nullable blank = discard the edit; nullable blank = commit null.
    const onBlur = () => {
      if(!ro && isDirty && S.dirty[reg.name] === null && !reg.nullable)
        resetOne(reg);
      else render();
    };
    return (
      <div class="rb-val-wrap">
        <input class={cls("rb-val", isDirty && "dirty",
            Reg.outOfRange(reg, value) && "oor",
            na && !isDirty && "na")}
          type="text"
          value={na ? "null" : Reg.display(reg, value)}
          placeholder="-"
          disabled={ro}
          onFocus={(e) => na && e.target.select()}
          onInput={(e) => !ro && editSilent(reg, Reg.parse(reg, e.target.value))}
          onKeyDown={(e) => { if(e.key === "Enter") e.target.blur(); }}
          onBlur={onBlur} />
        {reg.nullable && !ro && !Reg.isInactive(reg) && <NullCheckbox reg={reg} />}
        {isDirty &&
          <button class="rb-val-reset" onClick={() => resetOne(reg)} title="Discard">✕</button>}
      </div>
    );
  },

  // Dispatcher: route to the right variant by register type.
  For: (props) => {
    if(Reg.isEnum(props.reg)) return <Control.Enum {...props} />;
    if(Reg.isBool(props.reg)) return <Control.Bool {...props} />;
    if(Reg.isVer(props.reg))  return <Control.Ver  {...props} />;
    return <Control.Input {...props} />;
  },
};
