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

// Grid input editing `name` - looked up fresh, render() detaches held nodes.
const valInput = (name) =>
  document.querySelector(`input.rb-val[data-reg="${CSS.escape(name)}"]`);

// Labels of the bits set in `mask`, unlabeled ones as `bN` so a stray flag still
// shows; "-" when none. `labels` is the index->name map (reg.bits); shared by the
// grid display and the chart formatter.
function bitsText(labels, mask) {
  const out = [];
  for(let i = 0; i < 16; i++) if((mask >> i) & 1) out.push(labels[i] ?? ("b" + i));
  return out.length ? out.join(" | ") : "-";
}

// "2026-07-17" - date stamp for exported file names.
const fileStamp = () => new Date().toISOString().slice(0, 10);

// Parse range expressions like "1-10, 12, 100-110" into a sorted dedup'd
// list of valid Modbus addresses (1..247).
function parseAddrRange(str) {
  const addrs = new Set();
  for(const part of str.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if(range) {
      const a = parseInt(range[1]);
      const b = parseInt(range[2]);
      for(let i = Math.min(a, b); i <= Math.max(a, b); i++) addrs.add(i);
    }
    else if(/^\d+$/.test(t)) addrs.add(parseInt(t));
  }
  return [...addrs]
    .filter(a => a >= 1 && a <= 247)
    .sort((a, b) => a - b);
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

  // Decimal places implied by a sub-unit step (0.001 → 3). >=1 → integer.
  function _decimals(s) {
    return s < 1 ? Math.ceil(-Math.log10(s)) : 0;
  }

  //---------------------------------------------------------- Identity

  // Pair registers store `id` as `[hi, lo]`; collapse to the two extremes.
  const lo = (reg) => Array.isArray(reg.id) ? Math.min(...reg.id) : reg.id;
  const hi = (reg) => Array.isArray(reg.id) ? Math.max(...reg.id) : reg.id;

  // name → reg from the catalog, or null. Map cached on the catalog
  // reference (loaded once at boot) - the one lookup every hot path uses.
  let _byName = null, _byNameSrc = null;
  function byName(name) {
    if(_byNameSrc !== S.regs) {
      _byNameSrc = S.regs;
      _byName = new Map(S.regs.map(r => [r.name, r]));
    }
    return _byName.get(name) || null;
  }

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
    if(reg.type === "bits") return bitsText(reg.bits, value);
    if(typeof value === "number") return value.toFixed(_decimals(step(reg)));
    return String(value);
  }

  // Decimal places the register's scale implies. Shared by `display` and the
  // chart CSV export so both round numbers the same way.
  const decimals = (reg) => _decimals(step(reg));

  // Numerics accept `0x..` / `0b..` prefixes. Enum/bool/ver keep the raw
  // string so the caller can map labels.
  function parse(reg, str) {
    str = String(str ?? "").trim();
    if(!str) return null;
    if(str.startsWith("0x") || str.startsWith("0X")) {
      const v = parseInt(str.slice(2), 16);
      return isNaN(v) ? null : v;
    }
    if(str.startsWith("0b") || str.startsWith("0B")) {
      const v = parseInt(str.slice(2), 2);
      return isNaN(v) ? null : v;
    }
    if(isNumeric(reg)) {
      // A decimal comma (PL/DE locale) is a lone separator between digits;
      // normalize to a dot so parseFloat keeps the fraction. Mirrors the
      // import-path rule in actions.js; grouped thousands are left alone.
      const v = parseFloat(str.replace(/^(-?\d+),(\d+)$/, "$1.$2"));
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
    return parseFloat(value.toFixed(_decimals(step)));
  }

  //---------------------------------------------------------- Predicates

  // Value is a JS number (uint / int / rule / hex / bits) - drives parse,
  // willWrap and import. Render dispatch is `isScalar` / Control.For.
  const isNumeric = (reg) => !["enum", "bool", "ver"].includes(reg.type);
  const isEnum = (reg) => reg.type === "enum" && reg.enum;
  const isBool = (reg) => reg.type === "bool";
  const isVer  = (reg) => reg.type === "ver";
  const isBits = (reg) => reg.type === "bits" && reg.bits;

  // Renders the free-text Input control (Control.For's fallthrough).
  const isScalar = (reg) => !isEnum(reg) && !isBool(reg) && !isVer(reg) && !isBits(reg);

  // Device-reported null - tells a real N/A apart from never-polled.
  const isNA = (reg, value) =>
    !!reg.nullable && value == null && S.connected && !isInactive(reg);

  function outOfRange(reg, value) {
    if(value == null || typeof value !== "number") return false;
    if(isInactive(reg)) return false;
    // Only against declared bounds; an undeclared side has no advisory limit.
    const ri = ruleIndex(reg);
    const lo = _pickSlot(reg.min, ri, null);
    const hi = _pickSlot(reg.max, ri, null);
    return (lo != null && value < lo) || (hi != null && value > hi);
  }

  // 16-bit register span per type; types absent here don't scale-encode.
  const _RAW_RANGE = { uint: [0, 0xFFFF], hex: [0, 0xFFFF], rule: [0, 0xFFFF], bits: [0, 0xFFFF], int: [-0x8000, 0x7FFF] };

  // round(value*scale) overflows the register and wraps to a different number.
  function willWrap(reg, value) {
    if(value == null || typeof value !== "number") return false;
    if(reg.rule?.pair || isInactive(reg)) return false;
    const range = _RAW_RANGE[reg.type];
    if(!range) return false;
    const s = scale(reg);
    if(!(s > 0)) return false;
    const raw = Math.round(value * s);
    return raw < range[0] || raw > range[1];
  }

  // The number the device keeps after a wrap (encode & 0xFFFF, then decode).
  function wrapPreview(reg, value) {
    const s = scale(reg) || 1;
    let raw = Math.round(value * s) & 0xFFFF;
    if(reg.type === "int" && raw >= 0x8000) raw -= 0x10000;
    return raw / s;
  }

  //---------------------------------------------------------- Tooltip / list ops

  // Multi-line title attribute; browser renders \n as a soft break.
  function tooltip(reg) {
    const hexStr = Array.isArray(reg.hex) ? reg.hex.join(", ") : reg.hex;
    const unitStr = Array.isArray(reg.unit) ? reg.unit.join("/") : reg.unit;
    const typeStr = reg.nullable ? `?${reg.type}` : reg.type;
    return [
      hexStr, `${typeStr} [${reg.rws}]`,
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

  // Contiguous runs of adjacent ids - e.g. [1,2,3,5,6] → [[1,2,3], [5,6]].
  function _contiguous(regs) {
    if(!regs.length) return [];
    const s = [...regs].sort((a, b) => lo(a) - lo(b));
    const out = [[s[0]]];
    for(let i = 1; i < s.length; i++) {
      if(lo(s[i]) <= hi(out.at(-1).at(-1)) + 1) out.at(-1).push(s[i]);
      else out.push([s[i]]);
    }
    return out;
  }

  // Canonical block boundaries: the upper id of each contiguous run in the
  // FULL catalog, cached on the catalog reference (loaded once at boot).
  let _edges = null, _edgesSrc = null;
  function _blockEdges() {
    if(_edgesSrc !== S.regs) {
      _edgesSrc = S.regs;
      _edges = _contiguous(S.regs).map(b => hi(b.at(-1)));
    }
    return _edges;
  }

  // Group registers into blocks along the canonical boundaries. Grouping is
  // fixed by the full catalog, so search/ignore hiding registers thins a
  // block out instead of splitting it at every hole. Drives the visual gaps
  // in the grid.
  function blocks(regs) {
    if(!regs.length) return [];
    const s = [...regs].sort((a, b) => lo(a) - lo(b));
    const edges = _blockEdges();
    const out = [];
    let bi = 0, prev = -1;
    for(const r of s) {
      while(bi < edges.length - 1 && lo(r) > edges[bi]) bi++;
      if(bi !== prev) { out.push([]); prev = bi; }
      out.at(-1).push(r);
    }
    return out;
  }

  // Lay id-ordered regs into `k` balanced columns: a contiguous block stays
  // whole unless it alone exceeds a column's share, then it spills across
  // columns. Each column is re-grouped by `blocks` for rendering.
  function columns(regs, k) {
    if(k <= 1 || !regs.length) return [regs];
    const colSize = regs.length / k;
    const cols = Array.from({ length: k }, () => []);
    let cum = 0;
    for(const b of blocks(regs)) {
      if(b.length <= colSize) {
        // Small block stays whole, in the column its midpoint lands in.
        cols[Math.min(k - 1, Math.floor((cum + b.length / 2) / colSize))].push(...b);
        cum += b.length;
      }
      else for(const r of b) {                // oversized block spills by row
        cols[Math.min(k - 1, Math.floor(cum / colSize))].push(r);
        cum++;
      }
    }
    return cols.filter(c => c.length);
  }

  return {
    lo, hi, label, byName,
    ruleIndex, isInactive,
    unit, min, max, step, scale,
    rws, ro, rwsClass,
    display, decimals, parse, same, snap,
    isNumeric, isEnum, isBool, isVer, isBits, isScalar, isNA,
    outOfRange, willWrap, wrapPreview,
    tooltip, filter, visibility, blocks, columns,
  };
})();

// Grid column count from width and reg count (capped): narrow stays single-column.
const GRID_COL_W = 460, GRID_COL_MAX = 6, GRID_COL_ROWS = 8;
function gridColumnCount(regCount) {
  const w = document.querySelector(".rb-grid")?.clientWidth || (window.innerWidth - 32) || 1200;
  const byWidth = Math.max(1, Math.floor(w / GRID_COL_W));
  const byRows = Math.max(1, Math.round(regCount / GRID_COL_ROWS));
  return Math.max(1, Math.min(byWidth, byRows, GRID_COL_MAX));
}
