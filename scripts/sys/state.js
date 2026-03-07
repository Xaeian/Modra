// state.js

const S = {
  regs: [], values: {}, dirty: {},
  monitor: new Set(),
  showChart: false, showRegs: true,
  utilOpen: null,
  query: '',
  ports: [], port: null, addr: null, connected: false, serial_open: false,
  portInput: '', addrInput: '', busy: false,
  serialOpen: false,
  serial: { baudrate: 9600, parity: 'N', stopbits: 1, timeout: 1000, interval: 200 },
  config: {},
  addrScanInput: '',
  addrScanResults: null,
  addrScanning: false,
  errors: 0,
};