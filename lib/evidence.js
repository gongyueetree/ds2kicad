// lib/evidence.js — v0.8.3 item 10：字段级 EvidenceAnchor。
// 关键约束：**不得仅因字段里有数字就标记 source=datasheet**。
// sourceType 必须由提取器显式声明，且 datasheet 类锚点必须带可定位证据
// （documentSha256 + page + 至少 bbox 或 quotedText）；否则降级为 unverified。

export const SOURCE_TYPE = {
  DATASHEET_TEXT: 'datasheet_text',       // 文本层提取，带页码/bbox/原文
  DATASHEET_TABLE: 'datasheet_table',     // 表格单元格
  DATASHEET_DRAWING: 'datasheet_drawing', // 机械图（含 OCR 结果）
  OCR: 'ocr',
  MODEL_INFERENCE: 'model_inference',     // LLM 推断，需人工复核
  RULE_DERIVED: 'rule_derived',           // 规则/几何推导
  REVIEWER: 'reviewer',                   // 人工录入
  DEFAULT: 'default',                     // 引擎默认值
  UNVERIFIED: 'unverified'                // 无可定位证据
};

const LOCATABLE = new Set([SOURCE_TYPE.DATASHEET_TEXT, SOURCE_TYPE.DATASHEET_TABLE, SOURCE_TYPE.DATASHEET_DRAWING, SOURCE_TYPE.OCR]);

/**
 * 构造字段级证据锚点。缺少定位信息的 datasheet 类锚点会被降级为 unverified 并记录原因。
 * @param {object} a { field, documentSha256, page, bbox, quotedText, extractor, extractorVersion, confidence, sourceType }
 */
export function makeAnchor(a = {}) {
  const anchor = {
    field: String(a.field || ''),
    sourceType: a.sourceType || SOURCE_TYPE.UNVERIFIED,
    documentSha256: a.documentSha256 || null,
    page: Number.isInteger(a.page) && a.page >= 1 ? a.page : null,
    bbox: Array.isArray(a.bbox) && a.bbox.length === 4 && a.bbox.every((n) => Number.isFinite(Number(n))) ? a.bbox.map(Number) : null,
    quotedText: a.quotedText ? String(a.quotedText).slice(0, 300) : null,
    extractor: String(a.extractor || 'unknown'),
    extractorVersion: String(a.extractorVersion || '0'),
    confidence: Number.isFinite(Number(a.confidence)) ? Math.min(1, Math.max(0, Number(a.confidence))) : null,
    at: a.at || new Date().toISOString()
  };
  if (LOCATABLE.has(anchor.sourceType)) {
    const locatable = anchor.documentSha256 && anchor.page && (anchor.bbox || anchor.quotedText);
    if (!locatable) {
      anchor.downgradedFrom = anchor.sourceType;
      anchor.sourceType = SOURCE_TYPE.UNVERIFIED;
      anchor.downgradeReason = 'missing_document_sha256_page_or_locator';
    }
  }
  return anchor;
}

/** 锚点是否足以支撑"来自数据手册"的主张 */
export function isDatasheetBacked(anchor) {
  return !!anchor && LOCATABLE.has(anchor.sourceType) && !!anchor.documentSha256 && !!anchor.page;
}

/** 批量为一组字段建立锚点；未显式声明来源的字段一律 unverified */
export function anchorFields(fields = {}, ctx = {}) {
  const out = {};
  for (const [field, spec] of Object.entries(fields)) {
    out[field] = makeAnchor({ field, ...ctx, ...(spec || {}) });
  }
  return out;
}

/** 汇总：哪些字段没有数据手册级证据（供闸门与审核界面使用） */
export function unbackedFields(anchors = {}) {
  return Object.entries(anchors).filter(([, a]) => !isDatasheetBacked(a)).map(([f]) => f);
}
