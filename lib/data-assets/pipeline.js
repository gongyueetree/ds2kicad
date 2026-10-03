import { createHash } from 'node:crypto';
import { classify, schemaFor, matchField, REGISTRY_VERSION } from './registry.js';
import { normalizeValue } from './units.js';
export const DATA_SCHEMA = 'ds2kicad.component-data.v1';
export const PIPELINE_VERSION = '1.0.0';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const NATURES = ['absolute_maximum', 'recommended', 'guaranteed', 'typical', 'characterized', 'unknown'];
export function natureOf(text) {
  if (/absolute maximum|绝对最大/i.test(text)) return 'absolute_maximum';
  if (/recommended operating|推荐工作/i.test(text)) return 'recommended';
  if (/typical characteristics|典型特性/i.test(text)) return 'typical';
  // Electrical characteristics alone does not establish a guarantee.
  return 'unknown';
}
export function locateRegions(pages = []) {
  const out = [];
  for (const page of pages) for (const [i, line] of (page.lines || []).entries()) {
    if (!/electrical characteristics|absolute maximum|recommended operating|typical characteristics|ordering information|orderable|pin functions|pin configuration|package outline|电气特性|绝对最大|推荐工作|订购信息/i.test(line.text)) continue;
    out.push({ id: `region-${page.page}-${i}`, page: page.page, title: line.text.slice(0, 300), nature: natureOf(line.text),
      bbox: lineBox(line, page) });
  }
  return out;
}
function lineBox(line, page) {
  if (![line.x, line.y, line.x1, page.width, page.height].every(Number.isFinite) || page.width <= 0 || page.height <= 0) return null;
  const clamp = n => Math.max(0, Math.min(1, n));
  const b = [clamp(line.x / page.width), clamp((page.height - line.y - (line.h || 10)) / page.height), clamp(line.x1 / page.width), clamp((page.height - line.y + 2) / page.height)];
  return b[0] < b[2] && b[1] < b[3] ? b : null;
}
// Only unambiguous aligned rows are parsed locally. Ambiguous rows remain model/reviewer work.
export function parseObservations(pages, categoryId) {
  const schema = schemaFor(categoryId), out = [];
  if (!schema) return out;
  for (const page of pages) {
    let headers = null, nature = 'unknown', context = [];
    for (const line of page.lines || []) {
      const text = line.text || '';
      if (/characteristics|absolute maximum|recommended operating|电气特性|额定值/i.test(text)) { nature = natureOf(text); headers = null; context = []; }
      if (/\b(?:TA|TJ|VGS|VDS|VDD|VCC|VIN|VOUT|VS|RL|CL)\b\s*=/i.test(text)) context.push(text);
      const cells = text.split(/\s{2,}|\s*\|\s*/).map(s => s.trim()).filter(Boolean);
      const roles = cells.map(c => /^(min|minimum)$/i.test(c) ? 'min' : /^(typ|typical)$/i.test(c) ? 'typ' : /^(max|maximum)$/i.test(c) ? 'max' : /^units?$/i.test(c) ? 'unit' : null);
      if (roles.includes('unit') && roles.some(r => ['min','typ','max'].includes(r))) { headers = roles; continue; }
      const field = matchField(schema, cells[0]);
      if (!field || !headers || cells.length !== headers.length) continue;
      const value = { min: null, typ: null, max: null };
      for (let i = 0; i < headers.length; i++) if (['min','typ','max'].includes(headers[i]) && !/^[-—–]$/.test(cells[i])) value[headers[i]] = cells[i];
      out.push({ parameterId: field.id, name: cells[0], value, unit: cells[headers.indexOf('unit')], nature,
        conditions: [...new Set(context.slice(-5))].join('; '), appliesTo: [], page: page.page, quotedText: text, bbox: lineBox(line, page), extractor: 'aligned_table' });
    }
  }
  return out;
}
export function normalizeObservation(raw, { categoryId, documentSha256, pages = [], index = 0 } = {}) {
  const safeRaw = {
    parameterId: String(raw?.parameterId || '').slice(0,100), name: String(raw?.name || '').slice(0,200),
    value: Object.fromEntries(['min','typ','max'].map(k => [k, raw?.value?.[k] == null ? null : String(raw.value[k]).slice(0,80)])),
    unit: String(raw?.unit || '').slice(0,30), nature: NATURES.includes(raw?.nature) ? raw.nature : 'unknown',
    conditions: String(raw?.conditions || '').slice(0,4000),
    appliesTo: Array.isArray(raw?.appliesTo) ? raw.appliesTo.filter(s => typeof s === 'string').slice(0,100).map(s => s.slice(0,100)) : [],
    page: Number.isInteger(raw?.page) && raw.page > 0 ? raw.page : null,
    quotedText: String(raw?.quotedText || '').slice(0,4000)
  };
  const field = matchField(schemaFor(categoryId), safeRaw.parameterId) || matchField(schemaFor(categoryId), safeRaw.name);
  const issues = [];
  let normalized = null;
  if (!field) issues.push('unknown_parameter');
  else try { normalized = normalizeValue(safeRaw.value, safeRaw.unit, field.unit); } catch(e) { issues.push(e.message); }
  const page = pages.find(p => p.page === safeRaw.page);
  const backed = !!safeRaw.quotedText && !!page && norm(page.lines.map(l => l.text).join(' ')).includes(norm(safeRaw.quotedText));
  if (!backed) issues.push('evidence_requires_review');
  if (!safeRaw.appliesTo.length) issues.push('applicability_requires_review');
  if (safeRaw.nature === 'unknown') issues.push('specification_nature_requires_review');
  return { id: `obs-${digest({ documentSha256, raw: safeRaw, index }).slice(0,20)}`,
    parameterId: field?.id || safeRaw.parameterId, label: field?.label || safeRaw.name,
    raw: safeRaw, normalized, nature: safeRaw.nature, conditions: safeRaw.conditions, appliesTo: safeRaw.appliesTo,
    evidence: { documentSha256, page: safeRaw.page, quotedText: safeRaw.quotedText,
      sourceType: backed ? 'datasheet_text' : 'model_inference', verifiedText: backed,
      extractor: raw?.extractor === 'aligned_table' ? 'aligned_table' : 'model', extractorVersion: PIPELINE_VERSION },
    issues, review: { status: 'pending' } };
}
export function buildDataAssets({ part, pages = [], raw = {}, documentSha256, sourceUrl, pdfBytes, pageCount, ocrStatus, modelPages = null }) {
  const classification = classify(part, pages);
  const modelCandidate = schemaFor(raw.categoryCandidate);
  if (classification.categoryId === 'unknown' && modelCandidate) {
    classification.categoryId = modelCandidate.id;
    classification.method = 'model_candidate';
  }
  const candidates = [...parseObservations(pages, classification.categoryId), ...(Array.isArray(raw.parameterObservations) ? raw.parameterObservations.slice(0,300) : [])];
  const seen = new Set();
  const observations = candidates.map((r,i) => normalizeObservation(r, { categoryId: classification.categoryId, documentSha256, pages, index: i })).filter(o => {
    const key = digest(o.raw); if (seen.has(key)) return false; seen.add(key); return true;
  });
  return {
    schema: DATA_SCHEMA, pipelineVersion: PIPELINE_VERSION, registryVersion: REGISTRY_VERSION,
    sourceDocument: { sha256: documentSha256, url: sourceUrl || null, bytes: pdfBytes || null,
      pageCount: pageCount || pages.length, parsedPages: pages.map(p => p.page), modelPages,
      partial: !!pageCount && (pages.length < pageCount || (modelPages && modelPages.length < pageCount)), ocrStatus: ocrStatus || 'not_needed' },
    identity: { mpn: part?.mpn || 'UNKNOWN', manufacturer: part?.manufacturer || '' },
    classification, regions: locateRegions(pages), observations, publications: [], history: []
  };
}
export function dataSummary(data) {
  if (!data) return null;
  const observations = data.observations || [];
  return { total: observations.length, accepted: observations.filter(o => o.review.status === 'accepted').length,
    pending: observations.filter(o => o.review.status === 'pending').length, rejected: observations.filter(o => o.review.status === 'rejected').length,
    invalid: observations.filter(o => !o.normalized).length, categoryId: data.classification.categoryId,
    missing: (schemaFor(data.classification.categoryId)?.fields || []).filter(f => !observations.some(o => o.parameterId === f.id && o.review.status === 'accepted')).map(f => f.id) };
}
export function workflowView(ir) {
  const d = ir.dataAssets, s = dataSummary(d);
  return [
    { id: 1, label: '资料接入', status: ir.documentObject ? 'complete' : 'legacy' },
    { id: 2, label: 'PDF / OCR', status: !d ? 'pending' : d.sourceDocument.partial || ['ocr_pending_no_worker','ocr_failed'].includes(d.sourceDocument.ocrStatus) ? 'needs_review' : 'complete' },
    { id: 3, label: '类别与模板', status: d?.classification.status === 'confirmed' ? 'complete' : 'needs_review' },
    { id: 4, label: '表格与图区', status: d?.regions.length || ir.figures?.length ? 'complete' : 'needs_review' },
    { id: 5, label: '参数与单位', status: s?.total ? s.invalid ? 'needs_review' : 'complete' : 'pending' },
    { id: 6, label: '引脚与订购型号', status: ir.pinsets?.some(p => (p.pins || p.normalizedPins)?.length) ? 'needs_review' : 'pending' },
    { id: 7, label: '证据审核', status: s?.total && !s.pending ? 'complete' : 'needs_review' },
    { id: 8, label: 'KiCad 符号', status: Object.keys(ir.lifecycle?.published || {}).some(k => k.startsWith('symbol:')) ? 'published' : 'pending' },
    { id: 9, label: '封装与 3D', status: Object.keys(ir.lifecycle?.published || {}).some(k => k.startsWith('footprint:')) ? 'published' : 'pending' }
  ];
}
