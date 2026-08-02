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
  if (!Array.isArray(pins)) return [];
  const out = [];
  const seen = new Set();
  for (const p of pins) {
    if (!p || p.number === undefined || p.number === null) continue;
    const base = {
      name: String(p.name ?? '').trim() || 'NC',
      type: PIN_TYPES.includes(p.type) ? p.type : 'unspecified',
      description: String(p.description ?? '').trim()
    };
    // 数据手册常把同名管脚合并成一行（如 "1, 4, 9  GND"）——AI 可能照抄。
    // 确定性展开为独立管脚（KiCad 管脚编号必须唯一且不含分隔符）。
    const tokens = String(p.number).split(/[,、/;\s]+/).map((t) => t.trim()).filter(Boolean);
    for (const tok of tokens.length ? tokens : ['']) {
      if (!tok || seen.has(tok.toUpperCase())) continue;
      seen.add(tok.toUpperCase());
      out.push({ number: tok, ...base });
    }
  }
  // EP 别名（EPAD/PAD/DAP/TAB…）归一化为 最大数字编号+1，与封装引擎的 EP 焊盘编号约定一致
  const maxNum = out.reduce((m, p) => (/^\d+$/.test(p.number) ? Math.max(m, +p.number) : m), 0);
  let epNext = maxNum + 1;
  for (const p of out) {
    if (EP_ALIAS.test(p.number)) {
      if (p.name === 'NC' || EP_ALIAS.test(p.name)) p.name = 'EP';
      p.number = String(epNext++);
      if (p.type === 'unspecified') p.type = 'passive';
    }
  }
  out.sort((a, b) => {
    const na = Number(a.number), nb = Number(b.number);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.number.localeCompare(b.number, 'en', { numeric: true });
  });
  return out;
}

