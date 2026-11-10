// scripts/helpers.js

// Pure helpers shared by the UI. Reads `S.dirty` / `S.values` for rule
// resolution but never writes back.

//---------------------------------------------------------------------------------- Shared helpers

/**
 * A glob as a regex body: `*` and `?` as they read in a file name, everything else literal.
 * Callers add their own anchors and flags, because those are where the search box
 * and the ignore list legitimately differ.
 */
function globSource(pattern) {
  // Shared, because two copies of the rule are two rules the moment one of them is fixed
  return pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*").replace(/\?/g, ".");
}

/**
 * Class string of a base and its modifiers, a falsy modifier dropping out:
 *   cls("btn", on && "on") -> "btn on", or "btn" while `on` is false
 */
function cls(base, ...mods) {
  let out = base;
  for(const m of mods) if(m) out += " " + m;
  return out;
}

/**
 * Labels of the bits set in `mask`, `"-"` when none is;
 * an unlabeled bit shows as `bN`, so a stray flag still shows.
 * @param {Record<number, string>} labels  bit index -> name, as `reg.bits` holds it
 * @param {number} mask  a 16-bit word
 */
function bitsText(labels, mask) {
  const out = [];
  for(let i = 0; i < 16; i++) if((mask >> i) & 1) out.push(labels[i] ?? ("b" + i));
  return out.length ? out.join(" | ") : "-";
}

/** Date stamp for an exported file's name, today in UTC: "2026-07-17". */
const fileStamp = () => new Date().toISOString().slice(0, 10);

// The addresses a Modbus RTU device can answer at
const MIN_ADDR = 1, MAX_ADDR = 247;

