// .tests/ectra-guide.test.mjs

// The Ectra guide against the register map shipped beside it, and its live note on readings
// made up here. Prose, topics and note all point into the map: names to link, light, chart
// and keep polling, labels to tell a state by, a table to ask the panel next door for.
// None of them fails when the firmware renames what it points at: a link turns plain,
// a trace goes missing, a sentence stays unsaid. So each kind is checked against the map.
// The map is the product's, copied in and not versioned here,
// so without it the suite says so and has nothing to check.

import fs from "node:fs";
import path from "node:path";
import { APP, createApp, ok, done } from "./harness.mjs";

const MAP = path.join(APP, "regs.csv");

if(!fs.existsSync(MAP)) {
  console.log("  no regs.csv beside the app: nothing to check the guide against");
  process.exit(0);
}

// One register a line; the columns up to `unit`, which holds an enum's labels, carry no quotes
const regs = new Map();
for(const line of fs.readFileSync(MAP, "utf8").split(/\r?\n/).slice(1)) {
  const [, , name, , type, unit] = line.split(",");
  if(name) regs.set(name, type?.endsWith("enum") ? unit.split(" ").map(l => l.split(":")[1]) : []);
}
const labels = (name) => regs.get(name) || [];

// The guide's calls into the app, recorded, and the panels that registered, by id
const calls = [], panels = {};
const S = { values: {} };
const app = createApp({ globals: {
  S,
  Reg: { byName: (name) => regs.has(name) },
  Widgets: {
    register: (widget) => { panels[widget.id] = widget; },
    focus: (query) => calls.push({ focus: query }),
    plot: (traces, big) => calls.push({ plot: traces, big }),
    mute: (groups, keep) => calls.push({ mute: groups, keep }),
    tell: (id, msg) => calls.push({ tell: id, msg }),
    release: () => calls.push({ release: true }),
    point: () => {},
    reveal: () => {},
  },
  cls: (...names) => names.filter(Boolean).join(" "),
} });
const {
  EC_TOPICS, EC_FAULTS, EC_FIND_ALWAYS, EC_ALWAYS, EC_BIG, EC_WATCH, EC_WHY, EC_EXIT, EC_FREEZE,
  ecNow,
} = app.load(["scripts/widgets/ectra-guide.jsx", "scripts/widgets/ectra-tables.jsx"], [
  "EC_TOPICS", "EC_FAULTS", "EC_FIND_ALWAYS", "EC_ALWAYS", "EC_BIG", "EC_WATCH", "EC_WHY",
  "EC_EXIT", "EC_FREEZE", "ecNow",
]);
const Ectra = panels["ectra-guide"];

// The `<b>` elements of a rendered tree; a link to a register in the map carries `ec-ref`
function bolds(node, out = []) {
  if(!node || typeof node !== "object") return out;
  if(node.tag === "b") out.push(node);
  for(const child of node.children || []) bolds(child, out);
  return out;
}

const named = (text) => text.match(/[A-Z][A-Za-z]*:[A-Za-z0-9]+/g) || [];

// What a check found wrong, a line each below it
function list(found) {
  if(found.length) console.log("    " + found.join("\n    "));
}

//------------------------------------------------------------------------------------------- Prose

ok("the widget registers itself and accepts the map", Ectra?.match([...regs.keys()]
  .map(name => ({ name }))));
let unknown = [];
for(const id of [null, ...EC_TOPICS.map(t => t.id)]) {
  Ectra._topic = id;
  unknown = unknown.concat(bolds(Ectra.View()).filter(b => b.props.class !== "ec-ref")
    .map(b => `${id || "intro"}: ${b.children.join("")}`));
}
ok("every register the prose names is in the map", unknown.length === 0);
list(unknown);

const dead = EC_TOPICS.flatMap(t => t.find.split("|").map(term => [t.id, term]))
  .concat(EC_FIND_ALWAYS.split("|").map(term => ["always", term]))
  .filter(([, term]) => ![...regs.keys()].some(name => name.includes(term)));
ok("every search term lights a register", dead.length === 0);
list(dead.map(d => d.join(": ")));

const codes = labels("Fault:Code").filter(label => label !== "ok");
const listed = EC_FAULTS.flatMap(f => f.codes);
ok("every Fault:Code has a paragraph", codes.every(c => listed.includes(c)));
ok("every paragraph lands on a topic",
  EC_FAULTS.every(f => EC_TOPICS.some(t => t.id === f.topic)));

//-------------------------------------------------------------------------------------- References

// `Widgets.plot` drops a name the map does not carry without a word, and the note reads nothing
// for one: a renamed register leaves a chart short or a sentence unsaid
const charted = [...EC_ALWAYS, ...EC_BIG, ...EC_TOPICS.flatMap(t => [...t.plot, ...t.big])];
const unread = [...new Set([...charted, ...EC_WATCH])].filter(name => !regs.has(name));
ok("every register charted, or read by the note, is in the map", unread.length === 0);
list(unread);

