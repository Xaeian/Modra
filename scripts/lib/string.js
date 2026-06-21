// scripts/lib/string.js

//--------------------------------------------------------------------------------------- Split

/**
 * Split string by separator, preserving quoted segments.
 * Doubled quotes (`""`) escape inside quoted segments unless `esc` is given.
 * @param {string} str Input text
 * @param {string} [sep=" "] Separator (multi-char allowed)
 * @param {string} [quote='"'] Single-character quote
 * @param {string} [esc=null] Escape character (`null` = doubled-quote escape)
 * @returns {string[]} Tokens with quotes preserved
 */
function splitStr(str, sep = " ", quote = '"', esc = null) {
  if(!sep) throw new Error("Separator cannot be empty");
  if(quote.length !== 1) throw new Error("Quote must be a single character");
  if(esc && esc.length !== 1) throw new Error("Escape must be a single character");
  if(sep.includes(quote)) throw new Error("Separator and quote must differ");
  const res = [];
  let buf = "";
  let inQuote = false;
  let i = 0;
  while(i < str.length) {
    const ch = str[i];
    if(inQuote) {
      buf += ch;
      if(esc && ch === esc && i + 1 < str.length) { buf += str[i + 1]; i += 2; continue; }
      if(!esc && ch === quote && i + 1 < str.length && str[i + 1] === quote) {
        buf += str[i + 1]; i += 2; continue;
      }
      if(ch === quote) inQuote = false;
      i++;
    }
    else {
      if(ch === quote) { inQuote = true; buf += ch; i++; }
      else if(str.substr(i, sep.length) === sep) { res.push(buf); buf = ""; i += sep.length; }
      else { buf += ch; i++; }
    }
  }
  if(inQuote) {
    const preview = str.length > 50 ? str.slice(0, 50) + "..." : str;
    throw new Error(`Unclosed quote in: ${preview}`);
  }
  res.push(buf);
  return res;
}

//------------------------------------------------------------------------------------- Replace

/**
 * Recursively replace mapping keys with values in strings, arrays, and plain objects.
 * Longest pattern wins on overlap, so result is order-independent. Non-plain objects and cycles are returned as-is.
 * @param {string|Array|object} subject Input to process
 * @param {object} mapping `{ key: value }` replacements
 * @param {string} [prefix=""] Prefix before each key
 * @param {string} [suffix=""] Suffix after each key
 * @returns {*} Subject with patterns replaced
 */
function replaceMap(subject, mapping, prefix = "", suffix = "") {
  const keys = Object.keys(mapping);
  if(!keys.length) return subject;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(sorted.map(k => escape(prefix + k + suffix)).join("|"), "g");
  const lookup = {};
  for(const k of keys) lookup[prefix + k + suffix] = String(mapping[k]);
  const seen = new WeakSet();
  const walk = (val) => {
    if(typeof val === "string") return val.replace(pattern, m => lookup[m]);
    if(Array.isArray(val)) {
      if(seen.has(val)) return val;
      seen.add(val);
      return val.map(walk);
    }
    if(val && typeof val === "object") {
      const proto = Object.getPrototypeOf(val);
      if(proto !== Object.prototype && proto !== null) return val;
      if(seen.has(val)) return val;
      seen.add(val);
      const out = proto === null ? Object.create(null) : {};
      for(const k of Object.keys(val)) out[k] = walk(val[k]);
      return out;
    }
    return val;
  };
  return walk(subject);
}

//------------------------------------------------------------------------------------ Comments

/**
 * Generic comment stripper for languages with single-char quotes.
 * Throws on unclosed strings or block comments.
 * @param {string} str Input source
 * @param {object} [opts]
 * @param {string} [opts.line="//"] Line marker, `null` to disable
 * @param {[string,string]} [opts.block=["/*","*\/"]] Block markers, `null` to disable
 * @param {string} [opts.quotes='"'] Quote character(s)
 * @param {"backslash"|"double"} [opts.escape="backslash"] String escape mode
 * @returns {string}
 */
function stripComments(str, opts = {}) {
  const { line = "//", block = ["/*", "*/"], quotes = '"', escape = "backslash" } = opts;
  let result = "";
  let i = 0;
  let quoteChar = null;
  while(i < str.length) {
    const ch = str[i];
    if(quoteChar) {
      result += ch;
      if(escape === "backslash" && ch === "\\" && i + 1 < str.length) {
        result += str[i + 1]; i += 2; continue;
      }
      if(escape === "double" && ch === quoteChar
         && i + 1 < str.length && str[i + 1] === quoteChar) {
        result += str[i + 1]; i += 2; continue;
      }
      if(ch === quoteChar) quoteChar = null;
      i++;
    }
    else {
      if(quotes.includes(ch)) { quoteChar = ch; result += ch; i++; }
      else if(line && str.substr(i, line.length) === line) {
        while(i < str.length && str[i] !== "\n") i++;
      }
      else if(block && str.substr(i, block[0].length) === block[0]) {
        const start = i;
        i += block[0].length;
        while(i < str.length && str.substr(i, block[1].length) !== block[1]) i++;
        if(i >= str.length) throw new Error(`Unclosed block comment at offset ${start}`);
        i += block[1].length;
      }
      else { result += ch; i++; }
    }
  }
  if(quoteChar) throw new Error("Unclosed string literal");
  return result;
}

