// .tests/view.test.mjs

// The operator's own view: what they ignore, what they chart, what they search for.
// It is theirs and it outlives the session, the ignore list in `view.json` above all,
// and two things touch it without being asked to:
// a save, which folds names into patterns and back,
// and a widget, which borrows the view for a topic and promises to hand it back.
// Either one slipping shows as rows that quietly stop updating, or as charts gone missing.

import { createApp, createStorage, LOGIC, ok, eq, done } from "./harness.mjs";

// Groups as a map has them: one under a hand-written pattern, two a topic mutes,
// one register alone in its group, and the ones a topic charts
const NAMES = [
  "Ctrl:Mode", "Ctrl:Setpoint", "Motor:Rs", "Motor:Ke",
  "Journal:Count", "Journal:Entry0", "Journal:Entry1",
  "Counter:Link", "Counter:RS485", "RS485:Baud", "Version:Software",
];

// What `view.json` holds for the operator: one ignored register, one trace on a tall panel
const OWN = { ignore: ["Version:Software"], monitor: [{ traces: ["Motor:Rs"], size: "L" }] };

const sorted = (names) => [...names].sort();

// The app started on `names`, with `view` read as `app.jsx` reads `view.json`
function boot({ names = NAMES, view = {}, storage } = {}) {
  const app = createApp({ storage });
  const fns = app.load(LOGIC,
    ["S", "Reg", "Widgets", "chartGroupKey", "expandIgnore", "collapseIgnore", "toggleIgnore"]);
  const { S, Reg, chartGroupKey, expandIgnore } = fns;
  S.regs = names.map((name, id) =>
    ({ id, name, type: "uint", rws: "RW", unit: "", scale: 1, min: null, max: null }));
  S.ignore = expandIgnore(view.ignore || []);
  for(const panel of view.monitor || []) {
    for(const name of panel.traces) S.monitor.add(name);
    S.chartSizes[chartGroupKey(Reg.byName(panel.traces[0]))] = panel.size;
  }
  S.showChart = S.monitor.size > 0;
  return { app, ...fns };
}

// `view.json` once the pending save has gone out: each save patches what it carries
function saved(app) {
  app.flush();
  const patches = app.api.filter(([name]) => name === "view_set").map(([, patch]) => patch);
  const view = Object.assign({}, ...patches);
  return { ignore: view.ignore, monitor: view.monitor };
}

// The parts of the view a widget borrows, copied out, since `plot` resizes panels in place
const view = (S) => ({ query: S.query, strict: S.searchStrict, monitor: sorted(S.monitor),
  chart: S.showChart, sizes: { ...S.chartSizes }, ignore: sorted(S.ignore) });

// A topic as the guide drives one: light its registers, chart two of them,
// mute two groups but spare the register it names
function topic(Widgets) {
  Widgets.focus("Ctrl:|Journal:Count");
  Widgets.plot(["Ctrl:Setpoint", "Journal:Count"], ["Ctrl:Setpoint"]);
  Widgets.mute(["Journal:*", "Counter:*"], ["Journal:Count"]);
}

//------------------------------------------------------------------------------------------- Saves

{
  const { app, S, Reg, expandIgnore, collapseIgnore, toggleIgnore } =
    boot({ view: { ignore: ["Journal:*"] } });
  eq("a hand-written pattern ignores every register it covers", sorted(S.ignore),
    ["Journal:Count", "Journal:Entry0", "Journal:Entry1"]);
  eq("and a save writes it back as written", collapseIgnore(), ["Journal:*"]);
  toggleIgnore(Reg.byName("Journal:Count"));
  const { ignore } = saved(app);
  eq("a register taken out of it saves the rest by name", ignore,
    ["Journal:Entry0", "Journal:Entry1"]);
  ok("so the next start polls that one", !expandIgnore(ignore).has("Journal:Count"));
}

{
  const { app, Reg, toggleIgnore } = boot();
  toggleIgnore(Reg.byName("Counter:Link"));
  toggleIgnore(Reg.byName("Counter:RS485"));
  const { ignore } = saved(app);
  eq("a group ignored name by name is saved as its pattern", ignore, ["Counter:*"]);
  const next = boot({ names: [...NAMES, "Counter:Watchdog"], view: { ignore } });
  ok("which covers a register the next map adds to that group",
    next.S.ignore.has("Counter:Watchdog"));
}

{
  const { S, expandIgnore, collapseIgnore } = boot();
  const drift = [];
  // Every subset of the map, register `i` in it when bit `i` of `mask` is set
  for(let mask = 0; mask < 2 ** NAMES.length; mask++) {
    const want = NAMES.filter((name, i) => Math.floor(mask / 2 ** i) % 2);
    S.ignore = new Set(want);
    const back = expandIgnore(collapseIgnore());
    if(back.size !== want.length || want.some(name => !back.has(name))) drift.push(want);
  }
  ok("every ignore list reads back from its save as the same list", drift.length === 0);
  if(drift.length) console.log("    " + drift.slice(0, 5).map(d => d.join(" ")).join("\n    "));
}

//----------------------------------------------------------------------------------------- Widgets

{
  const { app, S, Widgets } = boot({ view: OWN });
  S.query = "Motor";
  const own = view(S);
  topic(Widgets);
  ok("a topic polls the register it names, though its own pattern covers the group",
    !S.ignore.has("Journal:Count") && S.ignore.has("Journal:Entry0"));
  ok("and leaves alone what the operator ignored", S.ignore.has("Version:Software"));
  Widgets.release();
  eq("released, the view is the operator's again", view(S), own);
  eq("and so is what the next start reads", saved(app), OWN);
}

{
  const { S, Widgets } = boot({ view: OWN });
  S.query = "Motor";
  const own = view(S);
  topic(Widgets);
  Widgets.focus("Motor:");
  Widgets.plot(["Motor:Ke"], []);
  Widgets.mute(["Counter:*"], ["Motor:Ke"]);
  Widgets.release();
  eq("two topics in a row hand back the operator's view, not the first topic's", view(S), own);
}

{
  const storage = createStorage();
  const first = boot({ view: OWN, storage });
  first.S.query = "Motor";
  const own = view(first.S);
  topic(first.Widgets);
  // Closed while the topic holds the view: `view.json` is the topic's, the browser kept the rest
  const next = boot({ view: saved(first.app), storage });
  next.Widgets.release();
  eq("closed and started again mid-topic, the view still comes back", view(next.S), own);
}

{
  const { S, Widgets } = boot({ view: { ignore: ["Journal:Count", "Motor:Ke"] } });
  Widgets.mute(["Counter:*"], ["Journal:Count"]);
  ok("a register a topic names is polled even where the operator ignored it",
    !S.ignore.has("Journal:Count"));
  Widgets.plot(["Motor:Ke"], []);
  ok("and so is one it charts, which would otherwise draw a flat line",
    !S.ignore.has("Motor:Ke"));
  Widgets.release();
  ok("released, both are ignored again",
    S.ignore.has("Journal:Count") && S.ignore.has("Motor:Ke"));
}

done();
