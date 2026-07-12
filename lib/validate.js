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

export const PACKAGE_TYPES = ['dual', 'qfn', 'dip', 'sot23'];

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
    rowSpan: num(p.rowSpan, 7.62, 2.54, 30)       // DIP 孔距
  };
}

export function guessFamily(typeStr) {
  const t = String(typeStr || '').toUpperCase();
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
        kind: f?.kind === 'block_diagram' ? 'block_diagram' : 'application',
        title: String(f?.title ?? '').trim() || (f?.kind === 'block_diagram' ? 'Functional Block Diagram' : 'Application Example'),
        page: Math.max(1, Math.round(Number(f?.page) || 1)),
        bbox
      };
    })
    .slice(0, 12);
}
