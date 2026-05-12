// scripts/lib/fuzzy.js

//------------------------------------------------------------------------------------- Fuzzy

/**
 * Domain-agnostic fuzzy ranker. Caller defines which fields to score and
 * with what weights via `createFuzzy(config)`. The library knows nothing
 * about the shape of items being ranked.
 *
 * Diacritic-insensitive: PL "łódź" matches query "lodz", "żółw" matches "zolw".
 * Normalization is built in (NFD + PL `ł` mapping); no caller config needed.
 *
 * Typical usage:
 *
 *   const fuzzy = createFuzzy({
 *     fields: [
 *       { get: e => e.key,                           weight: 1.0 },
 *       { get: e => groupsById.get(e.groupId)?.name, weight: 0.6 },
 *       { get: e => e.note,                          weight: 0.5 },
 *       { get: e => e.value,                         weight: 0.2 },
 *     ],
 *     naturalSort: (a, b) => a.key.localeCompare(b.key),
 *   });
 *
 *   fuzzy.rank(query, entries);   // matching items, sorted (or natural when query is empty)
 *   fuzzy.score(query, entry);    // combined score for one item (0 = no match)
 *
 * Score model - per single string (`_scoreString`), integer:
 *   exact     = 1000
 *   prefix   in [201, 499]   formula `500 - len_diff`,  floored at 201
 *                            (500 unreachable: that case is handled by `exact`)
 *   contains in [ 50, 199]   formula `200 - idx`,       floored at  50
 *                            (200 unreachable: idx=0 with q==t is `exact`,
 *                             idx=0 with t.startsWith(q) is `prefix`)
 *   fuzzy    in [  1,  49]   base 1 + walker bonus,     capped at  49
 *
 *   Hierarchy is guaranteed by hard floors/caps: each band's ceiling sits
 *   one below the next band's floor, so no per-char bonus inside the walker
 *   can ever spill into the band above. Walker bonuses still discriminate
 *   WITHIN the fuzzy band.
 *
 * Score model - per item (`_scoreItem`), float (weights are real numbers):
 *   sum of `_scoreString(query, get(item)) * weight` over all fields.
 *   Multi-field hits add up, so an item matching weakly in 3 fields can
 *   outrank one with a single stronger hit. The per-field hierarchy still
 *   holds within one field; it does NOT hold across fields with different
 *   weights (e.g. exact * 0.2 = 200 < prefix * 1.0 = 500).
 */
