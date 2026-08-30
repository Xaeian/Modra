// scripts/Serial.jsx

// Serial config panel, toggled by the ☰ button on Toolbar.

const BAUD_OPTS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

const Serial = () => {

  const Field = ({ label, unit, children }) => (
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">{label}</span>
      {children}
      {unit && <span class="rb-cfg-unit">{unit}</span>}
    </label>
  );

  // Option type is sniffed from the first entry.
  const Sel = ({ k, opts }) => (
    <select class="rb-cfg-input" value={S.serial[k]}
      onChange={(e) => {
        const numericOpts = !isNaN(opts[0]);
        const raw = e.target.value;
        setSerial({ [k]: numericOpts ? parseInt(raw) : raw });
      }}>
      {opts.map(o => <option value={o}>{o}</option>)}
    </select>
  );

  // Parse on blur, not keypress, so the user can clear and retype without
  // hitting partial-parse states.
  const Num = ({ k, fallback }) => (
    <input class="rb-cfg-input rb-cfg-num" type="text" value={S.serial[k]}
      onKeyDown={(e) => { if(e.key === "Enter") e.target.blur(); }}
      onBlur={(e) => setSerial({ [k]: parseInt(e.target.value) || fallback })} />
  );

  return (
    <div class="rb-config">
      <Field label="Baud"><Sel k="baudrate" opts={BAUD_OPTS} /></Field>
      <Field label="Parity">
        <select class="rb-cfg-input" value={S.serial.parity}
          onChange={(e) => setSerial({ parity: e.target.value })}>
          <option value="N">None</option>
          <option value="E">Even</option>
          <option value="O">Odd</option>
        </select>
      </Field>
      <Field label="Stop"><Sel k="stopbits" opts={[1, 2]} /></Field>
      <Field label="Timeout" unit="ms"><Num k="timeout" fallback={1000} /></Field>
      <Field label="Interval" unit="ms"><Num k="interval" fallback={500} /></Field>
      <Field label="Retries"><Num k="retries" fallback={3} /></Field>
      <Field label="History" unit="days"><Num k="history" fallback={14} /></Field>

      <button class={cls("rb-tbtn", S.serial.autosend && "active")}
        onClick={() => setSerial({ autosend: !S.serial.autosend })}
        title="Send each value on Enter/Tab or click">
        auto-send
      </button>

      <button class={cls("rb-tbtn", S.searchHide && "active")}
        onClick={toggleSearchHide}
        title="Search hides non-matching rows; off fades them in place">
        🙈 hide
      </button>

      <button class={cls("rb-tbtn", S.searchStrict && "active")}
        onClick={toggleSearchStrict}
        title="Strict search: * ? patterns, | joins alternatives; off = fuzzy">
        *? strict
      </button>

      <div class="rb-cfg-sep" />

      <div class="rb-addr-scan">
        <input class="rb-cfg-input rb-addr-scan-input" type="text"
          placeholder="1,2-5,10" value={S.addrScanInput} disabled={!S.serial_open}
          onInput={(e) => { S.addrScanInput = e.target.value; }} />
        <button class="rb-tbtn" onClick={scanAddrs}
          disabled={!S.serial_open || S.addrScanning}>
          {S.addrScanning ? "⏳" : "🔍"} Scan
        </button>
        {S.addrScanResults !== null && (S.addrScanResults.length
          ? <div class="rb-addr-scan">
              <input class="rb-cfg-input rb-addr-scan-input" type="text"
                list="rb-addr-list" placeholder="select or type"
                onInput={(e) => {
                  const v = parseInt(e.target.value);
                  if(v >= 1 && v <= 247) {
                    S.addrInput = String(v);
                    toggleConnection();
                  }
                }} />
              <datalist id="rb-addr-list">
                {S.addrScanResults.map(a => <option value={a} />)}
              </datalist>
              <span class="rb-cfg-label">({S.addrScanResults.length} found)</span>
            </div>
          : <span class="rb-cfg-label">Nothing found</span>
        )}
      </div>

      <div class="rb-cfg-sep" />

      {/* The way back in once the startup prompt is switched off. */}
      <button class="rb-tbtn" onClick={pickMap} title="Load a register map">🗺 Map</button>
      <button class="rb-tbtn" onClick={importConfig}>📂 Import</button>
      <button class="rb-tbtn" onClick={exportConfigCSV}>💾 CSV</button>
      <button class="rb-tbtn" onClick={exportConfigINI}>💾 INI</button>

      {defaultRegs().length > 0 &&
        <div class="rb-cfg-field">
          {variantCount() > 1 &&
            <select class="rb-cfg-input" value={S.variant}
              title="Which variant the defaults are taken from"
              onChange={(e) => { S.variant = parseInt(e.target.value); render(); }}>
              {Array.from({ length: variantCount() }, (_, i) =>
                <option value={i}>{i + 1}</option>)}
            </select>}
          <button class="rb-tbtn" onClick={restoreDefaults}
            title="Stage all defaults as pending edits; review, then Send">
            🏭 Defaults
          </button>
        </div>}

      <div class="rb-cfg-sep" />

      <button class="rb-tbtn rb-danger" onClick={deleteDatabase}
        title="Wipe stored history (data.db)">🧹 Clear DB</button>
    </div>
  );
};
