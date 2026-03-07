const Serial = () => {
  const F = ({label, unit, children}) => (
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">{label}</span>
      {children}
      {unit && <span class="rb-cfg-unit">{unit}</span>}
    </label>
  );
  const Sel = ({k, opts}) => (
    <select class="rb-cfg-input" value={S.serial[k]}
      onChange={(e) => setSerial({[k]: isNaN(opts[0]) ? e.target.value : parseInt(e.target.value)})}>
      {opts.map(o => <option value={o}>{o}</option>)}
    </select>
  );
  const Num = ({k, fallback}) => (
    <input class="rb-cfg-input rb-cfg-num" type="text" value={S.serial[k]}
      onBlur={(e) => setSerial({[k]: parseInt(e.target.value) || fallback})} />
  );
  return (
    <div class="rb-config">
      <F label="Baud"><Sel k="baudrate" opts={[1200,2400,4800,9600,19200,38400,57600,115200]} /></F>
      <F label="Parity">
        <select class="rb-cfg-input" value={S.serial.parity}
          onChange={(e) => setSerial({parity: e.target.value})}>
          <option value="N">None</option><option value="E">Even</option><option value="O">Odd</option>
        </select>
      </F>
      <F label="Stop"><Sel k="stopbits" opts={[1, 2]} /></F>
      <F label="Timeout" unit="ms"><Num k="timeout" fallback={1000} /></F>
      <F label="Wait" unit="ms"><Num k="interval" fallback={0} /></F>
      <div class="rb-cfg-sep" />
      <div class="rb-addr-scan">
        <input class="rb-cfg-input rb-addr-scan-input" type="text"
          placeholder="1,2-5,10" value={S.addrScanInput} disabled={!S.serial_open}
          onInput={(e) => { S.addrScanInput = e.target.value; }} />
        <button class="rb-tbtn" onClick={scanAddrs}
          disabled={!S.serial_open || S.addrScanning}>
          {S.addrScanning ? '⏳' : '🔍'} Scan
        </button>
        {S.addrScanResults !== null && (S.addrScanResults.length
          ? <div class="rb-addr-scan-result">
              <input class="rb-cfg-input rb-addr-scan-input" type="text"
                list="rb-addr-list" placeholder="select or type"
                onInput={(e) => {
                  const v = parseInt(e.target.value);
                  if(v >= 1 && v <= 247) { S.addrInput = String(v); toggleConnection(); }
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
      <button class="rb-tbtn" onClick={importConfig}>📂 Import</button>
      <button class="rb-tbtn" onClick={exportConfigCSV}>💾 CSV</button>
      <button class="rb-tbtn" onClick={exportConfigINI}>💾 INI</button>
    </div>
  );
};