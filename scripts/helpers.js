// scripts/helpers.js

const Reg = {

  lo(reg) { return Array.isArray(reg.id) ? Math.min(...reg.id) : reg.id; },
  hi(reg) { return Array.isArray(reg.id) ? Math.max(...reg.id) : reg.id; },

  label(reg) {
    const lo = Reg.lo(reg), hi = Reg.hi(reg);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  },

  ruleIndex(reg) {
    if(reg.type !== 'rule' || !reg.rule?.switch) return null;
    const switchName = reg.rule.switch;
    const sv = switchName in S.dirty ? S.dirty[switchName] : S.values[switchName];
    if(sv == null) return null;
    const units = reg.unit;
    if(!Array.isArray(units)) return null;
    const label = String(sv).toLowerCase();
    for(let i = 0; i < units.length; i++) {
      if(units[i].toLowerCase() === label) return i;
    }
    return null;
  },

  isInactive(reg) {
    if(reg.type !== 'rule') return false;
    return Reg.ruleIndex(reg) === null;
  },

  unit(reg) {
    const ri = Reg.ruleIndex(reg);
    if(Array.isArray(reg.unit)) return ri !== null ? reg.unit[ri] : '';
    return reg.unit || '';
  },

  getMin(reg) {
    const ri = Reg.ruleIndex(reg);
    const v = Array.isArray(reg.min) ? reg.min[ri ?? 0] : reg.min;
    return v != null ? v : 0;
  },

  getMax(reg) {
    const ri = Reg.ruleIndex(reg);
    const v = Array.isArray(reg.max) ? reg.max[ri ?? 0] : reg.max;
    return v != null ? v : 65535;
  },

  step(reg) {
    if(reg.rule?.pair) return 1;
    const ri = Reg.ruleIndex(reg);
    const s = Array.isArray(reg.scale) ? reg.scale[ri ?? 0] : reg.scale;
    return (s && s > 0) ? 1 / s : 1;
  },

  rws(reg) { return reg.rws || 'R'; },
  ro(reg) { return Reg.rws(reg) === 'R'; },
  rwsClass(reg) { return `rb-rws rb-${Reg.rws(reg).replace('s','').toLowerCase()}`; },

  display(reg, value) {
    if(value === null || value === undefined) return '';
    if(reg.rule?.pair) return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
    if(reg.type === 'hex') return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(4, '0');
    if(typeof value === 'number') {
      const step = Reg.step(reg);
      const dec = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
      return value.toFixed(dec);
    }
    return String(value);
  },

  parse(reg, str) {
    str = str.trim();
    if(!str) return null;
    if(str.startsWith('0x') || str.startsWith('0X')) return parseInt(str.slice(2), 16);
    if(str.startsWith('0b') || str.startsWith('0B')) return parseInt(str.slice(2), 2);
    if(Reg.isNumeric(reg)) {
      const v = parseFloat(str);
      return isNaN(v) ? null : v;
    }
    return str;
  },

  same(a, b) {
    if(a === b) return true;
    if(a == null && b == null) return true;
    return false;
  },

  isNumeric(reg) { return !['enum', 'bool', 'ver'].includes(reg.type); },
  isEnum(reg) { return reg.type === 'enum' && reg.enum; },
  isBool(reg) { return reg.type === 'bool'; },
  isVer(reg) { return reg.type === 'ver'; },

  snap(value, step) {
    if(step >= 1) return Math.round(value);
    const dec = Math.ceil(-Math.log10(step));
    return parseFloat(value.toFixed(dec));
  },

  outOfRange(reg, value) {
    if(value === null || value === undefined) return false;
    if(typeof value !== 'number') return false;
    if(Reg.isInactive(reg)) return false;
    return value < Reg.getMin(reg) || value > Reg.getMax(reg);
  },

  tooltip(reg) {
    const hex = Array.isArray(reg.hex) ? reg.hex.join(', ') : reg.hex;
    const unit = Array.isArray(reg.unit) ? reg.unit.join('/') : reg.unit;
    return [
      hex, `${reg.type} [${reg.rws}]`,
      unit ? `unit: ${unit}` : null,
      reg.scale != null && reg.scale !== 1 ? `scale: ${JSON.stringify(reg.scale)}` : null,
      reg.min != null ? `min: ${JSON.stringify(reg.min)}` : null,
      reg.max != null ? `max: ${JSON.stringify(reg.max)}` : null,
      reg.desc || null,
    ].filter(Boolean).join('\n');
  },

  filter(regs, query) {
    if(!query) return regs;
    const q = query.toLowerCase();
    return regs.filter(r => r.name.toLowerCase().includes(q));
  },

  blocks(regs) {
    if(!regs.length) return [];
    const s = [...regs].sort((a, b) => Reg.lo(a) - Reg.lo(b));
    const out = [[s[0]]];
    for(let i = 1; i < s.length; i++) {
      if(Reg.lo(s[i]) <= Reg.hi(out.at(-1).at(-1)) + 1) out.at(-1).push(s[i]);
      else out.push([s[i]]);
    }
    return out;
  },
};