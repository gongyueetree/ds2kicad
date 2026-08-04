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
let pinSeq = 0;
const newPinId = () => `pin_${Date.now().toString(36)}_${(pinSeq++).toString(36)}`;

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
      // item 3：稳定 pinId —— 已有则保留（支持改编号后仍能定位），否则新建
      out.push({
        pinId: p.pinId || newPinId(), number: tok, rawNumber, ...base,
        // item 5：程序提取的管脚也带字段级证据（页码/bbox/原文由上游注入）
        evidence: p.evidence || undefined
      });
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
export const UNSUPPORTED_FAMILY_NOTES = {
  bga: 'BGA/DSBGA/WLCSP 需要球栅阵列引擎，未实现',
  lcc: 'LCCC/PLCC 的 J 形引脚/castellation 未实现',
  qfp: 'QFP/TQFP/LQFP 四边鸥翼引脚未实现',
  power_tab: 'TO/DPAK 类功率封装未实现',
  unknown: '无法从 type/name 识别封装类型，拒绝近似生成'
};

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
    if (priorProv[key]) {
      record(key, priorProv[key]);
      const nv = priorProv[key].normalizedValue;
      // 可选字段的 null 必须原样保留（Number(null)===0 会把"已清空"错误还原为 0）
      if (nv === null || nv === undefined) return null;
      const v = Number(nv);
      return Number.isFinite(v) ? v : null;
    }
    const raw = p[key];
    // 可选字段：null/undefined/''/0 一律视为"未提供"，返回 **null**（不得回落成 0）
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
  const lp = sanitizeLandPatternProv(p.landPattern, prov, { reviewed: !!p.landPatternReviewed, priorProv });

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
    landPattern: lp,
    evidence: p.evidence || null,        // item 6：字段级证据锚点必须透传到闸门
    packageId: p.packageId || null
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
  const lpReviewer = lp && Object.keys(prov).some((k) => k.startsWith('landPattern.') && prov[k].source === 'reviewer');
  out.landPatternSource = !lp ? 'derived_by_rules' : lpReviewer ? 'reviewer_entered' : 'datasheet';
  out.landPatternReviewed = !!p.landPatternReviewed || lpReviewer;
  out.missingFields = CRIT.filter((k) => prov[k] && (prov[k].source === 'missing' || prov[k].source === 'clamped' || prov[k].source === 'invalid'
    || (prov[k].source === 'reviewer' && !prov[k].reviewer)));
  return out;
}

