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
  VALIDATION: 'validation_error',
  // v0.8.2 新增
  PIN_TRANSFORMED: 'pin_data_transformed_requires_review',
  DERIVED_LAND_PATTERN: 'land_pattern_derived_not_from_datasheet',
  APPROXIMATE_3D: 'approximate_parametric_3d_not_vendor_step',
  GEOMETRY_TRANSFORMED: 'geometry_transformation_applied',
  UNAUTHENTICATED: 'no_authenticated_ezplm_session'
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
    if (p.source === 'not_applicable' || p.source === 'absent' || p.source === 'datasheet') continue;
    if (p.source === 'reviewer') { if (!p.reviewer) add(BLOCK.UNVERIFIED_EDIT, { field }); continue; }
    // clamped / invalid 无条件阻断：手册给出了值但不合法，说明提取或数据本身有问题
    if (p.source === 'clamped') { add(BLOCK.CLAMPED, { field, rawValue: p.rawValue, normalizedValue: p.normalizedValue, reason: p.reason }); continue; }
    if (p.source === 'invalid') { add(BLOCK.VALIDATION, { field, rawValue: p.rawValue, error: p.reason }); continue; }
    // missing / default 按家族相关性判定（不相关字段的默认值不影响输出）
    if (!relevant.includes(field)) continue;
    if (p.source === 'missing') add(BLOCK.MISSING, { field, reason: p.reason });
    else if (p.source === 'default') add(BLOCK.DEFAULT, { field, normalizedValue: p.normalizedValue });
  }
  if (Array.isArray(pkg.missingFields) && pkg.missingFields.length) {
    add(BLOCK.MISSING, { fields: pkg.missingFields });
  }

  // 2) 未支持封装家族（BGA/LCCC/PLCC/未知）：绝不近似生成可发布封装
  if (ctx.unsupportedFamily || ctx.familySupported === false) {
    add(BLOCK.UNSUPPORTED_PKG, { family: ctx.family, note: ctx.unsupportedNote });
  }
  // 2b) 结构化校验错误（如 pinCount 非整数）
  for (const e of ctx.validationErrors || []) add(BLOCK.VALIDATION, e);
  // 2c) 管脚数据发生过任何转换（合并展开/去重/EP 重编号/类型回退/空名称）
  if (ctx.pinsReviewRequired) add(BLOCK.PIN_TRANSFORMED, { note: '见 pinTransformationLog' });
  // 2d) 几何归一化发生过交换/推导/收缩/先验替换
  for (const t of ctx.transformations || []) add(BLOCK.GEOMETRY_TRANSFORMED, t);
  // 2e) item 6：焊盘为规则推导（无手册推荐 land pattern）
  if (ctx.landPatternSource === 'derived_by_rules') add(BLOCK.DERIVED_LAND_PATTERN, { note: '焊盘由规则推导，需对照机械图复核' });
  // 2f) item 6：参数化 WRL 不是厂商 STEP，不得作为正式 3D 资产晋升
  if (ctx.hasModel3d) add(BLOCK.APPROXIMATE_3D, { note: 'WRL 为参数化近似，正式机械模型需厂商 STEP' });
  // 2g) item 2/10：无已认证 ezPLM 会话
  if (ctx.sessionAuthenticated === false) add(BLOCK.UNAUTHENTICATED, {});

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
