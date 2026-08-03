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
  UNAUTHENTICATED: 'no_authenticated_ezplm_session',
  // v0.8.4 新增
  UNVERIFIED_EVIDENCE: 'field_evidence_unverified',
  INFERRED_EVIDENCE: 'field_evidence_model_inference',
  DEFAULT_EVIDENCE: 'field_evidence_default_value',
  NO_FIGURES: 'no_confirmed_figures'
};

/** 告警文本 → 阻断原因的映射（几何/先验层以 warning 表达其不确定性） */
const WARNING_PATTERNS = [
  [/JEDEC 先验|派生值|标准值|按派生/, BLOCK.DERIVED],
  [/颠倒|已交换|收缩至|回退派生|弃用/, BLOCK.GEOMETRY_FIX],
  [/不一致|重复|冲突/, BLOCK.PIN_CONFLICT],
  [/blocked_missing_geometry/, BLOCK.MISSING],
  [/暂不支持|仅输出符号|仅符号/, BLOCK.UNSUPPORTED_PKG]
];

/** item 9：资产类别。symbol / footprint / model3d / figures 分别判定 */
export const ASSET = { SYMBOL: 'symbol', FOOTPRINT: 'footprint', MODEL3D: 'model3d', FIGURES: 'figures' };

/** 每个阻断原因影响哪些资产（未列出 = 影响全部） */
// item 6：阻断范围按"问题的性质"划分
//   封装几何问题 → footprint + 3d（不影响 symbol）
//   管脚问题     → symbol + footprint + 3d（焊盘编号依赖管脚）
//   图区问题     → 仅 figures
//   全局问题（mock/未认证/校验错误）→ 全部资产
const GEOMETRY_SCOPE = [ASSET.FOOTPRINT, ASSET.MODEL3D];
const PIN_SCOPE = [ASSET.SYMBOL, ASSET.FOOTPRINT, ASSET.MODEL3D];
const REASON_SCOPE = {
  'approximate_parametric_3d_not_vendor_step': [ASSET.MODEL3D],
  'no_confirmed_figures': [ASSET.FIGURES],
  // 封装几何 / 证据 / 家族 / 输出缺失 —— 只影响 footprint 与 3d
  'field_evidence_unverified': GEOMETRY_SCOPE,
  'field_evidence_model_inference': GEOMETRY_SCOPE,
  'field_evidence_default_value': GEOMETRY_SCOPE,
  'land_pattern_derived_not_from_datasheet': GEOMETRY_SCOPE,
  'unsupported_package_family': GEOMETRY_SCOPE,
  'geometry_transformation_applied': GEOMETRY_SCOPE,
  'required_output_missing': GEOMETRY_SCOPE,
  'missing_required_geometry': GEOMETRY_SCOPE,
  'value_out_of_range_clamped': GEOMETRY_SCOPE,
  'default_value_used': GEOMETRY_SCOPE,
  'rule_or_jedec_derived': GEOMETRY_SCOPE,
  'geometry_auto_corrected': GEOMETRY_SCOPE,
  // 管脚问题 —— symbol 及依赖它的资产
  'pin_data_transformed_requires_review': PIN_SCOPE,
  'pin_count_or_number_conflict': PIN_SCOPE
  // 其余（mock_data / no_authenticated_ezplm_session / validation_error /
  // reviewer_edit_without_provenance）未登记 → 全部资产
};

