// scripts/lib/files.js

function _download(filename, content, type="text/plain") {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

//----------------------------------------------------------------------------------------- CSV

const CSV = {

  _cast(value, type) {
    if(value === null || value === "") return null;
    try {
      if(type === Number) { const n = Number(value); return isNaN(n) ? null : n; }
      if(type === Boolean) return value === "true" || value === "1";
      if(type === String) return String(value);
      return value;
    } catch { return null; }
  },

  _parseRow(line, delimiter=",") {
    const fields = [];
    let cur = "", inQuote = false;
    for(let i = 0; i < line.length; i++) {
      const ch = line[i];
      if(inQuote) {
        if(ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if(ch === '"') inQuote = false;
        else cur += ch;
      } else {
        if(ch === '"') inQuote = true;
        else if(ch === delimiter) { fields.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  },

  _formatField(value, delimiter=",") {
    if(value === null || value === undefined) return "";
    const s = String(value);
    if(s.includes(delimiter) || s.includes('"') || s.includes("\n"))
      return '"' + s.replace(/"/g, '""') + '"';
    return s;
  },

  parse_raw(content, delimiter=",", types=null, includeHeader=true) {
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if(!lines.length) return [];
    const rows = lines.map(l => CSV._parseRow(l, delimiter));
    if(types && rows.length > 1) {
      const header = rows[0];
      const idxMap = {};
      header.forEach((col, i) => { if(col in types) idxMap[i] = types[col]; });
      for(let r = 1; r < rows.length; r++) {
        for(const [i, type] of Object.entries(idxMap)) {
          if(i < rows[r].length) rows[r][i] = CSV._cast(rows[r][i], type);
        }
      }
    }
    return includeHeader ? rows : rows.slice(1);
  },

  parse_vectors(content, delimiter=",", types=null, groupBy=null) {
    const rows = CSV.parse_text(content, delimiter, types);
    if(!rows.length) return {};
    const columns = Object.keys(rows[0]);
    if(groupBy === null) {
      const result = Object.fromEntries(columns.map(c => [c, []]));
      for(const row of rows) columns.forEach(c => result[c].push(row[c]));
      return result;
    }
    if(!columns.includes(groupBy)) throw new Error(`groupBy column '${groupBy}' not found`);
    const otherCols = columns.filter(c => c !== groupBy);
    const grouped = {};
    for(const row of rows) {
      const key = row[groupBy];
      if(!(key in grouped)) grouped[key] = Object.fromEntries(otherCols.map(c => [c, []]));
      otherCols.forEach(c => grouped[key][c].push(row[c]));
    }
    return grouped;
  },

  parse_text(content, delimiter=",", types=null) {
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if(!lines.length) return [];
    const header = CSV._parseRow(lines[0], delimiter);
    const rows = [];
    for(let i = 1; i < lines.length; i++) {
      const vals = CSV._parseRow(lines[i], delimiter);
      const row = {};
      header.forEach((col, j) => {
        let val = vals[j] ?? null;
        if(types && col in types) val = CSV._cast(val, types[col]);
        row[col] = val;
      });
      rows.push(row);
    }
    return rows;
  },

  stringify(data, fieldNames=null, delimiter=",") {
    if(!data || !data.length) return "";
    const fields = fieldNames || Object.keys(data[0]);
    const lines = [fields.map(f => CSV._formatField(f, delimiter)).join(delimiter)];
    for(const row of data) {
      lines.push(fields.map(f => CSV._formatField(row[f], delimiter)).join(delimiter));
    }
    return lines.join("\n") + "\n";
  },

  save_vectors(filename, columns, header=null, delimiter=",") {
    if(!columns.length) throw new Error("No data vectors provided");
    const len = columns[0].length;
    if(columns.some(c => c.length !== len)) throw new Error("All vectors must have same length");
    if(header && header.length !== columns.length) throw new Error("Header length must match vectors");
    const lines = [];
    if(header) lines.push(header.map(h => CSV._formatField(h, delimiter)).join(delimiter));
    for(let i = 0; i < len; i++) {
      lines.push(columns.map(c => CSV._formatField(c[i], delimiter)).join(delimiter));
    }
    _download(filename, lines.join("\n") + "\n", "text/csv");
  },

  /** File picker, parsed as vectors. */
  async open_vectors(delimiter=",", types=null, groupBy=null, accept=".csv") {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = accept;
      input.onchange = async () => {
        const file = input.files[0];
        if(!file) { resolve(null); return; }
        try {
          const text = await file.text();
          resolve(CSV.parse_vectors(text, delimiter, types, groupBy));
        } catch(e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  /** Parse a File object. */
  async load(file, delimiter=",", types=null) {
    const text = await file.text();
    return CSV.parse_text(text, delimiter, types);
  },

  /** Download as CSV. */
  save(filename, data, fieldNames=null, delimiter=",") {
    const content = CSV.stringify(data, fieldNames, delimiter);
    _download(filename, content, "text/csv");
  },

  /** File picker, parsed as CSV. */
  async open(delimiter=",", types=null, accept=".csv") {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = accept;
      input.onchange = async () => {
        const file = input.files[0];
        if(!file) { resolve(null); return; }
        try { resolve(await CSV.load(file, delimiter, types)); }
        catch(e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
};

//----------------------------------------------------------------------------------------- INI

const INI = {

  format(value) {
    if(value === null || value === undefined) return "";
    if(typeof value === "boolean") return value ? "true" : "false";
    if(typeof value === "number") return String(value);
    if(typeof value === "string") {
      const s = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${s}"`;
    }
    throw new Error(`Unsupported value type: ${typeof value}`);
  },

  parse(text) {
    if(!text) return null;
    text = text.trim();
    if(!text) return null;
    if(text[0] === '"' || text[0] === "'") {
      const quote = text[0];
      let i = 1; const chars = [];
      while(i < text.length) {
        const ch = text[i];
        if(ch === "\\" && i + 1 < text.length) {
          const nxt = text[i + 1];
          if(nxt === quote) { chars.push(quote); i += 2; continue; }
          if(nxt === "\\") { chars.push("\\"); i += 2; continue; }
        }
        if(ch === quote) break;
        chars.push(ch);
        i++;
      }
      return chars.join("");
    }
    const low = text.toLowerCase();
    if(low === "true") return true;
    if(low === "false") return false;
    if(/^-?0x[0-9a-fA-F]+$/.test(text)) return parseInt(text, 16);
    if(/^0b[01]+$/.test(text)) return Number(text);
    if(/^0o[0-7]+$/.test(text)) return Number(text);
    if(/^[+-]?\d+$/.test(text)) return parseInt(text, 10);
    const f = parseFloat(text);
    if(!isNaN(f)) return f;
    return text;
  },

  _splitInlineComment(text) {
    let i = 0;
    if(text[0] === '"' || text[0] === "'") {
      const q = text[0];
      i = 1;
      while(i < text.length) {
        if(text[i] === "\\" && i + 1 < text.length) { i += 2; continue; }
        if(text[i] === q) { i++; break; }
        i++;
      }
    }
    for(; i < text.length; i++) {
      if(text[i] === ";" || text[i] === "#") {
        return [text.slice(0, i).trimEnd(), text.slice(i + 1).trim()];
      }
    }
    return [text, null];
  },

  parse_text(content, opts={}) {
    const ini = {};
    const wc = opts.comments || false;
    const commentSection = {};
    const commentField = {};
    let section = null;
    let pending = [];
    for(const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if(!line || line[0] === ";" || line[0] === "#") {
        if(wc && line) pending.push(line.slice(1).trim());
        continue;
      }
      if(line.startsWith("[") && line.includes("]")) {
        section = line.slice(1, line.indexOf("]")).trim();
        ini[section] = {};
        if(wc && pending.length) commentSection[section] = pending.join("\n");
        pending = [];
        continue;
      }
      pending = [];
      if(!line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let rest = line.slice(eq + 1).trim();
      let inlineComment = null;
      if(rest) {
        if(wc) [rest, inlineComment] = INI._splitInlineComment(rest);
        else rest = INI._splitInlineComment(rest)[0];
      }
      const value = INI.parse(rest);
      if(section !== null) ini[section][key] = value;
      else ini[key] = value;
      if(wc && inlineComment) {
        const sk = section !== null ? section : null;
        if(!commentField[sk]) commentField[sk] = {};
        commentField[sk][key] = inlineComment;
      }
    }
    if(wc) return { data: ini, commentSection, commentField };
    return ini;
  },

  stringify(data, commentSection={}, commentField={}, commentSectionChar="# ", commentFieldChar=" # ") {
    const lines = [];
    let wroteAnything = false;
    const topFieldComments = commentField[null] || {};
    for(const [key, value] of Object.entries(data)) {
      if(typeof value === "object" && value !== null && !Array.isArray(value)) continue;
      let val = value, inlineComment = null;
      if(Array.isArray(value) && value.length === 2 && typeof value[1] === "string") {
        [val, inlineComment] = value;
      }
      if(key in topFieldComments) inlineComment = topFieldComments[key];
      let line = `${key} = ${INI.format(val)}`;
      if(inlineComment) line += `${commentFieldChar}${inlineComment}`;
      lines.push(line);
      wroteAnything = true;
    }
    for(const [section, content] of Object.entries(data)) {
      if(typeof content !== "object" || content === null || Array.isArray(content)) continue;
      if(wroteAnything) lines.push("");
      const sectionComment = commentSection[section];
      if(sectionComment) {
        for(const cl of String(sectionComment).split("\n")) {
          const t = cl.trim();
          if(t) lines.push(`${commentSectionChar}${t}`);
        }
      }
      lines.push(`[${section}]`);
      const sectionFieldComments = commentField[section] || {};
      for(const [key, value] of Object.entries(content)) {
        let val = value, inlineComment = null;
        if(Array.isArray(value) && value.length === 2 && typeof value[1] === "string") {
          [val, inlineComment] = value;
        }
        if(key in sectionFieldComments) inlineComment = sectionFieldComments[key];
        let line = `${key} = ${INI.format(val)}`;
        if(inlineComment) line += `${commentFieldChar}${inlineComment}`;
        lines.push(line);
      }
      wroteAnything = true;
    }
    return lines.join("\n") + "\n";
  },

  /** Parse a File object. */
  async load(file) {
    const text = await file.text();
    return INI.parse_text(text);
  },

  /** Download as INI. */
  save(filename, data, commentSection, commentField) {
    const content = INI.stringify(data, commentSection, commentField);
    _download(filename, content);
  },

  /** File picker, parsed as INI. */
  async open(accept=".ini") {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = accept;
      input.onchange = async () => {
        const file = input.files[0];
        if(!file) { resolve(null); return; }
        try { resolve(await INI.load(file)); }
        catch(e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
};

//---------------------------------------------------------------------------------------- JSON

JSON.smart = function(obj, indent=2, maxLine=100, arrayWrap=10, compactDict=true) {
  function isPrimitive(v) {
    return v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
  }
  function isNumericArray(v) {
    return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "number");
  }
  function is2dNumeric(v) {
    return Array.isArray(v) && v.length > 0 && v.every(row => isNumericArray(row));
  }
  function isFlatDict(v) {
    return v && typeof v === "object" && !Array.isArray(v) &&
      Object.values(v).every(val => isPrimitive(val));
  }
  function fitsLine(v) { return JSON.stringify(v).length <= maxLine; }
  function pad(depth) { return " ".repeat(depth * indent); }
  function padInner(depth) { return " ".repeat((depth + 1) * indent); }

  function formatNumericArray(arr, depth) {
    if(arr.length <= arrayWrap && fitsLine(arr)) return JSON.stringify(arr);
    const chunks = [];
    for(let i = 0; i < arr.length; i += arrayWrap) chunks.push(arr.slice(i, i + arrayWrap));
    const lines = chunks.map(c => JSON.stringify(c).slice(1, -1));
    return "[\n" + padInner(depth) + lines.join(",\n" + padInner(depth)) + "\n" + pad(depth) + "]";
  }

  function formatNumericRow(arr, baseIndent) {
    if(fitsLine(arr)) return JSON.stringify(arr);
    const chunks = [];
    for(let i = 0; i < arr.length; i += arrayWrap) chunks.push(arr.slice(i, i + arrayWrap));
    if(chunks.length === 1) return "[ " + JSON.stringify(chunks[0]).slice(1, -1) + " ]";
    return chunks.map((c, i) => {
      const s = JSON.stringify(c).slice(1, -1);
      if(i === 0) return "[ " + s + ",";
      if(i === chunks.length - 1) return "  " + s + " ]";
      return "  " + s + ",";
    }).join("\n" + baseIndent);
  }

  function format2dNumeric(arr, depth) {
    const rows = arr.map(row => formatNumericRow(row, padInner(depth)));
    return "[\n" + padInner(depth) + rows.join(",\n" + padInner(depth)) + "\n" + pad(depth) + "]";
  }

  function formatFlatDict(d, depth) {
    const entries = Object.entries(d).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    const lines = [], current = [];
    let length = 0;
    for(const entry of entries) {
      const added = entry.length + (current.length ? 2 : 0);
      if(current.length && length + added > maxLine) {
        lines.push(current.join(", ")); current.length = 0; length = 0;
      }
      current.push(entry); length += added;
    }
    if(current.length) lines.push(current.join(", "));
    return "{\n" + padInner(depth) + lines.join(",\n" + padInner(depth)) + "\n" + pad(depth) + "}";
  }

  function fmt(v, depth=0) {
    if(isPrimitive(v)) return JSON.stringify(v);
    if(is2dNumeric(v)) return format2dNumeric(v, depth);
    if(isNumericArray(v)) return formatNumericArray(v, depth);
    if(Array.isArray(v)) {
      if(!v.length) return "[]";
      if(fitsLine(v)) return JSON.stringify(v);
      const items = v.map(x => fmt(x, depth + 1));
      return "[\n" + padInner(depth) + items.join(",\n" + padInner(depth)) + "\n" + pad(depth) + "]";
    }
    if(v && typeof v === "object") {
      if(!Object.keys(v).length) return "{}";
      if(fitsLine(v)) return JSON.stringify(v);
      if(compactDict && isFlatDict(v)) return formatFlatDict(v, depth);
      const items = Object.entries(v).map(([k, val]) =>
        `${JSON.stringify(k)}: ${fmt(val, depth + 1)}`
      );
      return "{\n" + padInner(depth) + items.join(",\n" + padInner(depth)) + "\n" + pad(depth) + "}";
    }
    return JSON.stringify(v);
  }

  return fmt(obj);
};

JSON.load = async function(file) {
  return JSON.parse(await file.text());
};

JSON.save = function(filename, data, pretty=false, indent=2) {
  const content = pretty ? JSON.stringify(data, null, indent) + "\n" : JSON.stringify(data);
  _download(filename, content, "application/json");
};

JSON.save_smart = function(filename, data, maxLine=100, arrayWrap=10, compactDict=true) {
  _download(filename, JSON.smart(data, 2, maxLine, arrayWrap, compactDict), "application/json");
};

JSON.open = async function(accept=".json") {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept;
    input.onchange = async () => {
      const file = input.files[0];
      if(!file) { resolve(null); return; }
      try { resolve(await JSON.load(file)); }
      catch(e) { reject(e); }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
};

//---------------------------------------------------------------------------------------- YAML

const YAML = {

  parse(text) {
    if(!text) return null;
    return jsyaml.load(text);
  },

  stringify(data, opts={}) {
    return jsyaml.dump(data, {
      indent: 2, lineWidth: 95, sortKeys: false,
      quotingType: '"', forceQuotes: false, noRefs: true,
      ...opts
    });
  },

  async load(file) {
    const text = await file.text();
    return YAML.parse(text);
  },

  save(filename, data, opts) {
    _download(filename, YAML.stringify(data, opts), "application/x-yaml");
  },

  async open(accept=".yaml,.yml") {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = accept;
      input.onchange = async () => {
        const file = input.files[0];
        if(!file) { resolve(null); return; }
        try { resolve(await YAML.load(file)); }
        catch(e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
};
//----------------------------------------------------------------------------------------- ZIP

// Wymaga fflate (window.fflate). unpack zwraca Uint8Array per entry.

const ZIP = {

  /** Dowolny content do Uint8Array (format wejscia fflate). */
  async _toBytes(content) {
    if(typeof content === "string") return new TextEncoder().encode(content);
    if(content instanceof Uint8Array) return content;
    if(content instanceof ArrayBuffer) return new Uint8Array(content);
    if(content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
    throw new TypeError("ZIP: content must be string, Uint8Array, ArrayBuffer or Blob");
  },

  /** entries: [{name, content}] do Blob (application/zip). */
  async pack(entries) {
    const input = {};
    for(const { name, content } of entries) {
      input[name] = await ZIP._toBytes(content);
    }
    return new Promise((resolve, reject) => {
      fflate.zip(input, { level: 6 }, (err, data) => {
        if(err) reject(err);
        else resolve(new Blob([data], { type: "application/zip" }));
      });
    });
  },

  /** Blob/ArrayBuffer/Uint8Array do [{name, content: Uint8Array}]. */
  async unpack(data) {
    const bytes = await ZIP._toBytes(data);
    return new Promise((resolve, reject) => {
      fflate.unzip(bytes, (err, unzipped) => {
        if(err) reject(err);
        else resolve(Object.entries(unzipped).map(([name, content]) => ({ name, content })));
      });
    });
  },

  async load(file) {
    return ZIP.unpack(file);
  },

  async save(filename, entries) {
    const blob = await ZIP.pack(entries);
    _download(filename, blob, "application/zip");
  },

  async open(accept=".zip") {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = accept;
      input.onchange = async () => {
        const file = input.files[0];
        if(!file) { resolve(null); return; }
        try { resolve(await ZIP.load(file)); }
        catch(e) { reject(e); }
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
};
