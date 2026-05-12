// scripts/helpers.js

// Pure helpers shared by the UI. `cls()` joins class strings, `Reg.*` wraps
// register-shaped data. Reads `S.dirty` / `S.values` for rule resolution but
// never writes back.

//---------------------------------------------------------- DOM helpers

// Falsy mods drop out, so callers can write `cls("btn", on && "on")` without
// polluting the output with literal "false" tokens.
function cls(base, ...mods) {
  let out = base;
  for(const m of mods) if(m) out += " " + m;
  return out;
}

//---------------------------------------------------------- Register helpers

const Reg = (() => {

  //---------------------------------------------------------- Internal

  // Pick the slot indexed by the active rule index for per-slot props
  // (unit/scale/min/max). Non-array → as-is; OOB → first slot.
  function _pickSlot(val, ri, fallback) {
    if(!Array.isArray(val)) return val ?? fallback;
    if(ri != null && ri >= 0 && ri < val.length) return val[ri];
    return val[0] ?? fallback;
  }

  //---------------------------------------------------------- Identity

  // Pair registers store `id` as `[hi, lo]`; collapse to the two extremes.
  const lo = (reg) => Array.isArray(reg.id) ? Math.min(...reg.id) : reg.id;
  const hi = (reg) => Array.isArray(reg.id) ? Math.max(...reg.id) : reg.id;

  // "12" for a single, "12-13" for a pair.
  function label(reg) {
    const a = lo(reg), b = hi(reg);
    return a === b ? String(a) : `${a}-${b}`;
  }

  //---------------------------------------------------------- Rule resolution

  // Slot index for a `type=rule` register: case-insensitive lookup of the
  // switch register's current value against `reg.unit` labels. Returns null
  // when not a rule, switch unpolled, or no matching label (inactive slot).
  //
  // `confirmed=true` ignores pending edits and reads only `S.values` so chart
  // panels wait for device feedback before regrouping. Offline (no feedback
  // source) falls back to the dirty-aware behavior.
  function ruleIndex(reg, confirmed = false) {
    if(reg.type !== "rule" || !reg.rule?.switch) return null;
    const switchName = reg.rule.switch;
    const useConfirmed = confirmed && S.connected;
    const sv = useConfirmed
      ? S.values[switchName]
      : (switchName in S.dirty ? S.dirty[switchName] : S.values[switchName]);
    if(sv == null) return null;
    const units = reg.unit;
    if(!Array.isArray(units)) return null;
    const labelStr = String(sv).toLowerCase();
    for(let i = 0; i < units.length; i++) {
      if(units[i].toLowerCase() === labelStr) return i;
    }
    return null;
  }

  // Rule register whose switch resolves to no slot - control is disabled.
  const isInactive = (reg) => reg.type === "rule" && ruleIndex(reg) === null;

  //---------------------------------------------------------- Per-slot accessors

  function unit(reg, confirmed = false) {
    const ri = ruleIndex(reg, confirmed);
    if(Array.isArray(reg.unit)) return ri !== null ? reg.unit[ri] : "";
    return reg.unit || "";
  }

  // Falls back to 0 / 65535 so OOR checks always have concrete bounds.
  const min = (reg) => _pickSlot(reg.min, ruleIndex(reg), 0);
  const max = (reg) => _pickSlot(reg.max, ruleIndex(reg), 65535);

  // Currently active scale - rule-aware so chart panels regroup when the
  // switch flips (e.g. Ctrl:Setpoint rpm → Hz remaps unit AND scale).
  const scale = (reg, confirmed = false) => _pickSlot(reg.scale, ruleIndex(reg, confirmed), 1);

  // Smallest meaningful increment. scale=1000 → 0.001 etc. Pair registers
  // fix step at 1 (they're 32-bit ints or floats - sliders skip them anyway).
  function step(reg) {
    if(reg.rule?.pair) return 1;
    const s = _pickSlot(reg.scale, ruleIndex(reg), 1);
    return (s && s > 0) ? 1 / s : 1;
  }

  //---------------------------------------------------------- Access mode

  const rws = (reg) => reg.rws || "R";
  const ro = (reg) => rws(reg) === "R";

  // Each access mode gets its own badge color so RWs (persisted) reads
  // visually distinct from RW (volatile).
  const rwsClass = (reg) => `rb-rws rws-${rws(reg).toLowerCase()}`;

  //---------------------------------------------------------- Display / parse

  // Float pairs → magnitude-aware decimal. Uint pairs / hex → fixed-width
  // uppercase hex. Plain numerics → decimals derived from `scale`.
  function display(reg, value) {
    if(value == null) return "";
    if(reg.rule?.pair) {
      // IEEE 754 has no fixed scale - pick precision by magnitude so both
      // very small and very large values stay readable.
      if(reg.type === "float") {
        const a = Math.abs(value);
        if(a === 0) return "0";
        if(a >= 100) return value.toFixed(2);
        if(a >= 1) return value.toFixed(4);
        if(a >= 0.01) return value.toFixed(5);
        return value.toFixed(6);
      }
      // `>>> 0` coerces signed JS numbers to uint32 for the hex pad.
      return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
    }
    if(reg.type === "hex") return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(4, "0");
    if(typeof value === "number") {
      const s = step(reg);
      const dec = s < 1 ? Math.ceil(-Math.log10(s)) : 0;
      return value.toFixed(dec);
    }
    return String(value);
  }

  // Numerics accept `0x..` / `0b..` prefixes. Enum/bool/ver keep the raw
  // string so the caller can map labels.
  function parse(reg, str) {
    str = String(str ?? "").trim();
    if(!str) return null;
    if(str.startsWith("0x") || str.startsWith("0X")) return parseInt(str.slice(2), 16);
    if(str.startsWith("0b") || str.startsWith("0B")) return parseInt(str.slice(2), 2);
    if(isNumeric(reg)) {
      const v = parseFloat(str);
      return isNaN(v) ? null : v;
    }
    return str;
  }

  // Equal up to null/undefined - re-picking the current value should drop
  // the dirty entry rather than record a no-op edit.
  function same(a, b) {
    if(a === b) return true;
    return a == null && b == null;
  }

  // Snap to the smallest representable value at the register's scale.
  function snap(value, step) {
    if(step >= 1) return Math.round(value);
    const dec = Math.ceil(-Math.log10(step));
    return parseFloat(value.toFixed(dec));
  }

  //---------------------------------------------------------- Predicates

  // Anything except enum / bool / ver renders as a numeric input (uint, int,
  // rule, hex - the last formatted as hex string but still a number).
  const isNumeric = (reg) => !["enum", "bool", "ver"].includes(reg.type);
  const isEnum = (reg) => reg.type === "enum" && reg.enum;
  const isBool = (reg) => reg.type === "bool";
  const isVer  = (reg) => reg.type === "ver";

  function outOfRange(reg, value) {
    if(value == null || typeof value !== "number") return false;
    if(isInactive(reg)) return false;
    return value < min(reg) || value > max(reg);
  }

  //---------------------------------------------------------- Tooltip / list ops

  // Multi-line title attribute; browser renders \n as a soft break.
  function tooltip(reg) {
    const hexStr = Array.isArray(reg.hex) ? reg.hex.join(", ") : reg.hex;
    const unitStr = Array.isArray(reg.unit) ? reg.unit.join("/") : reg.unit;
    return [
      hexStr, `${reg.type} [${reg.rws}]`,
      unitStr ? `unit: ${unitStr}` : null,
      reg.scale != null && reg.scale !== 1 ? `scale: ${JSON.stringify(reg.scale)}` : null,
      reg.min != null ? `min: ${JSON.stringify(reg.min)}` : null,
      reg.max != null ? `max: ${JSON.stringify(reg.max)}` : null,
      reg.desc || null,
    ].filter(Boolean).join("\n");
  }

  // Built once on first use; name weighted higher than desc so an exact
  // name hit beats a description match. Diacritic-insensitive (PL letters).
  let _fuzzy = null;
  function _getFuzzy() {
    if(!_fuzzy) _fuzzy = createFuzzy({
      fields: [
        { get: r => r.name, weight: 1.0 },
        { get: r => r.desc, weight: 0.5 },
      ],
    });
    return _fuzzy;
  }

  // Empty query → return as-is (no ranking, no copy). The result is usually
  // piped through `blocks()` which re-sorts by id, so fuzzy order doesn't
  // survive in the grid - intentional, address topology reads better than
  // a raw score dump when several registers match.
  function filter(regs, query) {
    if(!query) return regs;
    return _getFuzzy().rank(query, regs);
  }

  // Default view hides ignored regs; `S.showDisabled` reveals them inline
  // so the user can re-enable without losing address-space context.
  function visibility(regs) {
    if(S.showDisabled) return regs;
    return regs.filter(r => !S.ignore.has(r.name));
  }

  // Group registers into contiguous blocks of adjacent ids - e.g.
  // [1,2,3,5,6] → [[1,2,3], [5,6]]. Drives the visual gaps in the grid.
  function blocks(regs) {
    if(!regs.length) return [];
    const s = [...regs].sort((a, b) => lo(a) - lo(b));
    const out = [[s[0]]];
    for(let i = 1; i < s.length; i++) {
      if(lo(s[i]) <= hi(out.at(-1).at(-1)) + 1) out.at(-1).push(s[i]);
      else out.push([s[i]]);
    }
    return out;
  }

  return {
    lo, hi, label,
    ruleIndex, isInactive,
    unit, min, max, step, scale,
    rws, ro, rwsClass,
    display, parse, same, snap,
    isNumeric, isEnum, isBool, isVer,
    outOfRange,
    tooltip, filter, visibility, blocks,
  };
})();
