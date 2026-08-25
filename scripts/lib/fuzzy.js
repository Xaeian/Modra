// scripts/lib/fuzzy.js

//------------------------------------------------------------------------------------------- Fuzzy

/**
 * Domain-agnostic, diacritic-insensitive fuzzy ranker; caller binds fields via `createFuzzy()`.
 *
 * Per-string score bands (integer): exact 1000, prefix [201,499], contains [50,199], fuzzy [1,49].
 * Hard floors/caps keep bands strictly hierarchical. Per-item score sums weighted field scores
 * (float), so cross-field hierarchy does NOT hold under differing weights.
 */
const createFuzzy = (() => {

  // Each floor sits one above the next band's ceiling, so the bands can never overlap.
  const SCORE_EXACT        = 1000;
  const SCORE_PREFIX       = 500;
  const SCORE_PREFIX_MIN   = 201;  // = SCORE_CONTAINS + 1
  const SCORE_CONTAINS     = 200;
  const SCORE_CONTAINS_MIN = 50;   // = SCORE_FUZZY_MAX + 1
  const SCORE_FUZZY_BASE   = 1;
  const SCORE_FUZZY_MAX    = 49;   // capped in _scoreString so fuzzy can't reach contains

  // Walker per-char bonuses; their sum can exceed SCORE_FUZZY_MAX, capped in _scoreString.
  const FUZZY_CHAR   = 5;
  const FUZZY_STREAK = 2;

  /**
   * Strip diacritics and lowercase: "Łódź" -> "lodz".
   * PL `ł` is a standalone codepoint (not NFD-decomposable), so map it manually.
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
   * Score `text` against normalized query `q`; 0 = no match.
   * @param {string} q     Already normalized via `_norm()`.
   * @param {string} text  Raw, normalized internally.
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
    // Subsequence walker: `q` chars must appear in `t` in order; streak rewards consecutive hits.
    let qi = 0, score = 0, streak = 0;
    for(let ti = 0; ti < t.length && qi < q.length; ti++) {
      if(t[ti] === q[qi]) { qi++; streak++; score += FUZZY_CHAR + streak * FUZZY_STREAK; }
      else streak = 0;
    }
    if(qi !== q.length) return 0;
    return Math.min(SCORE_FUZZY_MAX, SCORE_FUZZY_BASE + score);
  }

  /**
   * Build a fuzzy ranker; a field is `{ get(item) -> string, weight?: number }`.
   * @param {Object} config
   * @param {Array<Object>} config.fields    Extractors, non-empty; weight defaults to 1.0.
   * @param {Function} [config.naturalSort]  Comparator for empty query; default insertion order.
   * @returns {{rank: Function, score: Function}}
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

    /** Weighted sum of field scores; null/undefined skipped, other non-strings via String(). */
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
     * Rank items; empty query returns every item in natural (or insertion) order.
     * Otherwise only matches, score desc, original order as tiebreak. Input is never mutated.
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
     * Score one item; empty query returns 0 (unlike `rank("")`, which returns everything).
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
