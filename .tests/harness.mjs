// .tests/harness.mjs

// What the suites here share: the app's own files run as the bundle carries them,
// in a vm context of stand-ins for whatever lies outside those files, and one tally.
// A file reads as `build` leaves it: `{{vars}}` filled from `app.ini`, a `.jsx` through Babel.
// Its top-level names stay in scope for the next file, as between the script tags of a page.
// A context is made per scenario, so no scenario inherits another's state.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadBabel, JSX_OPTIONS, parseIni, replaceVars } from "../../utils.js";

/** The app folder, one above this one. */
export const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The logic under the views, in bundle order: every `.js` before any `.jsx`,
 * deeper folders first, alphabetical inside.
 * The backend client and the toasts are left to the stand-ins of `createApp`.
 */
export const LOGIC = [
  "scripts/sys/state.js", "scripts/sys/widgets.js",
  "scripts/actions.js", "scripts/helpers.js", "scripts/monitor.js", "scripts/poll.js",
];

//-------------------------------------------------------------------------------------------- Load

const { babel, jsxPlugin } = await loadBabel();
const ini = parseIni(fs.readFileSync(path.join(APP, "app.ini"), "utf8"));
const VARS = { ...ini[""], ...ini.build };
const compiled = new Map(); // path -> script, compiled once and run in every context that asks

// A file of the app as the bundle carries it, ready to run
function script(rel) {
  if(compiled.has(rel)) return compiled.get(rel);
  let code = replaceVars(fs.readFileSync(path.join(APP, rel), "utf8"), VARS);
  if(rel.endsWith(".jsx")) {
    code = babel.transformSync(code, {
      filename: path.basename(rel), babelrc: false, configFile: false, sourceType: "unambiguous",
      plugins: [[jsxPlugin, JSX_OPTIONS]],
    }).code;
  }
  compiled.set(rel, new vm.Script(code, { filename: rel }));
  return compiled.get(rel);
}

//--------------------------------------------------------------------------------------- Stand-ins

/**
 * What a component builds: a function tag runs, any other tag becomes a plain node.
 * A ref never fires, so a view renders without a page.
 */
export const JSX = {
  createElement: (tag, props, ...children) => typeof tag === "function"
    ? tag({ ...props, children })
    : { tag, props: props || {}, children: children.flat(Infinity) },
  Fragment: "fragment",
};

/**
 * Browser storage in a map.
 * Two apps handed the same one share it, as an app started again shares the browser's.
 */
export function createStorage() {
  const items = new Map();
  return {
    getItem: (key) => items.has(key) ? items.get(key) : null,
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

/**
 * A context for the app's files, with the page, the backend, the toasts and the chart host
 * stood in. What the app sends out is kept as `[name, ...args]`: backend calls in `api`,
 * toasts in `toasts`. A timer waits for `flush()`, so a debounced save lands when a suite says.
 * @param {object} [opts]
 * @param {object} [opts.storage] from `createStorage`, a fresh one by default
 * @param {(patch: object) => object} [opts.write] the device's answer to a write,
 *   the values it was sent by default
 * @param {object} [opts.globals] added to the context, or put in place of a stand-in
 * @returns {{ ctx, api, toasts, flush, load }}
 */
export function createApp({ storage = createStorage(), write = (patch) => patch,
  globals = {} } = {}) {
  const api = [], toasts = [];
  const timers = new Map();
  let nextTimer = 1;
  const toast = (kind) => (text) => { toasts.push([kind, text]); };
  const ctx = vm.createContext({
    console, JSX,
    render() {},
    document: { addEventListener() {}, querySelector: () => null },
    CSS: { escape: (s) => s },
    localStorage: storage,
    setTimeout: (fn) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id) => { timers.delete(id); },
    alert: { ok: toast("ok"), inf: toast("inf"), wrn: toast("wrn"), err: toast("err") },
    API: {
      view_set: async (patch) => { api.push(["view_set", patch]); return {}; },
      write: async (patch) => { api.push(["write", patch]); return write(patch); },
    },
    Monitor: { mount() {}, refresh() {}, refetch() {} },
    ...globals,
  });

  // Every timer due, in the order it was set
  function flush() {
    for(const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  }

  /**
   * Files of the app run in this context in the order given, then the names a suite reads.
   * A `const` at the top of a file is no property of the context, so they are read inside it.
   * @param {string[]} files paths under the app, `scripts/helpers.js`
   * @param {string[]} names top-level names to hand back, `Reg`
   * @returns {object} each name to its value
   */
  function load(files, names) {
    for(const rel of files) script(rel).runInContext(ctx);
    return vm.runInContext(`({ ${names.join(", ")} })`, ctx);
  }

  return { ctx, api, toasts, flush, load };
}

//-------------------------------------------------------------------------------------- Assertions

let pass = 0, fail = 0; // one tally, one exit code

/** One check: its line, and a place in the tally. */
export function ok(name, cond) {
  if(cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
}

// A value as a check shows it: JSON, but a NaN or an `undefined` is not taken for a `null`
const shown = (value) => JSON.stringify(value, (key, v) => v === undefined ? "undefined"
  : typeof v === "number" && !Number.isFinite(v) ? String(v) : v);

/** A check of a value, shown beside the expected one when they differ. */
export function eq(name, actual, expected) {
  const got = shown(actual), want = shown(expected);
  ok(name, got === want);
  if(got !== want) console.log(`    got  ${got}\n    want ${want}`);
}

/** Every promise a call left running, settled. */
export async function settle() {
  for(let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve));
}

/** The tally, and the exit code `tonka test` reads it by. */
export function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
