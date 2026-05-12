// scripts/sys/state.js

// Global mutable app state. Every mutation outside `applyStatus`/`applyCache`
// must be followed by `render()` - there is no reactive layer here.
// `serial_open` mirrors the backend flag; `serialOpen` toggles the Serial
// config panel in the UI. Unrelated despite the name.

const S = {

  //---------------------------------------------------------- Connection (backend mirror)

  ports: [],
  port: null,
  addr: null,
  connected: false,
  serial_open: false,
  serial: { baudrate: 9600, parity: "N", stopbits: 1, timeout: 1000, interval: 200 },

  //---------------------------------------------------------- Connection (UI inputs)

  // What the user typed before pressing Connect; copied to `port`/`addr`
  // once the backend confirms the connection.
  portInput: "",
  addrInput: "",
  busy: false,

  //---------------------------------------------------------- UI toggles

  showChart: false,
  serialOpen: false,    // Serial panel expanded (≠ backend `serial_open`)
  utilOpen: null,       // register name whose Misc panel is open, or null
  query: "",

  //---------------------------------------------------------- Data

  regs: [],
  values: {},
  dirty: {},

  //---------------------------------------------------------- Monitor

  monitor: new Set(),   // register names currently charted
  chartSizes: {},       // group key → "S"|"M"|"L"

  //---------------------------------------------------------- Ignore (server-mirrored)

  // Backend skips polling these; frontend hides rows unless `showDisabled`
  // is on. Mirror of `view.ignore` on disk.
  ignore: new Set(),
  showDisabled: false,  // reveal ignored rows inline with the active ones

  //---------------------------------------------------------- Address scan

  addrScanInput: "",
  addrScanResults: null,
  addrScanning: false,

  //---------------------------------------------------------- Errors

  errors: 0,
};