/** Strip C/C++/Java comments (`//`, block, backslash escape, `"` and `'`). */
function stripCommentsC(str) {
  return stripComments(str, { line: "//", block: ["/*", "*/"], quotes: "\"'" });
}

/**
 * Strip JavaScript comments. Handles `"`, `'`, and template literals.
 * Does not recognize regex literals; treats `${...}` interpolation as opaque, so comments inside it survive.
 */
function stripCommentsJs(str) {
  let result = "";
  let i = 0;
  let mode = null; // null | '"' | "'" | "`" | "line" | "block"
  while(i < str.length) {
    const ch = str[i];
    if(mode === "line") {
      if(ch === "\n") { result += ch; mode = null; }
      i++;
    }
    else if(mode === "block") {
      if(str.substr(i, 2) === "*/") { i += 2; mode = null; }
      else i++;
    }
    else if(mode === '"' || mode === "'" || mode === "`") {
      result += ch;
      if(ch === "\\" && i + 1 < str.length) { result += str[i + 1]; i += 2; continue; }
      if(ch === mode) mode = null;
      i++;
    }
    else {
      if(str.substr(i, 2) === "//") { mode = "line"; i += 2; }
      else if(str.substr(i, 2) === "/*") { mode = "block"; i += 2; }
      else if(ch === '"' || ch === "'" || ch === "`") { mode = ch; result += ch; i++; }
      else { result += ch; i++; }
    }
  }
  if(mode === "block") throw new Error("Unclosed block comment");
  if(mode === '"' || mode === "'" || mode === "`") throw new Error("Unclosed string literal");
  return result;
}

/** Strip SQL comments (`--`, block, `''` doubled-quote escape). */
function stripCommentsSql(str) {
  return stripComments(str, {
    line: "--", block: ["/*", "*/"], quotes: "'", escape: "double",
  });
}

/**
 * Strip Python comments (`#`). Handles triple-quoted strings.
 * Treats f-string `{...}` interpolation as opaque, so `#` inside it survives.
 */
function stripCommentsPy(str) {
  let result = "";
  let i = 0;
  let mode = null; // null | '"' | "'" | '"""' | "'''" | "line"
  while(i < str.length) {
    const ch = str[i];
    if(mode === "line") {
      if(ch === "\n") { result += ch; mode = null; }
      i++;
    }
    else if(mode === '"""' || mode === "'''") {
      if(str.substr(i, 3) === mode) { result += mode; i += 3; mode = null; continue; }
      result += ch;
      if(ch === "\\" && i + 1 < str.length) { result += str[i + 1]; i += 2; continue; }
      i++;
    }
    else if(mode === '"' || mode === "'") {
      result += ch;
      if(ch === "\\" && i + 1 < str.length) { result += str[i + 1]; i += 2; continue; }
      if(ch === mode) mode = null;
      i++;
    }
    else {
      if(str.substr(i, 3) === '"""') { mode = '"""'; result += '"""'; i += 3; }
      else if(str.substr(i, 3) === "'''") { mode = "'''"; result += "'''"; i += 3; }
      else if(ch === '"' || ch === "'") { mode = ch; result += ch; i++; }
      else if(ch === "#") { mode = "line"; i++; }
      else { result += ch; i++; }
    }
  }
  if(mode && mode !== "line") throw new Error("Unclosed string literal");
  return result;
}

//------------------------------------------------------------------------------------ Password

/**
 * Generate cryptographically secure random password.
 * Guarantees at least one lowercase, uppercase, digit and special character.
 * Uses `crypto.getRandomValues` with rejection sampling (no modulo bias).
 * @param {number} [length=16] Password length (minimum 4)
 * @param {boolean} [extendSpec=false] Use extended special character set
 * @returns {string}
 */
function generatePassword(length = 16, extendSpec = false) {
  if(length < 4) throw new Error("Password length must be >= 4");
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const spec = extendSpec ? "~`!@#$%^&*?()_-+={[}]|\\:;\"'<,>./" : "!@#$%^&*?";
  const all = lower + upper + digits + spec;
  const pick = (set) => set[randBelow(set.length)];
  const pwd = [pick(lower), pick(upper), pick(digits), pick(spec)];
  for(let i = 0; i < length - 4; i++) pwd.push(pick(all));
  for(let i = pwd.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join("");
}

/** Unbiased random integer in `[0, n)` via rejection sampling. */
function randBelow(n) {
  if(!Number.isInteger(n) || n <= 0) throw new Error("randBelow: n must be a positive integer");
  const cryptoObj = globalThis.crypto
    || (typeof require === "function" ? require("crypto").webcrypto : null);
  if(!cryptoObj) throw new Error("Web Crypto API not available");
  const max = Math.floor(0xFFFFFFFF / n) * n;
  const buf = new Uint32Array(1);
  while(true) {
    cryptoObj.getRandomValues(buf);
    if(buf[0] < max) return buf[0] % n;
  }
}