// lib/promotion.js — 唯一晋升闸门（PromotionGate）。
// 全系统只有这一处判定"该产物能否作为正式资产发布"。任何非手册权威来源、任何近似、
// 任何冲突、任何缺件，都必须在这里塌陷为 nonPromotable=true，并给出机器可读 reasons。
// 原则：宁可判为不可晋升，不可漏判。新增不确定来源时必须在此登记，禁止在别处另立判断。

/** 机器可读的阻断原因枚举（稳定值，ezPLM 侧可依赖） */
export const BLOCK = {
  MOCK: 'mock_data',
  MISSING: 'missing_required_geometry',
  DEFAULT: 'default_value_used',
  CLAMPED: 'value_out_of_range_clamped',
  DERIVED: 'rule_or_jedec_derived',
  GEOMETRY_FIX: 'geometry_auto_corrected',
  PIN_CONFLICT: 'pin_count_or_number_conflict',
  UNSUPPORTED_PKG: 'unsupported_package_family',
  NO_OUTPUT: 'required_output_missing',
  UNVERIFIED_EDIT: 'reviewer_edit_without_provenance',
  VALIDATION: 'validation_error'
};

/** 告警文本 → 阻断原因的映射（几何/先验层以 warning 表达其不确定性） */
const WARNING_PATTERNS = [
  [/JEDEC 先验|派生值|标准值|按派生/, BLOCK.DERIVED],
  [/颠倒|已交换|收缩至|回退派生|弃用/, BLOCK.GEOMETRY_FIX],
  [/不一致|重复|冲突/, BLOCK.PIN_CONFLICT],
  [/blocked_missing_geometry/, BLOCK.MISSING],
  [/暂不支持|仅输出符号|仅符号/, BLOCK.UNSUPPORTED_PKG]
];

/**
 * 评估单个封装条目的可晋升性。
 * @param {object} ctx {
 *   mock, pkg, pins, warnings, files, family, blocked, requireFootprint
 * }
 * @returns {{nonPromotable:boolean, reasons:string[], details:object[]}}
 */
export function evaluateItem(ctx = {}) {
  const reasons = new Set();
  const details = [];
  const add = (code, detail) => { reasons.add(code); if (detail) details.push({ code, ...detail }); };

  if (ctx.mock) add(BLOCK.MOCK, { note: '演示数据，非真实提取' });

  const pkg = ctx.pkg || {};
  // 1) 缺失 / 默认 / 截断：以 fieldProvenance 为准（sanitizePackage 产出）
  const prov = pkg.fieldProvenance || {};
  const relevant = Array.isArray(pkg.relevantFields) ? pkg.relevantFields : Object.keys(prov);
  for (const [field, p] of Object.entries(prov)) {
    if (p.source === 'not_applicable') continue;
    if (p.source === 'reviewer') { if (!p.reviewer) add(BLOCK.UNVERIFIED_EDIT, { field }); continue; }
    if (!relevant.includes(field)) continue;   // 该家族不使用的字段不参与判定
    if (p.source === 'missing') add(BLOCK.MISSING, { field, reason: p.reason });
    else if (p.source === 'default') add(BLOCK.DEFAULT, { field, normalizedValue: p.normalizedValue });
    else if (p.source === 'clamped') add(BLOCK.CLAMPED, { field, rawValue: p.rawValue, normalizedValue: p.normalizedValue, reason: p.reason });
  }
  if (Array.isArray(pkg.missingFields) && pkg.missingFields.length) {
    add(BLOCK.MISSING, { fields: pkg.missingFields });
  }

  // 2) 未支持封装家族（BGA/LCCC/PLCC/未知）：绝不近似生成可发布封装
  if (ctx.unsupportedFamily) add(BLOCK.UNSUPPORTED_PKG, { family: ctx.family, note: ctx.unsupportedNote });

  // 3) 管脚与封装一致性
  const pinCount = Array.isArray(ctx.pins) ? ctx.pins.length : 0;
  if (pinCount && pkg.pinCount) {
    const withEp = pkg.epLength && pkg.epWidth ? pkg.pinCount + 1 : pkg.pinCount;
    if (pinCount !== pkg.pinCount && pinCount !== withEp) {
      add(BLOCK.PIN_CONFLICT, { pinsInTable: pinCount, packagePinCount: pkg.pinCount });
    }
  }
  if (Array.isArray(ctx.pins)) {
    const seen = new Set();
    for (const p of ctx.pins) {
      const k = String(p.number);
      if (seen.has(k)) { add(BLOCK.PIN_CONFLICT, { duplicateNumber: k }); break; }
      seen.add(k);
    }
  }

  // 4) 生成告警 → 阻断原因
  for (const w of ctx.warnings || []) {
    for (const [re, code] of WARNING_PATTERNS) {
      if (re.test(w)) { add(code, { warning: w }); break; }
    }
  }

  // 5) 缺输出文件
  if (ctx.blocked) add(BLOCK.MISSING, { note: 'blocked_missing_geometry' });
  if (ctx.requireFootprint !== false && !ctx.blocked) {
    const f = ctx.files || {};
    if (!f.kicadMod) add(BLOCK.NO_OUTPUT, { file: 'kicad_mod' });
    if (!f.wrl) add(BLOCK.NO_OUTPUT, { file: 'wrl' });
  }

  return { nonPromotable: reasons.size > 0, reasons: [...reasons], details };
}

/** 汇总多个条目 + 全局上下文（mock 等）→ bundle 级判定 */
export function evaluateBundle({ items = [], mock = false, extraReasons = [] } = {}) {
  const reasons = new Set(extraReasons);
  if (mock) reasons.add(BLOCK.MOCK);
  for (const it of items) for (const r of it.promotion?.reasons || []) reasons.add(r);
  return { nonPromotable: reasons.size > 0, reasons: [...reasons] };
}