// The labels the note tells states apart by, the ones the scenarios below feed it included
const TOLD = {
  "Fault:Code": ["ok"],
  "Feedback:State": ["coa", "run"],
  "Drive:Mode": ["vf", "foc"],
  "Drive:Stage": ["forced", "closed", ...Object.keys(EC_WHY)],
  "Sync:ExitCause": Object.keys(EC_EXIT),
  "Freeze:State": ["off", ...Object.keys(EC_FREEZE)],
};
const renamed = Object.entries(TOLD).flatMap(([name, told]) => told
  .filter(label => !labels(name).includes(label))
  .map(label => `${name} = ${label}`));
ok("every label the note tells a state by is one the map lists", renamed.length === 0);
list(renamed);

// And the other way round: a reason the firmware adds is one the note cannot give.
// Below `catch` a stage says why the V/f table drives the bridge, `off` and `fault` aside.
const stages = labels("Drive:Stage");
const reasons = stages.slice(stages.indexOf("off") + 1, stages.indexOf("catch"))
  .filter(label => label !== "fault");
ok("every reason Drive:Stage gives for the V/f table has a sentence",
  reasons.length > 0 && reasons.every(label => Object.hasOwn(EC_WHY, label)));
ok("and every cause Sync:ExitCause gives for a lost loop", labels("Sync:ExitCause")
  .filter(label => label !== "none").every(label => Object.hasOwn(EC_EXIT, label)));

//------------------------------------------------------------------------------------------ Topics

const topic = EC_TOPICS.find(t => t.table);
Ectra._topic = null;
calls.length = 0;
Ectra.pick(topic.id);
const focus = calls.find(c => c.focus), mute = calls.find(c => c.mute);
ok("a topic lights its registers beside the ones lit always",
  focus?.focus === EC_FIND_ALWAYS + "|" + topic.find);
ok("and keeps every register its prose names arriving",
  named(topic.text).every(name => mute?.keep.includes(name)));
ok("and asks the panel next door for its table", calls.some(c => c.tell === "ectra-tables"
  && c.msg.table === topic.table));
ok("a table a topic asks for is one the panel opens", EC_TOPICS.filter(t => t.table)
  .every(t => panels["ectra-tables"].receive({ table: t.table })));
calls.length = 0;
Ectra.pick(topic.id);
ok("picked again, it hands the view back", calls.some(c => c.release) && Ectra._topic === null);

//--------------------------------------------------------------------------------------- Live note

function note(values) {
  S.values = { "Fault:Code": "ok", "Feedback:State": "run", "Drive:Mode": "foc",
    "Drive:Stage": "closed", "Freeze:State": "off", ...values };
  return ecNow().join(" ");
}

const sync = note({ "Fault:Code": "sync", "Sync:ExitCause": "slip" });
ok("an active fault is quoted with its cause", sync.startsWith("Fault:Code = sync.")
  && sync.includes("Sync:ExitCause = slip:"));
ok("nothing holds a drive running free", note({}) === "");
const freezes = labels("Freeze:State").filter(label => label !== "off");
const said = freezes.map(state => note({ "Freeze:State": state }));
ok("every Freeze:State but off has its own sentence",
  said.every(Boolean) && new Set(said).size === freezes.length);
for(const stage of Object.keys(EC_WHY)) {
  ok(`Drive:Stage = ${stage} says why the table drives the bridge`,
    note({ "Drive:Stage": stage }).startsWith(`Drive:Stage = ${stage}:`));
}
ok("Drive:Mode = vf is no news", note({ "Drive:Mode": "vf", "Drive:Stage": "off" }) === "");
ok("a coast is said", note({ "Feedback:State": "coa" }).startsWith("Silnik wybiega."));
const waiting = note({ "Drive:Stage": "forced", "Foc:EntryFreq": 45, "Feedback:RenderFreq": 45.05,
  "Sync:Lock": 12, "Sync:ErrPeak": 70, "Foc:LockErr": 60 });
ok("the wait at the takeover point counts the lock and names a wide error",
  waiting.includes("Sync:Lock wynosi 12 z 40.") && waiting.includes("Sync:ErrPeak przekracza"));
ok("current derating is said", note({ "Meas:CurrAvg": 3.9, "Speed:DerateCurr": 3.8 })
  .includes("Prędkość ograniczona prądem"));
ok("so is temperature derating", note({ "Meas:Temp": 81, "Speed:DerateTemp": 80 })
  .includes("Prędkość ograniczona temperaturą"));
Ectra._topic = null;
ok("the note renders above the prose with its names as links",
  bolds(Ectra.View()).some(b => b.props.class === "ec-ref"
    && b.children.join("") === "Speed:DerateTemp"));

done();
