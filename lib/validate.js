// lib/validate.js — 输入校验与数据规整（纯函数，无副作用）

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[fc|\[fd|\[fe80)/i;

/** 校验用户提供的 PDF URL：仅 http/https，拒绝内网地址（SSRF 防护） */
export function validatePdfUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: 'URL 格式无效' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 链接' };
  }
  if (PRIVATE_HOST_RE.test(u.hostname)) {
    return { ok: false, error: '不允许访问内网地址' };
  }
  return { ok: true, url: u.toString() };
}

export const PIN_TYPES = [
  'input', 'output', 'bidirectional', 'power_in', 'power_out',
  'passive', 'tri_state', 'open_collector', 'no_connect', 'unspecified'
];

export const PACKAGE_TYPES = ['dual', 'qfn', 'dip', 'sot23', 'bga'];

/** 清洗管脚列表：保证编号/名称为字符串、类型合法、按编号排序（数字优先） */
const EP_ALIAS = /^(EP|EPAD|E-?PAD|PAD|DAP|TAB|THERMAL\s*PAD)$/i;

export function sanitizePins(pins) {
  return sanitizePinsDetailed(pins).pins;
}

/** item 3：保留 rawPins 与 transformationLog。任何转换（合并展开/EP 重编号/去重/类型回退/
 *  空名称）都必须留下结构化记录，并置 reviewRequired=true（下游据此阻断晋升）。 */
export function sanitizePinsDetailed(pins) {
  const rawPins = Array.isArray(pins) ? pins.map((p) => ({ ...p })) : [];
  const log = [];
  const out = [];
  const seen = new Map(); // number → 首次出现的索引
  for (let i = 0; i < rawPins.length; i++) {
    const p = rawPins[i];
    if (!p || p.number === undefined || p.number === null) {
      log.push({ op: 'drop_row', index: i, reason: 'missing_number' });
      continue;
    }
    const rawName = p.name === undefined || p.name === null ? '' : String(p.name).trim();
    let name = rawName;
    if (!name) {
      name = 'NC';
      log.push({ op: 'empty_name_to_nc', index: i, rawNumber: String(p.number) });
    }
    let type = p.type;
    if (!PIN_TYPES.includes(type)) {
      log.push({ op: 'invalid_type_fallback', index: i, rawType: p.type ?? null, normalizedType: 'unspecified' });
      type = 'unspecified';
    }
    const base = { name, rawName, type, rawType: p.type ?? null, description: String(p.description ?? '').trim() };
    const rawNumber = String(p.number);
    const tokens = rawNumber.split(/[,、/;\s]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 1) {
      log.push({ op: 'merged_row_expanded', index: i, rawNumber, expandedTo: tokens });
    }
    for (const tok of tokens.length ? tokens : ['']) {
      if (!tok) { log.push({ op: 'drop_row', index: i, reason: 'empty_number_token' }); continue; }
      const key = tok.toUpperCase();
      if (seen.has(key)) {
        log.push({ op: 'duplicate_number_dropped', index: i, number: tok, firstIndex: seen.get(key) });
        continue;
      }
      seen.set(key, i);
      out.push({ number: tok, rawNumber, ...base });
    }
  }
  // EP 别名重编号
  const maxNum = out.reduce((m, p) => (/^\d+$/.test(p.number) ? Math.max(m, +p.number) : m), 0);
  let epNext = maxNum + 1;
  for (const p of out) {
    if (EP_ALIAS.test(p.number)) {
      const from = p.number;
      if (p.name === 'NC' || EP_ALIAS.test(p.name)) p.name = 'EP';
      p.number = String(epNext++);
      if (p.type === 'unspecified') p.type = 'passive';
      log.push({ op: 'ep_renumbered', from, to: p.number });
    }
  }
  out.sort((a, b) => {
    const na = Number(a.number), nb = Number(b.number);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.number.localeCompare(b.number, 'en', { numeric: true });
  });
  return { pins: out, rawPins, transformationLog: log, reviewRequired: log.length > 0 };
}

const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** 清洗封装参数：数值边界保护，缺省合理默认（确定性引擎的唯一入口） */
/** item 5：family 由服务端根据 type/name 与"受支持生成器"共同判定，客户端提交的 family 一律忽略。
 *  未知/不受支持家族返回 supported:false，禁止以 dual/QFN 近似。 */
export const SUPPORTED_FAMILIES = ['dual', 'qfn', 'dip', 'sot23'];

