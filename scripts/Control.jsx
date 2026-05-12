// scripts/Control.jsx

// Type-specialized value controls. `For` dispatches; each variant takes
// `{reg, value, isDirty, ro}` and commits through `edit()` / `editSilent()`.

// Highlight when the candidate matches the current value. `dirty` recolors
// so a pending pick reads differently from a confirmed one.
const _btnClass = (isActive, isDirty) =>
  cls("rb-btn", isActive && "on", isDirty && isActive && "dirty");

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

  // `null` (never polled) renders as LOW so the UI shows a defined state
  // instead of an ambiguous "neither".
  Bool: ({ reg, value, isDirty, ro }) => (
    <div class="rb-btns">
      <button class={_btnClass(value === true, isDirty)}
        disabled={ro} onClick={() => !ro && edit(reg, true)}
      >HIGH</button>
      <button class={_btnClass(value === false || value == null, isDirty && value === false)}
        disabled={ro} onClick={() => !ro && edit(reg, false)}
      >LOW</button>
    </div>
  ),

  // Version string from `Reg.display` (X.YY.ZZ). Always read-only.
  Ver: ({ reg, value }) => (
    <span class="rb-ro">{Reg.display(reg, value) || "-"}</span>
  ),

  // Free-text input for numerics. `editSilent` during typing avoids
  // render-per-keystroke; commit happens on blur. Blank-then-blur drops the
  // dirty entry rather than writing null.
  Input: ({ reg, value, isDirty, ro }) => (
    <div class="rb-val-wrap">
      <input class={cls("rb-val", isDirty && "dirty", Reg.outOfRange(reg, value) && "oor")}
        type="text"
        value={Reg.display(reg, value)}
        placeholder="-"
        disabled={ro}
        onInput={(e) => !ro && editSilent(reg, Reg.parse(reg, e.target.value))}
        onBlur={() => {
          if(!ro && isDirty && S.dirty[reg.name] === null) resetOne(reg);
          else render();
        }} />
      {isDirty &&
        <button class="rb-val-reset" onClick={() => resetOne(reg)} title="Discard">✕</button>}
    </div>
  ),

  // Dispatcher: route to the right variant by register type.
  For: (props) => {
    if(Reg.isEnum(props.reg)) return <Control.Enum {...props} />;
    if(Reg.isBool(props.reg)) return <Control.Bool {...props} />;
    if(Reg.isVer(props.reg))  return <Control.Ver  {...props} />;
    return <Control.Input {...props} />;
  },
};