/** 把原因集合拆解为逐资产结论 */
export function splitByAsset(reasons = []) {
  const per = { [ASSET.SYMBOL]: [], [ASSET.FOOTPRINT]: [], [ASSET.MODEL3D]: [], [ASSET.FIGURES]: [] };
  for (const r of reasons) {
    const scope = REASON_SCOPE[r] || Object.values(ASSET); // 未登记 = 全局阻断
    for (const a of scope) per[a].push(r);
  }
  return {
    perAsset: per,
    promotable: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.length === 0]))
  };
}

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
  else if (ctx.landPatternSource === 'reviewer_entered' && !ctx.landPatternReviewer) add(BLOCK.UNVERIFIED_EDIT, { field: 'landPattern' });
  // 2f) item 6：参数化 WRL 不是厂商 STEP，不得作为正式 3D 资产晋升
  if (ctx.hasModel3d) add(BLOCK.APPROXIMATE_3D, { note: 'WRL 为参数化近似，正式机械模型需厂商 STEP' });
  // 2f-2) item 6：字段级 EvidenceAnchor 检查 —— 影响输出的关键几何字段，
  // 证据为 unverified / model_inference / default 时阻断对应资产
  const relevantForEvidence = Array.isArray(pkg.relevantFields) ? pkg.relevantFields : [];
  const anchors = pkg.evidence || {};
  const checkAnchor = (field, anchor) => {
    // item 5：**缺失锚点 fail closed** —— 删掉 evidence 绝不能反而变可晋升
    if (!anchor) { add(BLOCK.UNVERIFIED_EVIDENCE, { field, reason: 'missing_evidence_anchor' }); return; }
    const st = anchor.sourceType;
    if (st === 'reviewer') {
      if (!anchor.reviewer?.sub) add(BLOCK.UNVERIFIED_EDIT, { field, reason: 'reviewer_anchor_without_identity' });
      return;
    }
    if (st === 'unverified') add(BLOCK.UNVERIFIED_EVIDENCE, { field, downgradedFrom: anchor.downgradedFrom || null });
    else if (st === 'model_inference') add(BLOCK.INFERRED_EVIDENCE, { field });
    else if (st === 'default') add(BLOCK.DEFAULT_EVIDENCE, { field });
    else if (!['datasheet_text', 'datasheet_table', 'datasheet_drawing', 'ocr'].includes(st)) {
      add(BLOCK.UNVERIFIED_EVIDENCE, { field, reason: `unknown_source_type:${st}` });
    }
  };
  for (const field of relevantForEvidence) checkAnchor(field, anchors[field]);
  // item 5：landPattern 每个字段也必须有证据
  if (pkg.landPattern) {
    for (const lk of ['padW', 'padL', 'rowSpan']) {
      if (pkg.landPattern[lk] === undefined || pkg.landPattern[lk] === null) continue;
      checkAnchor(`landPattern.${lk}`, anchors[`landPattern.${lk}`]);
    }
  }
  // item 5：管脚字段级证据（人工修改过的管脚必须带 reviewer 锚点）
  for (const p of ctx.pins || []) {
    for (const f of p.reviewerEdited || []) {
      const a = p.evidence?.[f];
      if (!a || a.sourceType !== 'reviewer' || !a.reviewer?.sub) {
        add(BLOCK.UNVERIFIED_EDIT, { pin: p.number, field: f, reason: 'pin_edit_without_reviewer_anchor' });
      }
    }
  }
  // item 5：已确认图区必须带证据
  for (const f of ctx.figures || []) {
    if (!f.confirmed) continue;
    const anchor = f.evidence || f.fieldEvidence?.confirmed;
    if (!anchor) add(BLOCK.UNVERIFIED_EVIDENCE, { figureId: f.figureId, reason: 'figure_without_evidence' });
  }
  // 2f-3) item 6：无已确认图区 → figures 资产不可晋升
  if (ctx.confirmedFigureCount !== undefined && ctx.confirmedFigureCount <= 0) add(BLOCK.NO_FIGURES, {});

  // 2g) item 2/8/10：身份必须显式为 true；undefined/null 一律 fail closed
  if (ctx.sessionAuthenticated !== true) add(BLOCK.UNAUTHENTICATED, { given: ctx.sessionAuthenticated === undefined ? 'undefined' : String(ctx.sessionAuthenticated) });
  // 2h) 管脚复核状态未显式给出也 fail closed（防止调用方遗漏上下文）
  if (ctx.pinsReviewRequired === undefined) add(BLOCK.PIN_TRANSFORMED, { note: 'pinsReviewRequired 未提供，按需复核处理' });

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

  const list = [...reasons];
  const split = splitByAsset(list);
  return { nonPromotable: list.length > 0, reasons: list, details, assetPromotion: split.promotable, assetBlockReasons: split.perAsset };
}

/** 汇总多个条目 + 全局上下文（mock 等）→ bundle 级判定 */
export function evaluateBundle({ items = [], mock = false, extraReasons = [], confirmedFigureCount } = {}) {
  const reasons = new Set(extraReasons);
  if (mock) reasons.add(BLOCK.MOCK);
  if (confirmedFigureCount !== undefined && confirmedFigureCount <= 0) reasons.add(BLOCK.NO_FIGURES);
  for (const it of items) for (const r of it.promotion?.reasons || []) reasons.add(r);
  const list = [...reasons];
  const split = splitByAsset(list);
  return { nonPromotable: list.length > 0, reasons: list, assetPromotion: split.promotable, assetBlockReasons: split.perAsset };
}
