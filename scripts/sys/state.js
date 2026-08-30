// scripts/sys/state.js

// No reactive layer: every mutation outside `applyStatus`/`applyCache` must call `render()`.

const S = {

  //------------------------------------------------------------------- Connection (backend mirror)

  ports: [],
  port: null,
  addr: null,
  connected: false,
  serial_open: false,
  serial: {
    baudrate: 9600, parity: "N", stopbits: 1, timeout: 1000,
    retries: 3, interval: 500, history: 14, autosend: false,
  },

  //------------------------------------------------------------------------ Connection (UI inputs)

  // What the user typed; copied to `port`/`addr` once the backend confirms.
  portInput: "",
  addrInput: "",
  busy: false,

  //------------------------------------------------------------------------------------ UI toggles

  showChart: false,
  mapPrompt: false,     // startup map prompt is on screen
  askMap: true,         // re-prompt on every start (mirrors view.json)
  widgetsOn: new Set(), // ids of the widget panels the operator has open
  serialOpen: false,    // Serial panel expanded (≠ backend `serial_open`)
  utilOpen: null,       // register name whose Misc panel is open, or null
  query: "",
  searchHide: false,    // search drops the misses instead of fading them
  searchStrict: false,  // glob matching (* ? |) instead of fuzzy

  //------------------------------------------------------------------------------------------ Data

  regs: [],
  values: {},
  dirty: {},
  variant: 0, // which `default` slot a restore stages from

  //--------------------------------------------------------------------------------------- Monitor

  monitor: new Set(),  // register names currently charted
  pointed: null,       // register a widget is pointing at, flashed in the grid
  chartSizes: {},      // group key → "S"|"M"|"L"

  //---------------------------------------------------------------------- Ignore (server-mirrored)

  // Backend skips polling these. Mirror of `view.ignore` on disk.
  ignore: new Set(),
  showDisabled: false, // reveal ignored rows inline with the active ones

  //---------------------------------------------------------------------------------- Address scan

  addrScanInput: "",
  addrScanResults: null,
  addrScanning: false,
};
