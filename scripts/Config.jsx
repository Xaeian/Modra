// scripts/Config.jsx

const Config = () => (
  <div class="rb-config">
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">Baud</span>
      <select class="rb-cfg-input" value={S.serial.baudrate}
        onChange={(e) => setSerial({baudrate: parseInt(e.target.value)})}>
        {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b =>
          <option value={b}>{b}</option>
        )}
      </select>
    </label>
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">Parity</span>
      <select class="rb-cfg-input" value={S.serial.parity}
        onChange={(e) => setSerial({parity: e.target.value})}>
        <option value="N">None</option>
        <option value="E">Even</option>
        <option value="O">Odd</option>
      </select>
    </label>
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">Stop</span>
      <select class="rb-cfg-input" value={S.serial.stopbits}
        onChange={(e) => setSerial({stopbits: parseInt(e.target.value)})}>
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
    </label>
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">Timeout</span>
      <input class="rb-cfg-input rb-cfg-num" type="text" value={S.serial.timeout}
        onBlur={(e) => setSerial({timeout: parseInt(e.target.value) || 1000})} />
      <span class="rb-cfg-unit">ms</span>
    </label>
    <label class="rb-cfg-field">
      <span class="rb-cfg-label">Wait</span>
      <input class="rb-cfg-input rb-cfg-num" type="text" value={S.serial.interval}
        onBlur={(e) => setSerial({interval: parseInt(e.target.value) || 0})} />
      <span class="rb-cfg-unit">ms</span>
    </label>
  </div>
);