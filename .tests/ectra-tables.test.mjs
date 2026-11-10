// .tests/ectra-tables.test.mjs

// Curves written to the drive from `EctraTables`.
// A gesture is one batch of points, undo writes back the curve that stood before it,
// and the history ends with the connection it was made on.
// Each keeps a table sane on a running drive: a wrong undo writes a curve nobody drew,
// and an undo carried over to another drive writes it someone else's.
// The device is a stand-in that keeps what it is sent, or refuses.

import { createApp, LOGIC, ok, eq, settle, done } from "./harness.mjs";

// A table as the map has it: points named by frequency, 0.1V steps, bounded
const VOLT = [0, 2, 5, 10, 20].map((hz, i) => ({ id: 100 + i, name: `Volt:${hz}Hz`,
  type: "uint", rws: "RWs", unit: "V", scale: 10, min: 0, max: 400, span: [0, 0xFFFF] }));

// The curve on the drive, with a spike at 2Hz
const STANDING = [20, 60, 40, 50, 80];

// One smoothing pass of it: each inner point halfway to the chord of its neighbours,
// weighted by their Hz, on the 0.1V quantum.
// At 2Hz the chord from 20 at 0Hz to 40 at 5Hz stands at 28, so 60 comes down to 44.
const SMOOTHED = [20, 44, 48.1, 51.7, 80];

// The panel connected to drive 1 on COM3, the table standing on the drive
function setup({ autosend = true, write } = {}) {
  const app = createApp({ write });
  const { S, EctraTables, ecQuant } =
    app.load([...LOGIC, "scripts/widgets/ectra-tables.jsx"], ["S", "EctraTables", "ecQuant"]);
  S.regs = VOLT;
  S.connected = true;
  S.port = "COM3";
  S.addr = 1;
  S.serial.autosend = autosend;
  VOLT.forEach((reg, i) => { S.values[reg.name] = STANDING[i]; });
  return { app, S, tables: EctraTables, ecQuant };
}

// A button of the panel as it renders, found by its title or its text
function button(tables, label) {
  const find = (node) => {
    if(!node || typeof node !== "object") return null;
    if(node.tag === "button"
      && (node.props.title === label || node.children.join("").trim() === label)) {
      return node.props;
    }
    for(const child of node.children) {
      const hit = find(child);
      if(hit) return hit;
    }
    return null;
  };
  return find(tables.View());
}

const UNDO = "Cofnij ostatni zapis", REDO = "Ponów", SMOOTH = "Wygładź";

const device = (S) => VOLT.map(reg => S.values[reg.name]);

// What the panel draws: the staged edit where there is one, the device value otherwise
const drawn = (S) => VOLT.map(reg =>
  Object.hasOwn(S.dirty, reg.name) ? S.dirty[reg.name] : S.values[reg.name]);
const writes = (app) => app.api.filter(([name]) => name === "write").map(([, patch]) => patch);

//-------------------------------------------------------------------------------------------- Undo

{
  const { app, S, tables } = setup();
  button(tables, SMOOTH).onClick();
  await settle();
  eq("a smoothing pass is one write, of the inner points only", writes(app).map(Object.keys),
    [["Volt:2Hz", "Volt:5Hz", "Volt:10Hz"]]);
  eq("each one halfway to its neighbours' chord, on the quantum", device(S), SMOOTHED);
  await button(tables, UNDO).onClick();
  eq("undo writes back the curve that stood", device(S), STANDING);
  await button(tables, REDO).onClick();
  eq("redo writes the pass again", device(S), SMOOTHED);
}

{
  const { app, S, tables } = setup({ autosend: false });
  button(tables, SMOOTH).onClick();
  await settle();
  ok("with auto-send off a pass waits with the other pending edits",
    writes(app).length === 0 && Object.keys(S.dirty).length === 3);
  await button(tables, UNDO).onClick();
  eq("and undoing it leaves nothing pending", Object.keys(S.dirty), []);
  await button(tables, REDO).onClick();
  eq("redo stages the pass again, not what the device still holds", drawn(S), SMOOTHED);
}

{
  const { tables } = setup({ write: () => ({ error: "no response" }) });
  button(tables, SMOOTH).onClick();
  await settle();
  ok("a write the drive refuses arms no undo", button(tables, UNDO).disabled);
}

//-------------------------------------------------------------------------------------- Connection

{
  const { S, tables } = setup();
  button(tables, SMOOTH).onClick();
  await settle();
  ok("a written pass can be undone", !button(tables, UNDO).disabled);
  S.addr = 2;
  ok("but not on another drive, whose curve it never was", button(tables, UNDO).disabled);
}

{
  const { app, S, tables } = setup();
  const { applyStatus } = app.load([], ["applyStatus"]);
  button(tables, SMOOTH).onClick();
  await settle();
  applyStatus({ connected: false, serial_open: true, port: "COM3" });
  applyStatus({ connected: true, serial_open: true, port: "COM3", addr: 1 });
  ok("nor after the link dropped and came back: the drive there may be another one",
    S.addr === 1 && button(tables, UNDO).disabled);
}

//----------------------------------------------------------------------------------------- Quantum

{
  const { ecQuant } = setup();
  // A drag writes through `writeNow`, which has no wrap check of its own:
  // this clamp is what keeps a pulled point a number the register can hold
  eq("a point pulled past its bounds lands on them, and between them on the 0.1V quantum",
    [ecQuant(VOLT[1], 512.34), ecQuant(VOLT[1], -3), ecQuant(VOLT[1], 12.345)], [400, 0, 12.3]);
}

//-------------------------------------------------------------------------------------------- Gate

{
  const { tables } = setup();
  ok("a map with a Volt curve opens the panel", tables.match(VOLT));
  ok("a current setting of another device does not",
    !tables.match([{ id: 1, name: "Curr:Limit", type: "uint" }]));
}

done();
