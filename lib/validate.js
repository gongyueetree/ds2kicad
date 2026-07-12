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
export function sanitizePins(pins) {
  if (!Array.isArray(pins)) return [];
  const out = pins
    .filter((p) => p && (p.number !== undefined && p.number !== null))
    .map((p) => ({
      number: String(p.number).trim(),
      name: String(p.name ?? '').trim() || 'NC',
      type: PIN_TYPES.includes(p.type) ? p.type : 'unspecified',
      description: String(p.description ?? '').trim()
    }));
  out.sort((a, b) => {
    const na = Number(a.number), nb = Number(b.number);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.number.localeCompare(b.number);
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
  const family = PACKAGE_TYPES.includes(p.family) ? p.family : guessFamily(p.type || p.name);
  return {
    name: String(p.name ?? 'PKG').trim() || 'PKG',
    pinsetId: String(p.pinsetId ?? '').trim() || 'default',
    tiCode: String(p.tiCode ?? '').trim(),
    type: String(p.type ?? '').trim(),
    family,
    pinCount: Math.round(num(p.pinCount, 8, 2, 256)),
    pitch: num(p.pitch, family === 'qfn' ? 0.5 : 1.27, 0.2, 5.08),
    bodyLength: num(p.bodyLength, 4.9, 0.5, 80),   // 沿引脚排列方向
    bodyWidth: num(p.bodyWidth, 3.9, 0.5, 80),    // 跨引脚方向（dual: 两排间本体宽）
    height: num(p.height, 1.0, 0.2, 10),
    leadSpan: num(p.leadSpan, 6.0, 0.5, 90),      // dual/sot: 引脚外沿总跨距
    leadLength: num(p.leadLength, family === 'qfn' ? 0.4 : 1.0, 0.1, 5),
    leadWidth: num(p.leadWidth, 0, 0, 5) || null, // null → 由 pitch 推导
    epLength: num(p.epLength, 0, 0, 60) || null,  // 裸露焊盘（QFN），0/无 → null
    epWidth: num(p.epWidth, 0, 0, 60) || null,
    rowSpan: num(p.rowSpan, 7.62, 2.54, 30),      // DIP 孔距
    // ── 证据与溯源字段（移植自 GPT 版数据模型的洞察）──
    drawingId: String(p.drawingId ?? '').trim().slice(0, 24),           // 厂商机械图编号，如 D0008A
    orderableParts: (Array.isArray(p.orderableParts) ? p.orderableParts : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 12),       // 该封装下可订购型号
    notes: (Array.isArray(p.notes) ? p.notes : [])
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 4),        // AI/解析器对该封装的备注
    sourcePages: (Array.isArray(p.sourcePages) ? p.sourcePages : [])
      .map((x) => Math.round(Number(x))).filter((x) => x >= 1).slice(0, 8),
    landPattern: sanitizeLandPattern(p.landPattern)                      // 数据手册推荐焊盘（权威，优先于派生）
  };
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
  if (/BGA|DSBGA|WCSP|CSP|FCBGA/.test(t)) return 'bga'; // 封装/3D 暂不支持，仅生成符号变体
  if (/LCCC|PLCC|CLCC|\bLCC\b/.test(t)) return 'qfn';   // 四边芯片载体按 QFN 近似（J 形引脚简化为侧焊端）
  if (/QFN|DFN|SON|X2SON|WSON/.test(t)) return 'qfn';
  if (/DIP|PDIP/.test(t)) return 'dip';
  if (/SOT[- ]?23(?![\d])|SOT23-3\b/.test(t)) return 'sot23';
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