export function resolveFamily(pkg) {
  const t = `${pkg?.type || ''} ${pkg?.name || ''}`.trim();
  const guessed = guessFamily(t);              // 纯文本判定，不看客户端 family
  const pc = Number(pkg?.pinCount);
  let family = guessed;
  const notes = [];
  if (family === 'sot23' && Number.isInteger(pc) && pc !== 3) {
    family = 'dual';
    notes.push('sot23_generator_is_3pin_only_routed_to_dual');
  }
  const supported = SUPPORTED_FAMILIES.includes(family);
  if (!supported) notes.push(`unsupported_family:${family}`);
  return { family, supported, notes, source: 'server_resolved_from_type_name' };
}

export function sanitizePackage(pkg) {
  const p = pkg || {};
  const fam = resolveFamily(p);
  const family = fam.family;

  const prov = {};
  const priorProv = p.fieldProvenance || {};
  const errors = [];

  const record = (key, entry) => { prov[key] = entry; };

  /** 必需数值字段：无默认掩盖，缺失/越界均留痕 */
  const field = (key, def, min, max, { integer = false } = {}) => {
    if (priorProv[key] && priorProv[key].source !== 'reviewer') {
      record(key, priorProv[key]);
      const v = Number(priorProv[key].normalizedValue);
      return Number.isFinite(v) ? v : def;
    }
    if (priorProv[key]?.source === 'reviewer') {
      const rv = Number(p[key] ?? priorProv[key].normalizedValue);
      if (!Number.isFinite(rv) || rv < min || rv > max || (integer && !Number.isInteger(rv))) {
        record(key, { ...priorProv[key], source: 'clamped', rawValue: rv, normalizedValue: Math.min(Math.max(Number.isFinite(rv) ? rv : def, min), max), reason: `reviewer_value_invalid[${min},${max}]${integer ? '_integer' : ''}` });
        return prov[key].normalizedValue;
      }
      record(key, { ...priorProv[key], normalizedValue: rv });
      return rv;
    }
    const raw = p[key];
    const v = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(v)) {
      record(key, { source: 'missing', rawValue: raw ?? null, normalizedValue: def, reason: 'not_provided_by_datasheet' });
      return def;
    }
    if (integer && !Number.isInteger(v)) {
      // item 4：pinCount 等整数字段非整数 → validation error，不四舍五入掩盖
      errors.push({ field: key, rawValue: v, error: 'must_be_integer' });
      record(key, { source: 'invalid', rawValue: v, normalizedValue: Math.round(v), reason: 'must_be_integer' });
      return Math.round(v);
    }
    if (v < min || v > max) {
      record(key, { source: 'clamped', rawValue: v, normalizedValue: Math.min(Math.max(v, min), max), reason: `out_of_range[${min},${max}]` });
      return prov[key].normalizedValue;
    }
    record(key, { source: 'datasheet', rawValue: v, normalizedValue: v });
    return v;
  };

  /** 可选数值字段：缺失记 absent（不阻断），越界/非法记 clamped（阻断） */
  const optionalField = (key, min, max) => {
    if (priorProv[key]) { record(key, priorProv[key]); const v = Number(priorProv[key].normalizedValue); return Number.isFinite(v) ? v : null; }
    const raw = p[key];
    if (raw === null || raw === undefined || raw === '' || Number(raw) === 0) {
      record(key, { source: 'absent', rawValue: raw ?? null, normalizedValue: null });
      return null;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      record(key, { source: 'invalid', rawValue: raw, normalizedValue: null, reason: 'not_a_number' });
      errors.push({ field: key, rawValue: raw, error: 'not_a_number' });
      return null;
    }
    if (v < min || v > max) {
      record(key, { source: 'clamped', rawValue: v, normalizedValue: Math.min(Math.max(v, min), max), reason: `out_of_range[${min},${max}]` });
      return prov[key].normalizedValue;
    }
    record(key, { source: 'datasheet', rawValue: v, normalizedValue: v });
    return v;
  };

  // 证据不可擦除：前次 sanitize 记录的 landPattern.* 等证据必须透传，
  // 否则"弃用非法 landPattern"会连同其违规证据一起消失（v0.8.2 修复）
  for (const [k, v] of Object.entries(priorProv)) {
    if (k.startsWith('landPattern.')) prov[k] = v;
  }
  const lp = sanitizeLandPatternProv(p.landPattern, prov);

  const out = {
    name: String(p.name ?? 'PKG').trim() || 'PKG',
    pinsetId: String(p.pinsetId ?? '').trim() || 'default',
    tiCode: String(p.tiCode ?? '').trim(),
    type: String(p.type ?? '').trim(),
    family,
    familySupported: fam.supported,
    familyProvenance: { source: fam.source, resolvedFrom: `${p.type || ''}|${p.name || ''}`, notes: fam.notes },
    pinCount: field('pinCount', 8, 2, 256, { integer: true }),
    pitch: field('pitch', family === 'qfn' ? 0.5 : 1.27, 0.2, 5.08),
    bodyLength: field('bodyLength', 4.9, 0.5, 80),
    bodyWidth: field('bodyWidth', 3.9, 0.5, 80),
    height: field('height', 1.0, 0.2, 10),
    leadSpan: field('leadSpan', 6.0, 0.5, 90),
    leadLength: field('leadLength', family === 'qfn' ? 0.4 : 1.0, 0.1, 5),
    leadWidth: optionalField('leadWidth', 0.05, 5),
    epLength: optionalField('epLength', 0.1, 60),
    epWidth: optionalField('epWidth', 0.1, 60),
    rowSpan: field('rowSpan', 7.62, 2.54, 30),
    drawingId: String(p.drawingId ?? '').trim().slice(0, 24),
    orderableParts: (Array.isArray(p.orderableParts) ? p.orderableParts : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 12),
    notes: (Array.isArray(p.notes) ? p.notes : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 4),
    sourcePages: (Array.isArray(p.sourcePages) ? p.sourcePages : [])
      .map((x) => Math.round(Number(x))).filter((x) => x >= 1).slice(0, 8),
    landPattern: lp
  };

  const CRIT = family === 'dip' ? ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'rowSpan', 'height']
    : family === 'qfn' ? ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'leadLength', 'height']
    : ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'leadSpan', 'height'];
  out.relevantFields = CRIT;
  for (const k of Object.keys(prov)) {
    if (!CRIT.includes(k) && prov[k].source === 'missing') prov[k] = { source: 'not_applicable', normalizedValue: prov[k].normalizedValue };
  }
  out.fieldProvenance = prov;
  out.validationErrors = errors;
  // item 6：无手册 land pattern → 焊盘将由规则推导，必须标记 derived
  out.landPatternSource = lp ? 'datasheet' : 'derived_by_rules';
  out.missingFields = CRIT.filter((k) => prov[k] && (prov[k].source === 'missing' || prov[k].source === 'clamped' || prov[k].source === 'invalid'
    || (prov[k].source === 'reviewer' && !prov[k].reviewer)));
  return out;
}

