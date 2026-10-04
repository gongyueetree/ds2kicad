import { DATA_SCHEMA, digest, normalizeObservation, dataSummary } from './pipeline.js';
import { schemaFor } from './registry.js';
import { normalizeValue } from './units.js';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function only(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('请求必须是对象');
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`未知字段：${k}`);
}
const bounded = (v, max, name) => { if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b-\x1f]/.test(v)) fail(`${name} 格式非法`); return v.trim(); };
export function reviewData(data, body, actor, part) {
  only(body, ['jobId','expectedRevision','action','categoryId','decisions','addObservations','reason','identity']);
  const reason = bounded(body.reason, 1000, '审核理由');
  if (reason.length < 2) fail('请填写审核理由');
  const next = structuredClone(data), at = new Date().toISOString();
  if (data.identity.mpn !== part.mpn || data.identity.manufacturer !== (part.manufacturer || '')) {
    next.classification.status='needs_review';
    next.observations=next.observations.map(o=>({...o,review:{status:'pending'}}));
  }
  if (body.categoryId !== undefined) {
    if (!schemaFor(body.categoryId)) fail('不支持的器件类别');
    if (next.classification.categoryId !== body.categoryId) {
      // Reclassification invalidates every decision and regenerates candidates from raw evidence.
      next.observations = next.observations.map((o,i) => ({ ...normalizeObservation(o.raw, { categoryId: body.categoryId, documentSha256: next.sourceDocument.sha256, index:i }), id:o.id, evidence:o.evidence }));
    }
    next.classification = { ...next.classification, categoryId: body.categoryId, status:'confirmed', confirmedBy: actor, confirmedAt:at };
  }
  if (body.addObservations !== undefined) {
    if (!Array.isArray(body.addObservations) || body.addObservations.length > 50) fail('新增参数最多 50 条');
    for (const raw of body.addObservations) {
      only(raw, ['parameterId','name','value','unit','nature','conditions','appliesTo','page','quotedText']);
      const o = normalizeObservation(raw, { categoryId: next.classification.categoryId, documentSha256: next.sourceDocument.sha256, index:next.observations.length });
      o.evidence.extractor = 'reviewer';
      next.observations.push(o);
    }
  }
  if (next.observations.length > 500) fail('单份文档参数候选超过上限');
  if (body.decisions !== undefined && (!Array.isArray(body.decisions) || body.decisions.length > 500)) fail('decisions 必须是数组（最多 500 条）');
  const seen = new Set();
  for (const decision of body.decisions || []) {
    only(decision, ['id','status','value','unit','nature','conditions','appliesTo','page','quotedText']);
    if (seen.has(decision.id)) fail('重复的审核决定'); seen.add(decision.id);
    const o = next.observations.find(o => o.id === decision.id);
    if (!o) fail('参数候选不存在');
    if (!['accepted','rejected','pending'].includes(decision.status)) fail('非法审核状态');
    const field = schemaFor(next.classification.categoryId)?.fields.find(f => f.id === o.parameterId);
    if (decision.status === 'accepted') {
      if (!field) fail('请先确认类别并选择有效参数');
      if (decision.value !== undefined) only(decision.value, ['min','typ','max']);
      const normalized = decision.value === undefined ? o.normalized : normalizeValue(decision.value, decision.unit || field.unit, field.unit);
      if (!normalized) fail('参数数值或单位无法归一，请修正后接受');
      const nature = decision.nature ?? o.nature;
      if (!['absolute_maximum','recommended','guaranteed','typical','characterized'].includes(nature)) fail('请明确参数的保证性质/额定值类别');
      const appliesTo = decision.appliesTo ?? o.appliesTo;
      if (!Array.isArray(appliesTo) || !appliesTo.length || appliesTo.length > 100 || appliesTo.some(x => typeof x !== 'string' || !x.trim() || x.length > 100)) fail('请明确适用型号');
      const conditions = bounded(decision.conditions ?? o.conditions, 4000, '测试条件');
      if (!conditions) fail('请填写测试条件；不适用时明确填写“不适用”');
      const page = decision.page ?? o.evidence.page;
      const quotedText = bounded(decision.quotedText ?? o.evidence.quotedText, 4000, '原文证据');
      if (!Number.isInteger(page) || page < 1 || (next.sourceDocument.pageCount && page > next.sourceDocument.pageCount) || !quotedText) fail('请提供有效原文页码和证据');
      o.normalized = normalized; o.nature = nature; o.conditions = conditions; o.appliesTo = appliesTo.map(x=>x.trim());
      o.evidence = { ...o.evidence, page, quotedText, sourceType:'reviewer', verifiedText: o.evidence.verifiedText && page === o.evidence.page && quotedText === o.evidence.quotedText, reviewedBy:actor };
      o.issues = [];
    }
    o.review = { status:decision.status, actor, at, reason };
  }
  next.identity = { mpn:part.mpn, manufacturer:part.manufacturer || '' };
  next.history.push({ action:'review', actor, at, reason, decisions:(body.decisions || []).map(d=>({id:d.id,status:d.status})), categoryId:body.categoryId || null });
  return next;
}
export function publishData(data, { actor, reason, part, mock, authenticated }) {
  if (!authenticated || mock) throw Object.assign(new Error('演示或未认证会话不能发布正式数据'), { status:403 });
  if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 1000) fail('请填写发布理由');
  if (data.classification.status !== 'confirmed') fail('请先确认器件类别');
  const summary = dataSummary(data);
  if (!summary.accepted || summary.pending) fail('请完成所有候选的接受或拒绝审核，至少接受一条参数');
  if (!part?.manufacturer?.trim() || !part?.mpn || part.mpn === 'UNKNOWN' || data.identity.mpn !== part.mpn || data.identity.manufacturer !== (part.manufacturer || '')) fail('器件身份已改变，请重新审核参数');
  const facts = data.observations.filter(o=>o.review.status==='accepted').map(o=>({
    id:o.id, parameterId:o.parameterId, label:o.label, ...o.normalized, nature:o.nature,
    conditions:o.conditions, appliesTo:o.appliesTo, evidence:o.evidence, review:o.review
  }));
  const content = { schema:DATA_SCHEMA, identity:data.identity, classification:data.classification, sourceDocument:data.sourceDocument, facts };
  const sha256 = digest(content);
  if (data.publications.some(p=>p.sha256===sha256)) return data;
  const next = structuredClone(data);
  const version = { versionId:`data-${sha256.slice(0,20)}`, sha256, publishedBy:actor, publishedAt:new Date().toISOString(), reason:reason.trim(), content };
  next.publications.push(version);
  next.history.push({ action:'publish', actor, at:version.publishedAt, versionId:version.versionId, reason:reason.trim() });
  return next;
}
// Use a distinct draft envelope. Unreviewed values never masquerade as released facts.
export function exportData(data, { draft = false, versionId } = {}) {
  if (draft) return { ...structuredClone(data), nonPromotable:true, schema: 'ds2kicad.component-data-draft.v1' };
  const version = versionId ? data.publications.find(p=>p.versionId===versionId) : data.publications.at(-1);
  if (!version) throw Object.assign(new Error('尚未发布参数资产'), { status:409 });
  return structuredClone(version);
}
