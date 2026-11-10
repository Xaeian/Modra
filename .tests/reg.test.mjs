// .tests/reg.test.mjs

// What an operator types and what the drive ends up keeping.
// Every value on its way to the device passes `Reg`: it reads the field, picks the slot
// a rule register is in, and judges whether the number fits the 16 bits it is squeezed into.
// A mistake here throws nothing. It writes a different number to a running drive,
// so each check below is one way a wrong number would get there.
// Registers are shaped as `reg_info()` hands them over, the setpoint as the map's own rule.

import { createApp, ok, eq, done } from "./harness.mjs";

// The setpoint keeps a slot per label of `Ctrl:Mode`; `off` and `ai` have none
const MODE = { id: 0, name: "Ctrl:Mode", type: "enum", rws: "RWs",
  enum: { 0: "off", 1: "ai", 2: "%", 3: "rpm", 4: "Hz" } };
const SETPOINT = { id: 1, name: "Ctrl:Setpoint", type: "rule", rws: "RW",
  unit: ["rpm", "%", "Hz"], scale: [1, 100, 100], min: [0, 0, 0], max: [5000, 100, 300],
  rule: { switch: "Ctrl:Mode" } };
const WORD = { id: 2, name: "Pwm:Deadtime", type: "uint", rws: "RWs", unit: "ns", scale: 1,
  min: null, max: null };
const FREQ = { id: 3, name: "Foc:EntryFreq", type: "uint", rws: "RWs", unit: "Hz", scale: 100,
  min: null, max: null };
const TEMP = { id: 4, name: "Speed:DerateTemp", type: "int", rws: "RWs", unit: "°C", scale: 1,
  min: -40, max: null };
const CURRENT = { id: 5, name: "Estim:Id", type: "int", rws: "R", unit: "A", scale: 1000,
  min: null, max: null };
const FLAGS = { id: 6, name: "Foc:Flags", type: "bits", rws: "R", unit: null, scale: 1,
  min: null, max: null, bits: { 0: "limit", 1: "sat" } };
const KEY = { id: 7, name: "Auth:SecretKey", type: "uint", rws: "W", unit: null, scale: 1,
  min: null, max: null, rule: { pair: "high" } };

// `Reg` over these registers, the switch standing at `mode`
function setup({ mode = "Hz", connected = false } = {}) {
  const { S, Reg } = createApp().load(["scripts/sys/state.js", "scripts/helpers.js"],
    ["S", "Reg"]);
  S.regs = [MODE, SETPOINT, WORD, FREQ, TEMP, CURRENT, FLAGS, KEY];
  S.values["Ctrl:Mode"] = mode;
  S.connected = connected;
  return { S, Reg };
}

//------------------------------------------------------------------------------------------ Typing

{
  const { Reg } = setup();
  eq("a decimal comma keeps its fraction", Reg.parse(FREQ, "1,5"), 1.5);
  eq("and its sign", Reg.parse(TEMP, "-0,25"), -0.25);
  eq("a hex or binary prefix reads as one", [Reg.parse(WORD, "0x1F"), Reg.parse(WORD, "0b101")],
    [31, 5]);
  eq("a broken prefix is no value, never a NaN staged as an edit",
    [Reg.parse(WORD, "0xZZ"), Reg.parse(WORD, "0b2")], [null, null]);
  eq("a blank field is no value", Reg.parse(WORD, "  "), null);
  eq("a label stays a label for its register to map", Reg.parse(MODE, "rpm"), "rpm");
}

//------------------------------------------------------------------------------------------- Slots

{
  const { S, Reg } = setup({ mode: "Hz" });
  eq("a rule register takes the slot its switch names",
    [Reg.unit(SETPOINT), Reg.scale(SETPOINT), Reg.step(SETPOINT), Reg.max(SETPOINT)],
    ["Hz", 100, 0.01, 300]);
  S.values["Ctrl:Mode"] = "HZ";
  eq("whatever the case of the label", Reg.unit(SETPOINT), "Hz");
  S.values["Ctrl:Mode"] = "off";
  ok("a switch on a label with no slot leaves the register inactive",
    Reg.isInactive(SETPOINT) && Reg.unit(SETPOINT) === "");
}

{
  const { S, Reg } = setup({ mode: "Hz", connected: true });
  S.dirty["Ctrl:Mode"] = "rpm";
  eq("a staged switch moves the field to its slot at once", Reg.unit(SETPOINT), "rpm");
  eq("while a chart waits for the device to take it", Reg.unit(SETPOINT, true), "Hz");
  S.connected = false;
  eq("offline there is no device to wait for", Reg.unit(SETPOINT, true), "rpm");
}

//----------------------------------------------------------------------------------------- 16 bits

{
  const { Reg } = setup();
  // A value that fits, one that does not, and what the device keeps of the second
  const verdict = (reg, fits, wraps) =>
    [Reg.willWrap(reg, fits), Reg.willWrap(reg, wraps), Reg.wrapPreview(reg, wraps)];
  eq("a word holds 65535 and keeps 0 of 65536", verdict(WORD, 65535, 65536), [false, true, 0]);
  eq("a signed word holds -32768 and turns 32768 negative", verdict(TEMP, -32768, 32768),
    [false, true, -32768]);
  eq("the scale is part of the range: 655.35Hz fits, 655.36Hz comes back as 0",
    verdict(FREQ, 655.35, 655.36), [false, true, 0]);
  eq("a bit field ends at bit 15", verdict(FLAGS, 0xFFFF, 0x10000), [false, true, 0]);
  ok("a 32-bit pair is not judged by one word", !Reg.willWrap(KEY, 0x12345678));
}

{
  const { S, Reg } = setup({ mode: "Hz" });
  ok("3000 does not fit the setpoint in Hz", Reg.willWrap(SETPOINT, 3000));
  S.dirty["Ctrl:Mode"] = "rpm";
  ok("and fits once the switch is staged to rpm, the slot a write encodes it in",
    !Reg.willWrap(SETPOINT, 3000));
  S.dirty["Ctrl:Mode"] = "off";
  ok("an inactive register has no slot to judge it by", !Reg.willWrap(SETPOINT, 3000));
}

//------------------------------------------------------------------------------------------ Bounds

{
  const { S, Reg } = setup({ mode: "Hz" });
  ok("a side the map leaves open sets no limit, so a signed reading may go below zero",
    !Reg.outOfRange(CURRENT, -5) && !Reg.outOfRange(TEMP, 500));
  ok("a side it declares holds", Reg.outOfRange(TEMP, -41) && !Reg.outOfRange(TEMP, -40));
  ok("301 is past the setpoint in Hz", Reg.outOfRange(SETPOINT, 301));
  S.values["Ctrl:Mode"] = "rpm";
  ok("and well inside it in rpm", !Reg.outOfRange(SETPOINT, 301));
  S.values["Ctrl:Mode"] = "ai";
  ok("an inactive register is never out of range", !Reg.outOfRange(SETPOINT, 99999));
}

done();
