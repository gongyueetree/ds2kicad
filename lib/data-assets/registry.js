// Versioned, deliberately bounded starter schemas. Unknown classes remain unknown.
const field = (id, label, unit, aliases) => ({ id, label, unit, aliases });
export const REGISTRY_VERSION = '1.0.0';
export const SCHEMAS = [
  { id: 'op_amp', label: '运算放大器', pattern: /operational amplifier|op[ -]?amp|运算放大器/i, fields: [
    field('supply_voltage', '供电电压', 'V', ['supply voltage', 'operating voltage', '供电电压']),
    field('input_offset_voltage', '输入失调电压', 'V', ['input offset voltage', 'offset voltage', '输入失调电压']),
    field('gain_bandwidth', '增益带宽积', 'Hz', ['gain bandwidth product', 'gain-bandwidth product', 'gain bandwidth', '增益带宽积']),
    field('slew_rate', '压摆率', 'V/s', ['slew rate', '压摆率']),
    field('quiescent_current', '静态电流', 'A', ['quiescent current', 'supply current', '静态电流'])
  ] },
  { id: 'ldo', label: 'LDO 稳压器', pattern: /low[ -]dropout|\bLDO\b|低压差.*稳压/i, fields: [
    field('input_voltage', '输入电压', 'V', ['input voltage', '输入电压']),
    field('output_voltage', '输出电压', 'V', ['output voltage', '输出电压']),
    field('output_current', '输出电流', 'A', ['output current', '输出电流']),
    field('dropout_voltage', '压差', 'V', ['dropout voltage', '压差']),
    field('quiescent_current', '静态电流', 'A', ['quiescent current', 'ground current', '静态电流'])
  ] },
  { id: 'mosfet', label: 'MOSFET', pattern: /\bMOSFET\b|power mos transistor|场效应管/i, fields: [
    field('drain_source_voltage', '漏源电压', 'V', ['drain-source voltage', 'drain source voltage', '漏源电压']),
    field('drain_current', '漏极电流', 'A', ['continuous drain current', 'drain current', '漏极电流']),
    field('on_resistance', '导通电阻', 'ohm', ['drain-source on-state resistance', 'on-state resistance', 'on resistance', '导通电阻']),
    field('gate_threshold_voltage', '栅极阈值电压', 'V', ['gate threshold voltage', 'gate-source threshold voltage', '阈值电压']),
    field('total_gate_charge', '总栅极电荷', 'C', ['total gate charge', '栅极电荷'])
  ] },
  { id: 'adc', label: 'ADC', pattern: /analog[ -]to[ -]digital converter|\bADC\b|模数转换器/i, fields: [
    field('resolution', '分辨率', 'bit', ['resolution', '分辨率']),
    field('sample_rate', '采样率', 'S/s', ['sampling rate', 'sample rate', '采样率']),
    field('supply_voltage', '供电电压', 'V', ['supply voltage', '供电电压']),
    field('snr', '信噪比', 'dB', ['signal-to-noise ratio', 'signal to noise ratio', '信噪比']),
    field('enob', '有效位数', 'bit', ['effective number of bits', 'enob', '有效位数'])
  ] },
  { id: 'analog_switch', label: '模拟开关', pattern: /analog switch|analog multiplexer|模拟开关|模拟多路/i, fields: [
    field('supply_voltage', '供电电压', 'V', ['supply voltage', '供电电压']),
    field('on_resistance', '导通电阻', 'ohm', ['on-state resistance', 'on resistance', 'on-resistance', '导通电阻']),
    field('bandwidth', '带宽', 'Hz', ['bandwidth', '带宽']),
    field('leakage_current', '漏电流', 'A', ['off leakage current', 'leakage current', '漏电流']),
    field('switching_time', '切换时间', 's', ['turn-on time', 'switching time', '切换时间'])
  ] }
];
export function schemaFor(id) { return SCHEMAS.find(s => s.id === id) || null; }
export function classify(part = {}, pages = []) {
  const title = `${part.title || ''} ${part.description_zh || ''}`;
  const intro = (pages[0]?.lines || []).map(l => l.text).join('\n').slice(0, 8000);
  const preferred = SCHEMAS.filter(s => s.pattern.test(title));
  const candidates = preferred.length ? preferred : SCHEMAS.filter(s => s.pattern.test(intro));
  return { categoryId: candidates.length === 1 ? candidates[0].id : 'unknown',
    candidates: candidates.map(s => s.id), registryVersion: REGISTRY_VERSION,
    method: preferred.length ? 'title_rule' : 'first_page_rule', status: 'needs_review' };
}
export function matchField(schema, name) {
  const normalized = String(name || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return schema?.fields.find(f => f.id === name || f.label === name || f.aliases.some(a => normalized.includes(a))) || null;
}
export function parameterPrompt() {
  return `"parameterObservations": [{"parameterId": <schema field id>, "name": <source label>, "value": {"min": <decimal string|null>, "typ": <decimal string|null>, "max": <decimal string|null>}, "unit": <exact source unit>, "nature": "absolute_maximum"|"recommended"|"guaranteed"|"typical"|"characterized"|"unknown", "conditions": <verbatim test conditions including inherited table headings and footnotes>, "appliesTo": [<explicit device or full ordering codes>], "page": <1-based PDF page>, "quotedText": <verbatim evidence including values>}], "categoryCandidate": <schema id or unknown>`;
}
export function schemaPrompt() {
  return SCHEMAS.map(s => `${s.id}: ${s.fields.map(f => `${f.id} (${f.unit})`).join(', ')}`).join('\n');
}