/** land pattern 清洗并记录每个子字段 provenance（item 4：不得漏 landPattern） */
function sanitizeLandPatternProv(lp, prov) {
  if (!lp || typeof lp !== 'object') return null;
  const rng = { padW: [0.1, 5], padL: [0.1, 6], rowSpan: [1, 90], holeDia: [0.3, 3] };
  const out = {};
  let fatal = false;
  for (const k of ['padW', 'padL', 'rowSpan', 'holeDia']) {
    const raw = lp[k];
    if (raw === null || raw === undefined || raw === '') continue;
    const v = Number(raw);
    const [min, max] = rng[k];
    if (!Number.isFinite(v)) { prov[`landPattern.${k}`] = { source: 'invalid', rawValue: raw, normalizedValue: null, reason: 'not_a_number' }; fatal = true; continue; }
    if (v < min || v > max) {
      prov[`landPattern.${k}`] = { source: 'clamped', rawValue: v, normalizedValue: Math.min(Math.max(v, min), max), reason: `out_of_range[${min},${max}]` };
      out[k] = prov[`landPattern.${k}`].normalizedValue;
      fatal = true;
      continue;
    }
    prov[`landPattern.${k}`] = { source: 'datasheet', rawValue: v, normalizedValue: v };
    out[k] = v;
  }
  const sp = Math.round(Number(lp.sourcePage));
  if (sp >= 1) out.sourcePage = sp;
  // 任一子字段越界/非法 → 整份推荐焊盘弃用（回退规则推导），provenance 已留痕并阻断晋升
  if (fatal) return null;
  if (!out.padW || !out.padL || !out.rowSpan) return null;
  return out;
}


