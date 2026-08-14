// scripts/Control.jsx

// Type-specialized value controls. `For` dispatches; each variant takes
// `{reg, value, isDirty, ro}` and commits through `editSend()` / `editSilent()`.

// `dirty` recolors so a pending pick reads differently from a confirmed one.
const _btnClass = (isActive, isDirty) =>
  cls("rb-btn", isActive && "on", isDirty && isActive && "dirty");

// Shared by Bool and Input. No focus steal: blurring the row's input would
// autosend the value this toggle replaces.
const NullCheckbox = ({ reg }) => {
  const cur = reg.name in S.dirty ? S.dirty[reg.name] : S.values[reg.name];
  return (
    <label class="rb-null-cb" title="Send null"
      onMouseDown={(e) => e.preventDefault()}>
      <input type="checkbox" checked={cur == null} onChange={() => toggleNull(reg)} />
      null
    </label>
  );
};

// Hover reason a value is flagged; wrap outranks an advisory min/max miss.
// Undefined when clean so the row's metadata tooltip shows through.
function _valHint(reg, value) {
  const u = Reg.unit(reg);
  const suffix = u ? " " + u : "";
  if(Reg.willWrap(reg, value))
    return `Too large for the register: the device will store `
      + `${Reg.display(reg, Reg.wrapPreview(reg, value))}${suffix}, `
      + `not ${Reg.display(reg, value)}${suffix}. Lower the value.`;
  if(Reg.outOfRange(reg, value))
    return `Outside the allowed range ${Reg.min(reg)}..${Reg.max(reg)}${suffix}. `
      + `It will still be written; the device decides what to do.`;
  return undefined;
}

// Tab hops between register fields, skipping the row's action buttons. Blur may
// rebuild the DOM, so the destination is re-found by name and selected for overtype.
function _onValKeyDown(e) {
  if(e.key === "Enter") { e.target.blur(); return; }
  if(e.key !== "Tab") return;
  const inputs = [...document.querySelectorAll("input.rb-val:not([disabled])")];
  const dest = inputs[inputs.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
  if(!dest) return;
  e.preventDefault();
  const name = dest.dataset.reg;
  e.target.blur();
  const el = valInput(name);
  if(el) { el.focus(); el.select(); }
}

const Control = {

  // The 0/off/none button is styled apart from the meaningful states.
  Enum: ({ reg, value, isDirty, ro }) => (
    <div class="rb-btns">
      {Object.entries(reg.enum).map(([k, v]) => (
        <button class={cls(_btnClass(value === v, isDirty), k === "0" && "zero")}
          disabled={ro}
          onClick={() => !ro && editSend(reg, v)}
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
        <button class={cls(_btnClass(lowOn, isDirty && value === false), "zero")} disabled={ro}
          onClick={() => !ro && editSend(reg, false)}>LOW</button>
        <button class={_btnClass(value === true, isDirty)} disabled={ro}
          onClick={() => !ro && editSend(reg, true)}>HIGH</button>
        {reg.nullable && !ro && <NullCheckbox reg={reg} />}
      </div>
    );
  },

  // Multi-select bit mask; R/O status words reuse the same buttons, disabled.
  Bits: ({ reg, value, isDirty, ro }) => {
    if(ro && Reg.isNA(reg, value)) return <span class="rb-ro na">null</span>;
    const mask = value ?? 0;
    return (
      <div class="rb-btns">
        {Object.entries(reg.bits).map(([k, name]) => (
          <button class={_btnClass((mask >> Number(k)) & 1, isDirty)} disabled={ro}
            onClick={() => !ro && editSend(reg, mask ^ (1 << Number(k)))}
          >{name}</button>
        ))}
      </div>
    );
  },

  // Always read-only.
  Ver: ({ reg, value }) => (
    <span class="rb-ro">{Reg.display(reg, value) || "-"}</span>
  ),

  // `editSilent` defers render until blur.
  Input: ({ reg, value, isDirty, ro }) => {
    const na = Reg.isNA(reg, value);
    // Non-nullable blank discards the edit; nullable blank commits null.
    // The unconditional render normalizes the field without waiting for the ack.
    // A mechanical blur (rebuild-driven, or already detached) is not the user
    // leaving: acting on it would autosend a half-typed value and re-enter render().
    const onBlur = (e) => {
      if(isRendering() || !e.target.isConnected) return;
      if(!ro && reg.name in S.dirty && S.dirty[reg.name] === null && !reg.nullable)
        resetOne(reg);
      else {
        if(shouldAutosend(reg)) autosendOne(reg);
        render();
      }
    };
    return (
      <div class="rb-val-wrap">
        <input class={cls("rb-val", isDirty && "dirty",
            Reg.outOfRange(reg, value) && "oor",
            Reg.willWrap(reg, value) && "wrap",
            na && !isDirty && "na")}
          type="text"
          data-reg={reg.name}
          title={_valHint(reg, value)}
          value={na ? "null" : Reg.display(reg, value)}
          placeholder="-"
          disabled={ro}
          onFocus={(e) => na && e.target.select()}
          onInput={(e) => !ro && editSilent(reg, Reg.parse(reg, e.target.value))}
          onKeyDown={_onValKeyDown}
          onBlur={onBlur} />
        {reg.nullable && !ro && !Reg.isInactive(reg) && <NullCheckbox reg={reg} />}
        {/* preventDefault: discarding must not blur-autosend the discarded value */}
        {isDirty &&
          <button class="rb-val-reset" title="Discard"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => resetOne(reg)}>✕</button>}
      </div>
    );
  },

  For: (props) => {
    if(Reg.isEnum(props.reg)) return <Control.Enum {...props} />;
    if(Reg.isBool(props.reg)) return <Control.Bool {...props} />;
    if(Reg.isVer(props.reg)) return <Control.Ver {...props} />;
    if(Reg.isBits(props.reg)) return <Control.Bits {...props} />;
    return <Control.Input {...props} />;
  },
};