const createFuzzy = (() => {

  // 4-band score model. Each band's natural value plus its hard floor.
  // Floors are positioned so the bands are strictly hierarchical.
  const SCORE_EXACT        = 1000;
  const SCORE_PREFIX       = 500;  // natural ceiling for prefix matches
  const SCORE_PREFIX_MIN   = 201;  // = SCORE_CONTAINS + 1
  const SCORE_CONTAINS     = 200;  // natural ceiling for contains matches
  const SCORE_CONTAINS_MIN = 50;   // = SCORE_FUZZY_MAX + 1
  const SCORE_FUZZY_BASE   = 1;    // base for any successful walker match
  const SCORE_FUZZY_MAX    = 49;   // hard cap so fuzzy can't reach contains

  // Per-char bonuses inside the subsequence walker. These can blow past
  // SCORE_FUZZY_MAX for long queries - Math.min in `_scoreString` handles
  // the cap. The bonuses still let the walker discriminate up to that cap.
  const FUZZY_CHAR   = 5;
  const FUZZY_STREAK = 2;

  /**
   * Strip diacritics and lowercase: "Łódź" -> "lodz".
   *
   * `normalize("NFD")` decomposes most accented chars into base + combining
   * marks, which the regex then strips. PL `ł`/`Ł` are NOT composed (they
   * are standalone codepoints U+0142/U+0141), so we map them manually after
   * lowercasing.
   * @param {string} s
   * @returns {string}
   */
  function _norm(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ł/g, "l");
  }

  /**
   * Score how well `text` matches an already-normalized query `q`.
   * Returns 0 for no match. `text` is normalized inside.
   *
   * @param {string} q  Already normalized via `_norm()`.
   * @param {string} text  Raw, will be normalized internally.
   * @returns {number}
   */
  function _scoreString(q, text) {
    if(!q || !text) return 0;
    const t = _norm(text);
    if(t === q) return SCORE_EXACT;
    if(t.startsWith(q)) {
      return Math.max(SCORE_PREFIX_MIN, SCORE_PREFIX - (t.length - q.length));
    }
    const idx = t.indexOf(q);
    if(idx >= 0) {
      return Math.max(SCORE_CONTAINS_MIN, SCORE_CONTAINS - idx);
    }
    // Subsequence walker: chars of `q` must appear in `t` in order.
    // Streak bonus rewards consecutive matches over scattered ones.
    let qi = 0, score = 0, streak = 0;
    for(let ti = 0; ti < t.length && qi < q.length; ti++) {
      if(t[ti] === q[qi]) { qi++; streak++; score += FUZZY_CHAR + streak * FUZZY_STREAK; }
      else streak = 0;
    }
    if(qi !== q.length) return 0;
    return Math.min(SCORE_FUZZY_MAX, SCORE_FUZZY_BASE + score);
  }

  /**
   * Build a fuzzy ranker bound to a specific item shape via `fields`.
   *
   * @param {Object} config
   * @param {Array<{get:(item:Object) => string|null|undefined, weight?:number}>} config.fields
   *   Field extractors with optional weights (default 1.0). At least one
   *   field is required. `get` may return `null`/`undefined`/non-string -
   *   treated as empty (no contribution to score).
   * @param {(a:Object, b:Object) => number} [config.naturalSort]
   *   Sort comparator used when query is empty. Defaults to insertion order
   *   (no sorting). Caller is responsible for any locale-aware comparison.
   * @returns {{ rank: Function, score: Function }}
   */
  function _create(config) {
    if(!config || !Array.isArray(config.fields) || !config.fields.length) {
      throw new Error("createFuzzy: `fields` must be a non-empty array");
    }
    config.fields.forEach((f, i) => {
      if(!f || typeof f.get !== "function") {
        throw new Error(`createFuzzy: fields[${i}].get must be a function`);
      }
    });
    if(config.naturalSort != null && typeof config.naturalSort !== "function") {
      throw new Error("createFuzzy: `naturalSort` must be a function if provided");
    }
    const fields = config.fields.map(f => ({
      get: f.get,
      weight: typeof f.weight === "number" ? f.weight : 1.0,
    }));
    const naturalSort = config.naturalSort;

    /**
     * Combined weighted score across all configured fields. Float, since
     * weights are real numbers. Field values that are `null`/`undefined`
     * contribute 0 (no match); other non-string values are coerced via
     * `String()` so numbers/booleans are searchable.
     */
    function _scoreItem(q, item) {
      let total = 0;
      for(const f of fields) {
        const text = f.get(item);
        if(text == null) continue;
        total += _scoreString(q, typeof text === "string" ? text : String(text)) * f.weight;
      }
      return total;
    }

    /**
     * Rank items against a query.
     *
     * Empty query: returns all items in `naturalSort` order, or insertion
     * order when no `naturalSort` is configured.
     *
     * Non-empty query: returns ONLY matching items, sorted by combined
     * score descending. Original order is the stable tiebreak. Non-matching
     * items are dropped.
     *
     * Input array is never mutated.
     * @param {string} query
     * @param {Array<Object>} items
     * @returns {Array<Object>}
     */
    function rank(query, items) {
      if(!Array.isArray(items) || !items.length) return [];
      const raw = (query || "").trim();
      if(!raw) {
        const out = items.slice();
        if(naturalSort) out.sort(naturalSort);
        return out;
      }
      const q = _norm(raw);
      return items
        .map((it, i) => ({ it, i, s: _scoreItem(q, it) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(x => x.it);
    }

    /**
     * Combined score for a single item against `query`. Returns 0 when
     * `query` is empty (asymmetric with `rank("")` which returns all items
     * in natural order: empty `score` means "no question asked", empty
     * `rank` means "no filter applied"). Useful for one-off lookups
     * outside the `rank` flow (debugging, conditional rendering).
     * @param {string} query
     * @param {Object} item
     * @returns {number}
     */
    function score(query, item) {
      const raw = (query || "").trim();
      if(!raw) return 0;
      return _scoreItem(_norm(raw), item);
    }
    return { rank, score };
  }
  return _create;
})();