/** 可选数值字段（缺失即 null，不算 missing；越界记 clamped） */
function optional(p, key, prov, min, max) {
  const priorProv = p.fieldProvenance || {};
  if (priorProv[key]) { prov[key] = priorProv[key]; const v = Number(priorProv[key].normalizedValue); return Number.isFinite(v) ? v : null; }
  const raw = p[key];
  if (raw === null || raw === undefined || raw === '' || Number(raw) === 0) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  if (v < min || v > max) {
    const c = Math.min(Math.max(v, min), max);
    prov[key] = { source: 'clamped', rawValue: v, normalizedValue: c, reason: `out_of_range[${min},${max}]` };
    return c;
  }
  prov[key] = { source: 'datasheet', rawValue: v, normalizedValue: v };
  return v;
}


export function guessFamily(typeStr) {
  const t = String(typeStr || '').toUpperCase();
  if (/LFCSP/.test(t)) return 'qfn'; // ADI LFCSP = QFN 等价（含 EP），必须先于 CSP 判定
  if (/BGA|DSBGA|WLCSP|WCSP|FCBGA|(?<!LF)CSP\b/.test(t)) return 'bga'; // 封装/3D 暂不支持，仅生成符号变体
  if (/LCCC|PLCC|CLCC|\bLCC\b/.test(t)) return 'lcc';   // J 形引脚/castellation 未实现 → 不受支持，绝不按 QFN 近似
  if (/QFN|DFN|SON|X2SON|WSON/.test(t)) return 'qfn';
  if (/DIP|PDIP/.test(t)) return 'dip';
  if (/SOT[- ]?23(?![-\d])|SOT23-3\b/.test(t)) return 'sot23'; // 仅 3 脚 SOT-23；SOT-23-5/6 走 dual
  return 'dual'; // SOIC/TSSOP/SSOP/MSOP/SOP/SOT-23-5/6 等双列贴片
}

/** 清洗图区列表（页码 1 起，bbox 为页面归一化坐标 [x0,y0,x1,y1]，原点左上） */
export function sanitizeFigures(figures) {
  if (!Array.isArray(figures)) return [];
  return figures
    .map((f) => {
      const bbox = Array.isArray(f?.bbox) && f.bbox.length === 4
        ? f.bbox.map((v) => Math.min(1, Math.max(0, Number(v) || 0)))
        : [0.1, 0.1, 0.9, 0.6];
      if (bbox[2] <= bbox[0]) bbox[2] = Math.min(1, bbox[0] + 0.3);
      if (bbox[3] <= bbox[1]) bbox[3] = Math.min(1, bbox[1] + 0.3);
      return {
        kind: ['block_diagram', 'application', 'pin_configuration'].includes(f?.kind) ? f.kind : 'application',
        title: String(f?.title ?? '').trim() || (f?.kind === 'block_diagram' ? 'Functional Block Diagram' : f?.kind === 'pin_configuration' ? 'Pin Configuration' : 'Application Example'),
        page: Math.max(1, Math.round(Number(f?.page) || 1)),
        bbox
      };
    })
    .slice(0, 12);
}

/** pinsets 清洗：数组 [{id,label,pins}]；空/非法回退单一 default 集 */
export function sanitizePinsets(pinsets, fallbackPins) {
  const out = [];
  const seen = new Set();
  for (const ps of Array.isArray(pinsets) ? pinsets : []) {
    const id = String(ps?.id ?? '').trim() || `set${out.length + 1}`;
    if (seen.has(id)) continue;
    const pins = sanitizePins(ps?.pins);
    if (!pins.length) continue;
    seen.add(id);
    out.push({ id, label: String(ps?.label ?? '').trim().slice(0, 60), pins });
  }
  if (!out.length) {
    const pins = sanitizePins(fallbackPins);
    if (pins.length) out.push({ id: 'default', label: '', pins });
  }
  return out;
}

/** item 10：记录人工修改的字段来源。reviewer 必填（无标识 → 闸门判 UNVERIFIED_EDIT）；
 *  返回新 package 并由 sanitizePackage 重算 missingFields。 */
export function applyReviewerEdit(pkg, field, value, reviewer, reason = '') {
  const next = { ...pkg, [field]: value };
  const prov = { ...(pkg.fieldProvenance || {}) };
  const v = Number(value);
  prov[field] = {
    source: 'reviewer',
    rawValue: pkg?.fieldProvenance?.[field]?.rawValue ?? null,
    normalizedValue: Number.isFinite(v) ? v : value,
    reviewer: String(reviewer || '').trim() || null,
    reason: String(reason || '').slice(0, 200),
    at: new Date().toISOString()
  };
  next.fieldProvenance = prov;
  return sanitizePackage(next); // 重新计算 missingFields / relevantFields
}