/**
 * Modbus addresses a list like "1-10, 12, 100-110" names: sorted, each once, in range.
 * A part that is neither a number nor a range is skipped.
 */
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
    .filter(a => a >= MIN_ADDR && a <= MAX_ADDR)
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

  /** First address a register takes: its `id`, or the lower of a pair's `[hi, lo]`. */
  const lo = (reg) => Array.isArray(reg.id) ? Math.min(...reg.id) : reg.id;
  /** Last address a register takes: its `id`, or the higher of a pair's `[hi, lo]`. */
  const hi = (reg) => Array.isArray(reg.id) ? Math.max(...reg.id) : reg.id;

  // Map cached on the catalog reference
  let _byName = null, _byNameSrc = null;
  /** Register of that name in the loaded map, or `null`. */
  function byName(name) {
    if(_byNameSrc !== S.regs) {
      _byNameSrc = S.regs;
      _byName = new Map(S.regs.map(r => [r.name, r]));
    }
    return _byName.get(name) || null;
  }

  /** Address text of a register: "12" for a single, "12-13" for a pair. */
  function label(reg) {
    const a = lo(reg), b = hi(reg);
    return a === b ? String(a) : `${a}-${b}`;
  }

  //------------------------------------------------------------------------------- Rule resolution

  /** What a field stands at: the staged edit where there is one, the device value otherwise. */
  const staged = (name) => Object.hasOwn(S.dirty, name) ? S.dirty[name] : S.values[name];

  /**
   * Slot index of a `type=rule` register, `null` when no slot is active or it is no rule.
   * The switch value is matched against the `reg.unit` labels, case aside.
   * @param {boolean} [confirmed]  `S.values` only, so chart panels wait for device feedback
   *   before regrouping; offline, with no feedback to wait for, the staged value counts
   */
  function ruleIndex(reg, confirmed = false) {
    if(reg.type !== "rule" || !reg.rule?.switch) return null;
    const switchName = reg.rule.switch;
    const useConfirmed = confirmed && S.connected;
    const sv = useConfirmed ? S.values[switchName] : staged(switchName);
    if(sv == null) return null;
    const units = reg.unit;
    if(!Array.isArray(units)) return null;
    const labelStr = String(sv).toLowerCase();
    for(let i = 0; i < units.length; i++) {
      if(units[i].toLowerCase() === labelStr) return i;
    }
    return null;
  }

  /** Whether a rule register's switch resolves to no slot, which disables its control. */
  const isInactive = (reg) => reg.type === "rule" && ruleIndex(reg) === null;

  //---------------------------------------------------------------------------- Per-slot accessors

  /**
   * Unit of a register, its active slot's for a rule; `""` when there is none.
   * @param {boolean} [confirmed]  as `ruleIndex` takes it
   */
  function unit(reg, confirmed = false) {
    const ri = ruleIndex(reg, confirmed);
    if(Array.isArray(reg.unit)) return ri !== null ? reg.unit[ri] : "";
    return reg.unit || "";
  }

  /** Lower bound of a register's active slot, 0 when undeclared, so there always is one. */
  const min = (reg) => _pickSlot(reg.min, ruleIndex(reg), 0);
  /** Upper bound of a register's active slot, 65535 when undeclared, so there always is one. */
  const max = (reg) => _pickSlot(reg.max, ruleIndex(reg), 65535);

  /**
   * Scale of a register's active slot, 1 by default.
   * Rule-aware: a switch from rpm to Hz on `Ctrl:Setpoint` remaps unit and scale together,
   * so chart panels regroup.
   * @param {boolean} [confirmed]  as `ruleIndex` takes it
   */
  const scale = (reg, confirmed = false) => _pickSlot(reg.scale, ruleIndex(reg, confirmed), 1);

  /**
   * Step a register's value moves in, one over its scale: 0.001 for `scale=1000`.
   * A pair is fixed at 1: it holds a 32-bit int or float, and sliders skip pairs anyway.
   */
  function step(reg) {
    if(reg.rule?.pair) return 1;
    const s = _pickSlot(reg.scale, ruleIndex(reg), 1);
    return (s && s > 0) ? 1 / s : 1;
  }

  //----------------------------------------------------------------------------------- Access mode

  /** Access mode of a register, `R` when the map gives none. */
  const rws = (reg) => reg.rws || "R";
  /** Whether a register is read-only. */
  const ro = (reg) => rws(reg) === "R";

  /** Badge classes of a register's access mode, a color each: RWs persisted, RW volatile. */
  const rwsClass = (reg) => `rb-rws rws-${rws(reg).toLowerCase()}`;

  //------------------------------------------------------------------------------- Display / parse

  /**
   * Text of a value as its register shows it, `""` for none:
   * hex, bit labels or a float's own precision by type, otherwise rounded to the step.
   */
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

  /** Decimal places `display` rounds a register to, for an export that must round alike. */
  const decimals = (reg) => _decimals(step(reg));

  /**
   * Typed text as a register's value, `null` for empty text or a number that does not parse.
   * A `0x..` or `0b..` prefix reads as a number for any register; other enum, bool
   * and version text stays a string, so the caller can map labels.
   */
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
      // grouped thousands are left alone. A config import parses through here too.
      const v = parseFloat(str.replace(/^(-?\d+),(\d+)$/, "$1.$2"));
      return isNaN(v) ? null : v;
    }
    return str;
  }

  /**
   * Whether two values are equal, `null` and `undefined` counting as one:
   * re-picking the current value should drop the staged edit rather than record a no-op.
   */
  function same(a, b) {
    if(a === b) return true;
    return a == null && b == null;
  }

  /** A value rounded to the precision `stepSize` allows, not to a multiple of it. */
  function snap(value, stepSize) {
    if(stepSize >= 1) return Math.round(value);
    return parseFloat(value.toFixed(_decimals(stepSize)));
  }

  //------------------------------------------------------------------------------------ Predicates

  // A JS number (uint / int / rule / hex / bits); render dispatch is `isScalar`.
  const isNumeric = (reg) => !["enum", "bool", "ver"].includes(reg.type);
  /** Whether a register is an enum that carries its labels. */
  const isEnum = (reg) => reg.type === "enum" && reg.enum;
  /** Whether a register is a bool. */
  const isBool = (reg) => reg.type === "bool";
  /** Whether a register holds a version string. */
  const isVer = (reg) => reg.type === "ver";
  /** Whether a register is a bit mask that carries its bit labels. */
  const isBits = (reg) => reg.type === "bits" && reg.bits;

  /**
   * Whether a register is telemetry: `ver` and `hex` are identity instead.
   * An opaque word has no trend, and a version string has no numeric order to plot:
   * "1.10.0" would sit below "1.2.3".
   */
  const isTelemetry = (reg) => !["ver", "hex"].includes(reg.type);

  /**
   * Whether the map's `info` column marks a register:
   * a read-only one the config file carries beside the settings.
   */
  const isInfo = (reg) => String(reg.info ?? "").trim().toLowerCase() === "true";

  /** Whether a register is edited as free text, the fallthrough of `Control.For`. */
  const isScalar = (reg) => !isEnum(reg) && !isBool(reg) && !isVer(reg) && !isBits(reg);

  /** Whether a null is the device's own N/A, told apart from a value never polled. */
  const isNA = (reg, value) =>
    !!reg.nullable && value == null && S.connected && !isInactive(reg);

  /** Whether a value lies past a bound the map declares for the register's active slot. */
  function outOfRange(reg, value) {
    if(value == null || typeof value !== "number") return false;
    if(isInactive(reg)) return false;
    // Only against declared bounds; an undeclared side has no advisory limit.
    const ri = ruleIndex(reg);
    const loBound = _pickSlot(reg.min, ri, null);
    const hiBound = _pickSlot(reg.max, ri, null);
    return (loBound != null && value < loBound) || (hiBound != null && value > hiBound);
  }

  /**
   * Whether `round(value * scale)` lands past the word the register holds,
   * which wraps it to a different number.
   * `reg.span` is that word as the backend's encoder knows it; a type without one has no scale.
   */
  function willWrap(reg, value) {
    if(value == null || typeof value !== "number") return false;
    if(reg.rule?.pair || isInactive(reg) || !reg.span) return false;
    const s = scale(reg);
    if(!(s > 0)) return false;
    const raw = Math.round(value * s);
    return raw < reg.span[0] || raw > reg.span[1];
  }

  /** Number the device keeps after a wrap: the value encoded, cut to 16 bits and decoded. */
  function wrapPreview(reg, value) {
    const s = scale(reg) || 1;
    let raw = Math.round(value * s) & 0xFFFF;
    if(reg.type === "int" && raw >= 0x8000) raw -= 0x10000;
    return raw / s;
  }

  //---------------------------------------------------------------------------- Tooltip / list ops

  /**
   * Hover text of a register, one fact per line from its address to its description;
   * a `title` attribute shows each `\n` as a soft break.
   */
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

  // `|` separates alternatives in both modes. Strict: `*`/`?` glob over the
  // whole name, a bare token is a name substring; fuzzy: the ranker per part.
  const _alts = (query) => query.split("|").map(s => s.trim()).filter(Boolean);

  // A part with a wildcard matches the whole name; one without is a substring,
  // which is what makes a bare word still useful in strict mode.
  function _strictRe(part) {
    const body = globSource(part);
    return new RegExp(/[*?]/.test(part) ? "^" + body + "$" : body, "i");
  }

  function _rank(query, regs) {
    const alts = _alts(query);
    if(!alts.length) return regs;
    if(S.searchStrict) {
      const res = alts.map(_strictRe);
      return regs.filter(r => res.some(re => re.test(r.name)));
    }
    const seen = new Set(), out = [];
    for(const a of alts) {
      for(const r of _getFuzzy().rank(a, regs)) {
        if(!seen.has(r.name)) { seen.add(r.name); out.push(r); }
      }
    }
    return out;
  }

  /**
   * Registers the query finds, in `S.searchHide` mode only; otherwise all of them,
   * since the default marks instead (see `match`) so the grid never reflows.
   * `blocks()` then re-sorts by id, dropping match order on purpose:
   * address topology reads better.
   */
  function filter(regs, query) {
    if(!query || !S.searchHide) return regs;
    return _rank(query, regs);
  }

  // Matching names, memoized on (catalog, query, mode) - `match` asks per row.
  let _hits = null, _hitsSrc = null, _hitsQuery = null, _hitsStrict = null;
  function _hitSet() {
    if(_hitsSrc !== S.regs || _hitsQuery !== S.query || _hitsStrict !== S.searchStrict) {
      _hitsSrc = S.regs;
      _hitsQuery = S.query;
      _hitsStrict = S.searchStrict;
      _hits = new Set(_rank(S.query, S.regs).map(r => r.name));
    }
    return _hits;
  }

  /**
   * Mark of a register under the current query, `"hit"` or `"miss"`.
   * `null` when there is nothing to mark: no query, or hide mode,
   * where everything left standing is a hit anyway.
   */
  function match(reg) {
    if(!S.query || S.searchHide) return null;
    return _hitSet().has(reg.name) ? "hit" : "miss";
  }

  /**
   * Registers the grid shows: ignored ones left out, unless `S.showDisabled` keeps them inline
   * so the user can re-enable one without losing address-space context.
   */
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

  /**
   * Registers in address order, cut into the blocks the grid sets apart with a gap.
   * Boundaries come from the full catalog, so hiding registers thins a block out
   * instead of splitting it at every hole.
   */
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

  /**
   * Registers spread over up to `k` balanced columns, each to be grouped by `blocks` again.
   * A block stays whole unless it alone exceeds a column's share, then it spills.
   */
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
      else for(const r of b) { // oversized block spills by row
        cols[Math.min(k - 1, Math.floor(cum / colSize))].push(r);
        cum++;
      }
    }
    return cols.filter(c => c.length);
  }

  return {
    lo, hi, label, byName,
    staged, ruleIndex, isInactive,
    unit, min, max, step, scale,
    rws, ro, rwsClass,
    display, decimals, parse, same, snap,
    isEnum, isBool, isVer, isBits, isScalar, isNA, isTelemetry, isInfo,
    outOfRange, willWrap, wrapPreview,
    tooltip, filter, match, visibility, blocks, columns,
  };
})();