/** land pattern 清洗并记录每个子字段 provenance（item 4：不得漏 landPattern） */
function sanitizeLandPatternProv(lp, prov, { reviewed = false, priorProv = {} } = {}) {
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
    // item 7：人工录入的 land pattern 必须保持 reviewer 来源，绝不重标 datasheet
    const prior = priorProv[`landPattern.${k}`];
    if (prior?.source === 'reviewer') prov[`landPattern.${k}`] = { ...prior, normalizedValue: v };
    else if (reviewed) prov[`landPattern.${k}`] = { source: 'reviewer', rawValue: prior?.rawValue ?? null, normalizedValue: v, reviewer: lp.reviewer || null, at: lp.reviewedAt || null };
    else prov[`landPattern.${k}`] = { source: 'datasheet', rawValue: v, normalizedValue: v };
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


/** item 6：严格 allowlist。只对明确识别的封装类型返回受支持家族；
 *  未知类型返回 'unknown'（不受支持），**禁止默认回退 dual**。 */
export function guessFamily(typeStr) {
  const t = String(typeStr || '').toUpperCase();
  // 明确不受支持（有名有姓但引擎未实现）
  if (/BGA|DSBGA|WLCSP|WCSP|FCBGA|\bCSP\b/.test(t) && !/LFCSP/.test(t)) return 'bga';
  if (/LCCC|PLCC|CLCC|\bLCC\b/.test(t)) return 'lcc';
  if (/\bQFP\b|TQFP|LQFP|MQFP/.test(t)) return 'qfp';        // 四边鸥翼，未实现
  if (/TO-?\d|SOT-?223|DPAK|D2PAK/.test(t)) return 'power_tab'; // 功率封装，未实现
  // 受支持家族（明确 allowlist）
  if (/LFCSP|QFN|DFN|SON|WSON|X2SON|VQFN|UQFN|WQFN|HVQFN/.test(t)) return 'qfn';
  if (/SOT-?23-?[56]|TSOT-?23/.test(t)) return 'dual';         // 5/6 脚小外形按双列鸥翼
  if (/SOT-?23(?![-\d])|SOT-?23-?3/.test(t)) return 'sot23';
  if (/SC-?70|SOT-?353|SOT-?363/.test(t)) return 'dual';
  if (/\bSOIC\b|\bSOP\b|\bSO-?\d|\bTSSOP\b|\bSSOP\b|\bMSOP\b|\bVSSOP\b|\bHTSSOP\b|\bQSOP\b|\bTVSOP\b/.test(t)) return 'dual';
  if (/\bPDIP\b|\bDIP\b|\bCDIP\b|\bCERDIP\b/.test(t)) return 'dip';
  return 'unknown';   // 未知类型：不受支持，不得近似
}

/** 清洗图区列表（页码 1 起，bbox 为页面归一化坐标 [x0,y0,x1,y1]，原点左上） */
export function sanitizeFigures(figures) {
  if (!Array.isArray(figures)) return [];
  return figures
    .map((f) => {
      const bbox = Array.isArray(f?.bbox) && f.bbox.length === 4
        ? f.bbox.map((v) => Math.min(1, Math.max(0, Number(v) || 0)))
        : [0.1, 0.1, 0.9, 0.6];
      // v0.8.8：坐标顺序错乱时**交换**而不是把边界外推 —— 原实现会把
      // [0.1,0.9,0.9,0.1]（y 倒序，常见于 AI 混淆左上/左下原点）修成 [0.1,0.9,0.9,1.0]，
      // 只剩页底一条窄缝，裁出来必然是空白。
      if (bbox[2] < bbox[0]) { const t = bbox[0]; bbox[0] = bbox[2]; bbox[2] = t; }
      if (bbox[3] < bbox[1]) { const t = bbox[1]; bbox[1] = bbox[3]; bbox[3] = t; }
      // 退化（过窄/过矮）时给一个可用的最小区域，避免裁出空白条
      const MIN = 0.06;
      if (bbox[2] - bbox[0] < MIN) {
        const c = (bbox[0] + bbox[2]) / 2;
        bbox[0] = Math.max(0, c - 0.25); bbox[2] = Math.min(1, c + 0.25);
      }
      if (bbox[3] - bbox[1] < MIN) {
        const c = (bbox[1] + bbox[3]) / 2;
        bbox[1] = Math.max(0, c - 0.18); bbox[3] = Math.min(1, c + 0.18);
      }
      return {
        kind: ['block_diagram', 'application', 'pin_configuration', 'package_outline'].includes(f?.kind) ? f.kind : 'application',
        title: String(f?.title ?? '').trim() || ({
          block_diagram: 'Functional Block Diagram',
          pin_configuration: 'Pin Configuration',
          package_outline: 'Package Outline',
          application: 'Application Example'
        }[f?.kind] || 'Application Example'),
        page: Math.max(1, Math.round(Number(f?.page) || 1)),
        bbox
      };
    })
    .slice(0, 12);
}

/** item 5：pinsets 清洗并**保留完整证据**：rawPins / normalizedPins / transformationLog /
 *  reviewRequired。二次清洗时证据必须透传，不得因再次 sanitize 而消失。 */
export function sanitizePinsets(pinsets, fallbackPins) {
  const out = [];
  const seen = new Set();
  for (const ps of Array.isArray(pinsets) ? pinsets : []) {
    const id = String(ps?.id ?? '').trim() || `set${out.length + 1}`;
    if (seen.has(id)) continue;
    // 若已带证据（二次清洗），直接透传证据并以 rawPins 为准重算
    const source = Array.isArray(ps?.rawPins) && ps.rawPins.length ? ps.rawPins : ps?.pins;
    const det = sanitizePinsDetailed(source);
    if (!det.pins.length) continue;
    seen.add(id);
    const priorLog = Array.isArray(ps?.transformationLog) ? ps.transformationLog : [];
    const mergedLog = dedupeLog([...priorLog, ...det.transformationLog]);
    // 人工审核修改必须覆盖在重算结果之上：以 number 为键把 reviewerEdited 字段合并回来，
    // 否则"从 rawPins 重算"会把审核者的修改冲掉（v0.8.3 反例测试发现）
    const priorNorm = Array.isArray(ps?.normalizedPins) ? ps.normalizedPins : [];
    // item 3：以 pinId 为准合并人工修改（编号可被修改，故不能用 number 做键）
    const editedById = new Map();
    const idByRawNumber = new Map();
    for (const p of priorNorm) {
      if (!p) continue;
      if (p.pinId) idByRawNumber.set(String(p.rawNumber ?? p.number), p.pinId);
      if (p.reviewerEdited) editedById.set(p.pinId || String(p.number), p);
    }
    let finalPins = det.pins.map((p) => {
      // 已有稳定 ID 优先于本次新生成的 ID（否则人工修改无法定位）
      const stableId = idByRawNumber.get(String(p.rawNumber ?? p.number)) || p.pinId;
      const withId = { ...p, pinId: stableId };
      const e = editedById.get(withId.pinId) || editedById.get(String(withId.number));
      if (!e) return withId;
      const merged = { ...withId };
      for (const f of e.reviewerEdited) if (f in e) merged[f] = e[f];
      merged.reviewerEdited = e.reviewerEdited;
      // item 5：人工修改产生的 pin.evidence 必须在二次清洗后保留
      if (e.evidence) merged.evidence = { ...(withId.evidence || {}), ...e.evidence };
      return merged;
    });
    // 人工新增的管脚（不存在于 rawPins）必须保留
    const derivedIds = new Set(finalPins.map((p) => p.pinId));
    for (const p of priorNorm) {
      if (p?.reviewerAdded && !derivedIds.has(p.pinId)) finalPins.push({ ...p });
    }
    // 人工删除：墓碑集合持久保存，二次清洗时同样生效
    const tombstones = new Set([
      ...(Array.isArray(ps?.deletedPinIds) ? ps.deletedPinIds : []),
      ...priorNorm.filter((p) => p?.reviewerDeleted).map((p) => p.pinId)
    ].filter(Boolean));
    const tombRaw = new Set([
      ...(Array.isArray(ps?.deletedRawNumbers) ? ps.deletedRawNumbers.map(String) : []),
      ...priorNorm.filter((p) => p?.reviewerDeleted).map((p) => String(p.rawNumber ?? p.number))
    ].filter(Boolean));
    finalPins = finalPins.filter((p) =>
      !p.reviewerDeleted && !tombstones.has(p.pinId) &&
      !(p.rawNumber !== null && p.rawNumber !== undefined && tombRaw.has(String(p.rawNumber))));
    finalPins.sort((a, b) => {
      const na = Number(a.number), nb = Number(b.number);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), 'en', { numeric: true });
    });
    out.push({
      id,
      label: String(ps?.label ?? '').trim().slice(0, 60),
      deletedPinIds: [...tombstones],
      deletedRawNumbers: [...tombRaw],
      transformationsResolved: !!ps?.transformationsResolved,
      transformationResolution: ps?.transformationResolution || null,
      pins: finalPins,                 // 兼容旧字段名
      normalizedPins: finalPins,
      rawPins: det.rawPins,
      transformationLog: mergedLog,
      reviewRequired: ps?.transformationsResolved ? false : (mergedLog.length > 0 || !!ps?.reviewRequired)
    });
  }
  if (!out.length) {
    const det = sanitizePinsDetailed(fallbackPins);
    if (det.pins.length) {
      out.push({
        id: 'default', label: '',
        pins: det.pins, normalizedPins: det.pins, rawPins: det.rawPins,
        transformationLog: det.transformationLog, reviewRequired: det.reviewRequired
      });
    }
  }
  return out;
}

function dedupeLog(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
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
