// scripts/helpers.js

// Pure helpers shared by the UI. Reads `S.dirty` / `S.values` for rule
// resolution but never writes back.

//------------------------------------------------------------------------------------- DOM helpers

// Falsy mods drop out, so callers can write `cls("btn", on && "on")`.
function cls(base, ...mods) {
  let out = base;
  for(const m of mods) if(m) out += " " + m;
  return out;
}

// Grid input editing `name` - looked up fresh, render() detaches held nodes.
const valInput = (name) =>
  document.querySelector(`input.rb-val[data-reg="${CSS.escape(name)}"]`);

// Labels of the bits set in `mask`; unlabeled ones as `bN` so a stray flag
// still shows, "-" when none. `labels` is the index->name map (reg.bits).
function bitsText(labels, mask) {
  const out = [];
  for(let i = 0; i < 16; i++) if((mask >> i) & 1) out.push(labels[i] ?? ("b" + i));
  return out.length ? out.join(" | ") : "-";
}

// "2026-07-17" - date stamp for exported file names.
const fileStamp = () => new Date().toISOString().slice(0, 10);

// "1-10, 12, 100-110" → sorted, dedup'd Modbus addresses (1..247).
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

//-------------------------------------------------------------------------------- Register helpers

const Reg = (() => {

  //-------------------------------------------------------------------------------------- Internal

  // Per-slot props (unit/scale/min/max): non-array → as-is, OOB → first slot.
  function _pickSlot(val, ri, fallback) {
    if(!Array.isArray(val)) return val ?? fallback;
    if(ri != null && ri >= 0 && ri < val.length) return val[ri];
    return val[0] ?? fallback;
  }

  // Decimal places implied by a sub-unit step (0.001 → 3). >=1 → integer.
  function _decimals(s) {
    return s < 1 ? Math.ceil(-Math.log10(s)) : 0;
  }

  //-------------------------------------------------------------------------------------- Identity

  // Pair registers store `id` as `[hi, lo]`; collapse to the two extremes.
  const lo = (reg) => Array.isArray(reg.id) ? Math.min(...reg.id) : reg.id;
  const hi = (reg) => Array.isArray(reg.id) ? Math.max(...reg.id) : reg.id;

  // name → reg, or null. Map cached on the catalog reference.
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

  //------------------------------------------------------------------------------- Rule resolution

  // Slot index for a `type=rule` register: case-insensitive match of the
  // switch value against `reg.unit` labels; null when no slot is active.
  //
  // `confirmed=true` reads only `S.values` so chart panels wait for device
  // feedback before regrouping; offline there is no feedback to wait for.
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

  //---------------------------------------------------------------------------- Per-slot accessors

  function unit(reg, confirmed = false) {
    const ri = ruleIndex(reg, confirmed);
    if(Array.isArray(reg.unit)) return ri !== null ? reg.unit[ri] : "";
    return reg.unit || "";
  }

  // Falls back to 0 / 65535 so OOR checks always have concrete bounds.
  const min = (reg) => _pickSlot(reg.min, ruleIndex(reg), 0);
  const max = (reg) => _pickSlot(reg.max, ruleIndex(reg), 65535);

  // Rule-aware: Ctrl:Setpoint rpm → Hz remaps unit AND scale, so panels regroup.
  const scale = (reg, confirmed = false) => _pickSlot(reg.scale, ruleIndex(reg, confirmed), 1);

  // scale=1000 → step 0.001. Pairs fix step at 1: they hold 32-bit ints or
  // floats, and sliders skip them anyway.
  function step(reg) {
    if(reg.rule?.pair) return 1;
    const s = _pickSlot(reg.scale, ruleIndex(reg), 1);
    return (s && s > 0) ? 1 / s : 1;
  }

  //----------------------------------------------------------------------------------- Access mode

  const rws = (reg) => reg.rws || "R";
  const ro = (reg) => rws(reg) === "R";

  // Own badge color per mode: RWs (persisted) vs RW (volatile).
  const rwsClass = (reg) => `rb-rws rws-${rws(reg).toLowerCase()}`;

  //------------------------------------------------------------------------------- Display / parse

  function display(reg, value) {
    if(value == null) return "";
    if(reg.rule?.pair) {
      // IEEE 754 has no fixed scale - pick precision by magnitude.
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

  // Shared with the chart CSV export so it rounds like `display`.
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
      // Decimal comma (PL/DE locale) → dot so parseFloat keeps the fraction;
      // grouped thousands are left alone. Mirrors the import path in actions.js.
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

  // Round to the precision `stepSize` allows.
  function snap(value, stepSize) {
    if(stepSize >= 1) return Math.round(value);
    return parseFloat(value.toFixed(_decimals(stepSize)));
  }

  //------------------------------------------------------------------------------------ Predicates

  // A JS number (uint / int / rule / hex / bits); render dispatch is `isScalar`.
  const isNumeric = (reg) => !["enum", "bool", "ver"].includes(reg.type);
  const isEnum = (reg) => reg.type === "enum" && reg.enum;
  const isBool = (reg) => reg.type === "bool";
  const isVer = (reg) => reg.type === "ver";
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
    const loBound = _pickSlot(reg.min, ri, null);
    const hiBound = _pickSlot(reg.max, ri, null);
    return (loBound != null && value < loBound) || (hiBound != null && value > hiBound);
  }

  // 16-bit register span per type; types absent here don't scale-encode.
  const _RAW_RANGE = {
    uint: [0, 0xFFFF], hex: [0, 0xFFFF], rule: [0, 0xFFFF], bits: [0, 0xFFFF],
    int: [-0x8000, 0x7FFF],
  };

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

  //---------------------------------------------------------------------------- Tooltip / list ops

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

  // Name outweighs desc so exact name hits win; diacritic-insensitive (PL letters).
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

  // Thins the list only in `S.searchHide` mode; the default marks instead
  // (see `match`) so the grid never reflows. `blocks()` then re-sorts by id,
  // dropping fuzzy order on purpose - address topology reads better.
  function filter(regs, query) {
    if(!query || !S.searchHide) return regs;
    return _getFuzzy().rank(query, regs);
  }

  // Matching names, memoized on (catalog, query) - `match` asks once per row.
  let _hits = null, _hitsSrc = null, _hitsQuery = null;
  function _hitSet() {
    if(_hitsSrc !== S.regs || _hitsQuery !== S.query) {
      _hitsSrc = S.regs;
      _hitsQuery = S.query;
      _hits = new Set(_getFuzzy().rank(S.query, S.regs).map(r => r.name));
    }
    return _hits;
  }

  // "hit" / "miss" for the current query; null when there is nothing to mark -
  // no query, or hide mode, where everything left standing is a hit anyway.
  function match(reg) {
    if(!S.query || S.searchHide) return null;
    return _hitSet().has(reg.name) ? "hit" : "miss";
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

  // Boundaries come from the full catalog, so hiding registers thins a block
  // out instead of splitting it at every hole. Drives the grid's visual gaps.
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

  // `k` balanced columns: a block stays whole unless it alone exceeds a
  // column's share, then it spills. Columns are re-grouped by `blocks`.
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
      else for(const r of b) {  // oversized block spills by row
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
    isEnum, isBool, isVer, isBits, isScalar, isNA,
    outOfRange, willWrap, wrapPreview,
    tooltip, filter, match, visibility, blocks, columns,
  };
})();

const GRID_COL_W = 460, GRID_COL_MAX = 6, GRID_COL_ROWS = 8;
function gridColumnCount(regCount) {
  const w = document.querySelector(".rb-grid")?.clientWidth || (window.innerWidth - 32) || 1200;
  const byWidth = Math.max(1, Math.floor(w / GRID_COL_W));
  const byRows = Math.max(1, Math.round(regCount / GRID_COL_ROWS));
  return Math.max(1, Math.min(byWidth, byRows, GRID_COL_MAX));
}
