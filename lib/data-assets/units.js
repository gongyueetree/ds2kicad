// Decimal shifts operate on strings; never convert engineering values through binary floats.
const UNITS = {
  V: ['V', 0], mV: ['V', -3], uV: ['V', -6], nV: ['V', -9], kV: ['V', 3],
  A: ['A', 0], mA: ['A', -3], uA: ['A', -6], nA: ['A', -9], pA: ['A', -12],
  Hz: ['Hz', 0], kHz: ['Hz', 3], MHz: ['Hz', 6], GHz: ['Hz', 9],
  ohm: ['ohm', 0], mohm: ['ohm', -3], kohm: ['ohm', 3], Mohm: ['ohm', 6],
  s: ['s', 0], ms: ['s', -3], us: ['s', -6], ns: ['s', -9], ps: ['s', -12],
  C: ['C', 0], nC: ['C', -9], pC: ['C', -12], uC: ['C', -6],
  'V/s': ['V/s', 0], 'V/us': ['V/s', 6], 'V/ms': ['V/s', 3],
  'S/s': ['S/s', 0], 'kS/s': ['S/s', 3], 'MS/s': ['S/s', 6], 'GS/s': ['S/s', 9],
  SPS: ['S/s', 0], kSPS: ['S/s', 3], MSPS: ['S/s', 6],
  bit: ['bit', 0], bits: ['bit', 0], dB: ['dB', 0]
};
export function decimalShift(value, shift = 0) {
  const s = String(value).trim().replace(/−/g, '-');
  const m = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d{1,3}))?$/.exec(s);
  if (!m || s.length > 80) throw new Error('数值必须是十进制数字；范围、± 和不等式需要人工拆分');
  const [whole, frac = ''] = m[2].split('.');
  const digits = whole + frac;
  const point = whole.length + Number(m[3] || 0) + shift;
  if (Math.abs(point) > 100) throw new Error('数值指数超出允许范围');
  let result = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  result = result.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${m[1] === '-' && /[1-9]/.test(result) ? '-' : ''}${result}`;
}
export function compareDecimals(a,b) {
  a=decimalShift(a); b=decimalShift(b);
  const an=a.startsWith('-'),bn=b.startsWith('-');
  if(an!==bn)return an?-1:1;
  const [ai,af='']=a.replace(/^-/, '').split('.'),[bi,bf='']=b.replace(/^-/, '').split('.');
  const width=Math.max(af.length,bf.length);
  const result=ai.length!==bi.length ? Math.sign(ai.length-bi.length) : ai!==bi ? (ai<bi?-1:1) : af.padEnd(width,'0')===bf.padEnd(width,'0') ? 0 : af.padEnd(width,'0')<bf.padEnd(width,'0') ? -1 : 1;
  return an?-result:result;
}
export function normalizeValue(value, unit, expectedUnit) {
  const clean = String(unit || '').replace(/[µμ]/g, 'u').replace(/Ω/g, 'ohm').replace(/\s/g, '');
  const spec = UNITS[clean];
  if (!spec || spec[0] !== expectedUnit) throw new Error(`单位 ${unit || '缺失'} 与 ${expectedUnit} 不兼容`);
  const out = {};
  for (const k of ['min', 'typ', 'max']) out[k] = value?.[k] == null || value[k] === '' ? null : decimalShift(value[k], spec[1]);
  if (Object.values(out).every(v => v === null)) throw new Error('没有可归一的数值');
  if (out.min !== null && out.max !== null && compareDecimals(out.min,out.max)>0) throw new Error('Min 大于 Max');
  if (out.typ !== null && ((out.min !== null && compareDecimals(out.typ,out.min)<0) || (out.max !== null && compareDecimals(out.typ,out.max)>0))) throw new Error('Typ 不在 Min/Max 范围内');
  return { value: out, unit: spec[0], sourceUnit: unit, decimalShift: spec[1] };
}