const num = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** 清洗封装参数：数值边界保护，缺省合理默认（确定性引擎的唯一入口） */
export function sanitizePackage(pkg) {
  const p = pkg || {};
  let family = PACKAGE_TYPES.includes(p.family) ? p.family : guessFamily(p.type || p.name);
  // sot23 家族是 3 脚专用生成器：引脚数不是 3 一律按双列鸥翼处理（SOT-23-5/6 等）
  const pc = Math.round(Number(p.pinCount) || 0);
  if (family === 'sot23' && pc !== 3) family = 'dual';
  // ── P0-5：数值不再静默 clamp。每个字段产出 provenance：
  //    datasheet（手册权威值） / default（缺失用默认，不可晋升） /
  //    clamped（越界，保留 rawValue，不可晋升） / reviewer（人工修改，需 reviewer 标识）
  const prov = {};
  const priorProv = p.fieldProvenance || {};
  const field = (key, def, min, max) => {
    if (priorProv[key] && priorProv[key].source !== 'reviewer') { // 透传已有证据，二次 sanitize 不得洗白
      prov[key] = priorProv[key];
      const v = Number(priorProv[key].normalizedValue);
      return Number.isFinite(v) ? v : def;
    }
    if (priorProv[key]?.source === 'reviewer') {  // 人工值：重新做范围校验，但保留 reviewer 证据
      const rv = Number(p[key] ?? priorProv[key].normalizedValue);
      if (!Number.isFinite(rv) || rv < min || rv > max) {
        prov[key] = { ...priorProv[key], source: 'clamped', rawValue: rv, normalizedValue: Math.min(Math.max(Number.isFinite(rv) ? rv : def, min), max), reason: `reviewer_value_out_of_range[${min},${max}]` };
        return prov[key].normalizedValue;
      }
      prov[key] = { ...priorProv[key], normalizedValue: rv };
      return rv;
    }
    const raw = p[key];
    const v = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(v)) {
      prov[key] = { source: 'missing', rawValue: raw ?? null, normalizedValue: def, reason: 'not_provided_by_datasheet' };
      return def;
    }
    if (v < min || v > max) {
      const c = Math.min(Math.max(v, min), max);
      prov[key] = { source: 'clamped', rawValue: v, normalizedValue: c, reason: `out_of_range[${min},${max}]` };
      return c;
    }
    prov[key] = { source: 'datasheet', rawValue: v, normalizedValue: v };
    return v;
  };

  const out = {
    name: String(p.name ?? 'PKG').trim() || 'PKG',
    pinsetId: String(p.pinsetId ?? '').trim() || 'default',
    tiCode: String(p.tiCode ?? '').trim(),
    type: String(p.type ?? '').trim(),
    family,
    pinCount: Math.round(field('pinCount', 8, 2, 256)),
    pitch: field('pitch', family === 'qfn' ? 0.5 : 1.27, 0.2, 5.08),
    bodyLength: field('bodyLength', 4.9, 0.5, 80),   // 沿引脚排列方向
    bodyWidth: field('bodyWidth', 3.9, 0.5, 80),     // 跨引脚方向
    height: field('height', 1.0, 0.2, 10),
    leadSpan: field('leadSpan', 6.0, 0.5, 90),
    leadLength: field('leadLength', family === 'qfn' ? 0.4 : 1.0, 0.1, 5),
    leadWidth: optional(p, 'leadWidth', prov, 0.1, 5),
    epLength: optional(p, 'epLength', prov, 0.1, 60),
    epWidth: optional(p, 'epWidth', prov, 0.1, 60),
    rowSpan: field('rowSpan', 7.62, 2.54, 30),
    drawingId: String(p.drawingId ?? '').trim().slice(0, 24),
    orderableParts: (Array.isArray(p.orderableParts) ? p.orderableParts : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 12),
    notes: (Array.isArray(p.notes) ? p.notes : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 4),
    sourcePages: (Array.isArray(p.sourcePages) ? p.sourcePages : [])
      .map((x) => Math.round(Number(x))).filter((x) => x >= 1).slice(0, 8),
    landPattern: sanitizeLandPattern(p.landPattern)
  };
  // 与该家族相关的关键字段才计入 missingFields / 才参与晋升判定
  const CRIT = family === 'dip' ? ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'rowSpan', 'height']
    : family === 'qfn' ? ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'leadLength', 'height']
    : ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'leadSpan', 'height'];
  out.relevantFields = CRIT;
  // 不适用于本家族的字段标记 not_applicable，避免闸门误判为缺失
  for (const k of Object.keys(prov)) {
    if (!CRIT.includes(k) && prov[k].source === 'missing') prov[k] = { source: 'not_applicable', normalizedValue: prov[k].normalizedValue };
  }
  out.fieldProvenance = prov;
  out.missingFields = CRIT.filter((k) => prov[k] && (prov[k].source === 'missing' || prov[k].source === 'clamped'
    || (prov[k].source === 'reviewer' && !prov[k].reviewer)));
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

/** 推荐 land pattern 清洗：字段不全/非法 → null（回退派生焊盘） */
function sanitizeLandPattern(lp) {
  if (!lp || typeof lp !== 'object') return null;
  const padW = num(lp.padW, 0, 0.1, 5);
  const padL = num(lp.padL, 0, 0.1, 6);
  const rowSpan = num(lp.rowSpan, 0, 1, 90);
  if (!padW || !padL || !rowSpan) return null;
  const out = { padW, padL, rowSpan };
  const hole = num(lp.holeDia, 0, 0.3, 3);
  if (hole) out.holeDia = hole;
  const sp = Math.round(Number(lp.sourcePage));
  if (sp >= 1) out.sourcePage = sp;
  return out;
}

export function guessFamily(typeStr) {
  const t = String(typeStr || '').toUpperCase();
  if (/LFCSP/.test(t)) return 'qfn'; // ADI LFCSP = QFN 等价（含 EP），必须先于 CSP 判定
  if (/BGA|DSBGA|WLCSP|WCSP|FCBGA|(?<!LF)CSP\b/.test(t)) return 'bga'; // 封装/3D 暂不支持，仅生成符号变体
  if (/LCCC|PLCC|CLCC|\bLCC\b/.test(t)) return 'qfn';   // 四边芯片载体按 QFN 近似（J 形引脚简化为侧焊端）
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
