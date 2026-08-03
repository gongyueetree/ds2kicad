// lib/reviewpatch.js — v0.8.3 item 3/4：ReviewPatch 契约与应用。
// 主键一律用稳定 ID（packageId/pinsetId/figureId），**禁止用名称做主键**（名称可重复且可被修改）。
// 每一项修改留 before/after/reviewer/reason/evidence/time；非法字段直接报错，不静默忽略。
import { safeText, strictText, LIMITS } from './textsafe.js';

export const PATCH_SCHEMA_VERSION = 'ds2kicad.review-patch.v1';

// item 4：数值必须落在合法范围内才接受，越界直接 400（不再"接受后 clamp"）
const PKG_RANGE = {
  pinCount: { min: 2, max: 256, integer: true },
  pitch: { min: 0.2, max: 5.08 },
  bodyLength: { min: 0.5, max: 80 },
  bodyWidth: { min: 0.5, max: 80 },
  height: { min: 0.2, max: 10 },
  leadSpan: { min: 0.5, max: 90 },
  leadLength: { min: 0.1, max: 5 },
  leadWidth: { min: 0.05, max: 5, nullable: true },
  epLength: { min: 0.1, max: 60, nullable: true },
  epWidth: { min: 0.1, max: 60, nullable: true },
  rowSpan: { min: 2.54, max: 30 }
};
const PKG_NUMERIC = new Set(Object.keys(PKG_RANGE));
const LP_RANGE = { padW: { min: 0.1, max: 5 }, padL: { min: 0.1, max: 6 }, rowSpan: { min: 1, max: 90 }, holeDia: { min: 0.3, max: 3, nullable: true } };
const LP_NUMERIC = new Set(Object.keys(LP_RANGE));
const EVIDENCE_KEYS = new Set(['page', 'bbox', 'quotedText', 'documentSha256', 'sourceType', 'confidence', 'note']);

/** 校验证据对象结构（item 4：evidence 层未知字段也要 400） */
function validateEvidenceShape(ev, path, errors) {
  if (ev === undefined || ev === null) return true;
  if (typeof ev !== 'object' || Array.isArray(ev)) { errors.push({ path, error: 'evidence 必须是对象' }); return false; }
  let ok = true;
  for (const k of Object.keys(ev)) {
    if (!EVIDENCE_KEYS.has(k)) { errors.push({ path: `${path}.${k}`, error: 'evidence 未知字段' }); ok = false; }
  }
  if (ev.page !== undefined && !(Number.isInteger(ev.page) && ev.page >= 1)) { errors.push({ path: `${path}.page`, error: 'page 必须是正整数' }); ok = false; }
  if (ev.bbox !== undefined && !isValidBbox(ev.bbox)) { errors.push({ path: `${path}.bbox`, error: 'bbox 必须是 [0,1] 内且 x0<x1、y0<y1' }); ok = false; }
  return ok;
}

/** item 4：bbox 必须 [0,1] 且 x0<x1、y0<y1 */
function isValidBbox(b) {
  if (!Array.isArray(b) || b.length !== 4) return false;
  const n = b.map(Number);
  if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return false;
  return n[0] < n[2] && n[1] < n[3];
}

/** item 4：数值严格校验（越界/非整数/NaN 一律拒绝） */
function checkNumber(value, spec, path, errors) {
  if (value === null && spec.nullable) return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n)) { errors.push({ path, error: '必须是有限数值' }); return { ok: false }; }
  if (spec.integer && !Number.isInteger(n)) { errors.push({ path, error: '必须是整数' }); return { ok: false }; }
  if (n < spec.min || n > spec.max) { errors.push({ path, error: `超出允许范围 [${spec.min}, ${spec.max}]（不做截断，请核对手册）` }); return { ok: false }; }
  return { ok: true, value: n };
}
const PART_TEXT = { mpn: LIMITS.mpn, manufacturer: 120, title: LIMITS.title, description_zh: LIMITS.description };
const PIN_TEXT = { name: LIMITS.pinName, number: LIMITS.pinNumber, description: LIMITS.description };
const PIN_TYPES = ['input', 'output', 'bidirectional', 'power_in', 'power_out', 'passive', 'tri_state', 'open_collector', 'no_connect', 'unspecified'];
const FIG_FIELDS = new Set(['confirmed', 'kind', 'title', 'page', 'bbox']);
const FIG_KINDS = ['block_diagram', 'application', 'pin_configuration'];

/**
 * 校验并应用 Patch。
 * @returns {{ok:true, ir, changeLog}|{ok:false, errors:Array}}
 */
export function applyReviewPatch(ir, patch, opts = {}) {
  try {
    return applyReviewPatchInner(ir, patch, opts);
  } catch (e) {
    // item 10：结构错误一律返回 400 结构化错误，不抛异常（否则 HTTP 层会挂起/500）
    return { ok: false, errors: [{ path: '', error: `patch 结构非法：${e.message}` }] };
  }
}

function applyReviewPatchInner(ir, patch, { reviewer, at = new Date().toISOString(), markReviewed = true } = {}) {
  const errors = [];
  const changeLog = [];
  if (patch === undefined || patch === null) return { ok: true, ir, changeLog };
  if (typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: [{ path: '', error: 'patch 必须是对象' }] };
  if (!reviewer?.sub) return { ok: false, errors: [{ path: '', error: '缺少已认证审核者身份' }] };

  // item 5：approvals 只能经 /api/lifecycle 设置，patch 里出现即 400（禁止静默忽略）
const KNOWN_TOP = new Set(['schemaVersion', 'part', 'pinsets', 'packages', 'figures', 'addFigures', 'removeFigures', 'includePackageIds', 'expectedRevision']);
  for (const k of Object.keys(patch)) {
    if (!KNOWN_TOP.has(k)) errors.push({ path: k, error: `未知 patch 字段（禁止静默忽略）` });
  }
  if (patch.schemaVersion && patch.schemaVersion !== PATCH_SCHEMA_VERSION) {
    errors.push({ path: 'schemaVersion', error: `不支持的 patch schema：${patch.schemaVersion}` });
  }

  const next = structuredClone(ir);
  const record = (path, before, after, reason, evidence) => {
    changeLog.push({ path, before, after, reason: reason || '', evidence: evidence || null, reviewer: { sub: reviewer.sub, name: reviewer.name }, at });
  };

  // ── part ──
  if (patch.part !== undefined) {
    if (typeof patch.part !== 'object' || patch.part === null) errors.push({ path: 'part', error: 'part 必须是对象' });
    else for (const [k, entry] of Object.entries(patch.part)) {
      if (!(k in PART_TEXT)) { errors.push({ path: `part.${k}`, error: '不可修改的字段' }); continue; }
      const { value, reason, evidence } = unwrap(entry);
      const chk = k === 'mpn' ? strictText(value, { max: PART_TEXT[k], field: 'mpn' }) : { ok: true, value: safeText(value, { max: PART_TEXT[k] }).value };
      if (!chk.ok) { errors.push({ path: `part.${k}`, error: chk.error }); continue; }
      record(`part.${k}`, next.part?.[k] ?? null, chk.value, reason, evidence);
      next.part = { ...(next.part || {}), [k]: chk.value };
    }
  }

  // ── packages（主键 packageId）──
  if (patch.packages !== undefined) {
    if (!Array.isArray(patch.packages)) errors.push({ path: 'packages', error: 'packages 必须是数组' });
    else for (const [i, item] of patch.packages.entries()) {
      const id = item?.packageId;
      if (!id) { errors.push({ path: `packages[${i}]`, error: '缺少 packageId（禁止用名称作为主键）' }); continue; }
      const target = (next.packages || []).find((p) => p.packageId === id);
      if (!target) { errors.push({ path: `packages[${i}].packageId`, error: `未知 packageId=${id}` }); continue; }
      for (const [k, entry] of Object.entries(item)) {
        if (k === 'packageId') continue;
        if (k === 'landPattern') {
          const { value: lpVal, reason: lpReason, evidence: lpEv } = unwrap(entry);
          if (lpVal === null) {           // item 2：支持显式清除推荐焊盘
            record(`packages[${id}].landPattern`, target.landPattern ?? null, null, lpReason, lpEv);
            target.landPattern = null;
            target.landPatternReviewed = true;
            continue;
          }
          const lp = lpVal && typeof lpVal === 'object' && !Array.isArray(lpVal) ? lpVal : null;
          if (!lp) { errors.push({ path: `packages[${i}].landPattern`, error: 'landPattern 必须是对象或 null' }); continue; }
          for (const [lk, lentry] of Object.entries(lp)) {
            if (!LP_NUMERIC.has(lk) && lk !== 'sourcePage') { errors.push({ path: `packages[${i}].landPattern.${lk}`, error: '未知 landPattern 字段' }); continue; }
            const { value, reason, evidence } = unwrap(lentry);
            if (!validateEvidenceShape(evidence, `packages[${i}].landPattern.${lk}.evidence`, errors)) continue;
            if (lk === 'sourcePage') {
              if (!(Number.isInteger(Number(value)) && Number(value) >= 1)) { errors.push({ path: `packages[${i}].landPattern.sourcePage`, error: 'sourcePage 必须是正整数' }); continue; }
              target.landPattern = { ...(target.landPattern || {}), sourcePage: Number(value) };
              continue;
            }
            if (!requireReason(reason, evidence, `packages[${i}].landPattern.${lk}.reason`, errors)) continue;
            const chk = checkNumber(value, LP_RANGE[lk], `packages[${i}].landPattern.${lk}`, errors);
            if (!chk.ok) continue;
            record(`packages[${id}].landPattern.${lk}`, target.landPattern?.[lk] ?? null, chk.value, reason, evidence);
            target.landPattern = { ...(target.landPattern || {}), [lk]: chk.value };
            target.landPatternReviewed = true;
            // item 5：人工修改生成 reviewer 证据锚点
            target.evidence = { ...(target.evidence || {}), [`landPattern.${lk}`]: reviewerAnchor(`landPattern.${lk}`, reviewer, reason, evidence, at) };
          }
          continue;
        }
        if (k === 'name') {
          const { value, reason, evidence } = unwrap(entry);
          const chk = strictText(value, { max: LIMITS.packageName, field: 'package.name' });
          if (!chk.ok) { errors.push({ path: `packages[${i}].name`, error: chk.error }); continue; }
          record(`packages[${id}].name`, target.name, chk.value, reason, evidence);
          target.name = chk.value;
          continue;
        }
        if (k === 'pinsetId') {          // item 2：允许改封装的 pinset 归属
          const { value, reason, evidence } = unwrap(entry);
          const known = (next.pinsets || []).some((s2) => s2.id === value);
          if (!known) { errors.push({ path: `packages[${i}].pinsetId`, error: `未知 pinsetId=${value}` }); continue; }
          record(`packages[${id}].pinsetId`, target.pinsetId, value, reason, evidence);
          target.pinsetId = value;
          continue;
        }
        if (k === 'family') { errors.push({ path: `packages[${i}].family`, error: 'family 由服务端根据 type/name 判定，只读' }); continue; }
        if (!PKG_NUMERIC.has(k)) { errors.push({ path: `packages[${i}].${k}`, error: '不可修改的字段' }); continue; }
        const { value, reason, evidence } = unwrap(entry);
        if (!validateEvidenceShape(evidence, `packages[${i}].${k}.evidence`, errors)) continue;
        if (!requireReason(reason, evidence, `packages[${i}].${k}.reason`, errors)) continue;
        const chk = checkNumber(value, PKG_RANGE[k], `packages[${i}].${k}`, errors);
        if (!chk.ok) continue;
        const n = chk.value;
        record(`packages[${id}].${k}`, target[k] ?? null, n, reason, evidence);
        target[k] = n;
        target.fieldProvenance = {
          ...(target.fieldProvenance || {}),
          [k]: { source: 'reviewer', rawValue: target.fieldProvenance?.[k]?.rawValue ?? null, normalizedValue: n === null ? null : n, reviewer: `${reviewer.name} <${reviewer.sub}>`, reason: reason || 'review_patch', at }
        };
        // item 5：reviewer 修改生成 sourceType=reviewer 的新 EvidenceAnchor
        target.evidence = { ...(target.evidence || {}), [k]: reviewerAnchor(k, reviewer, reason, evidence, at) };
      }
    }
  }

  // ── pinsets（主键 pinsetId；管脚主键 number）──
  if (patch.pinsets !== undefined) {
    if (!Array.isArray(patch.pinsets)) errors.push({ path: 'pinsets', error: 'pinsets 必须是数组' });
    else for (const [i, item] of patch.pinsets.entries()) {
      const id = item?.pinsetId;
      if (!id) { errors.push({ path: `pinsets[${i}]`, error: '缺少 pinsetId' }); continue; }
      const target = (next.pinsets || []).find((s) => s.id === id);
      if (!target) { errors.push({ path: `pinsets[${i}].pinsetId`, error: `未知 pinsetId=${id}` }); continue; }
      // item 10：pinset 层严格 schema —— 类型校验必须在使用这些字段之前完成
      const PINSET_KEYS = new Set(['pinsetId', 'pins', 'addPins', 'removePins', 'resolveTransformations']);
      for (const k of Object.keys(item)) if (!PINSET_KEYS.has(k)) errors.push({ path: `pinsets[${i}].${k}`, error: '未知字段' });
      let arrTypeOk = true;
      for (const arrKey of ['pins', 'addPins', 'removePins']) {
        if (item[arrKey] !== undefined && !Array.isArray(item[arrKey])) {
          errors.push({ path: `pinsets[${i}].${arrKey}`, error: '必须是数组' });
          arrTypeOk = false;
        }
      }
      if (!arrTypeOk) continue;   // 类型不对就不再遍历，避免运行时异常
      // item 3：转换复核状态 resolve
      if (item.resolveTransformations !== undefined) {
        const r = item.resolveTransformations;
        if (typeof r !== 'object' || r === null) errors.push({ path: `pinsets[${i}].resolveTransformations`, error: '必须是对象' });
        else {
          const RT_KEYS = new Set(['decision', 'reason', 'evidence']);
          for (const k of Object.keys(r)) if (!RT_KEYS.has(k)) errors.push({ path: `pinsets[${i}].resolveTransformations.${k}`, error: '未知字段' });
          const { decision, reason: rr, evidence: rev } = r;
          if (!['accept_normalized', 'needs_rework'].includes(decision)) {
            errors.push({ path: `pinsets[${i}].resolveTransformations.decision`, error: 'decision 必须是 accept_normalized | needs_rework' });
          } else if (!rr || String(rr).trim().length < 2) {
            // item 5：resolve 必须给出理由与证据
            errors.push({ path: `pinsets[${i}].resolveTransformations.reason`, error: '必须提供复核理由' });
          } else if (!validateEvidenceShape(rev, `pinsets[${i}].resolveTransformations.evidence`, errors)) {
            /* 错误已记录 */
          } else if (!rev || (!rev.page && !rev.quotedText)) {
            errors.push({ path: `pinsets[${i}].resolveTransformations.evidence`, error: '必须提供证据（page 或 quotedText）' });
          } else {
            record(`pinsets[${id}].transformationsResolved`, target.transformationsResolved ?? false, decision === 'accept_normalized', rr, null);
            target.transformationsResolved = decision === 'accept_normalized';
            target.transformationResolution = { decision, reason: rr, evidence: rev, reviewer: { sub: reviewer.sub, name: reviewer.name }, at };
            if (decision === 'accept_normalized') target.reviewRequired = false;
          }
        }
      }
      // item 3：新增管脚
      const ADD_KEYS = new Set(['number', 'name', 'type', 'description', 'reason', 'evidence']);
      const DEL_KEYS = new Set(['pinId', 'number', 'reason', 'evidence']);
      for (const [ai, addPin] of (item.addPins || []).entries()) {
        if (typeof addPin !== 'object' || addPin === null) { errors.push({ path: `pinsets[${i}].addPins[${ai}]`, error: '必须是对象' }); continue; }
        let addOk = true;
        for (const k of Object.keys(addPin)) if (!ADD_KEYS.has(k)) { errors.push({ path: `pinsets[${i}].addPins[${ai}].${k}`, error: '未知字段' }); addOk = false; }
        if (!validateEvidenceShape(addPin.evidence, `pinsets[${i}].addPins[${ai}].evidence`, errors)) addOk = false;
        if (!requireReason(addPin.reason, addPin.evidence, `pinsets[${i}].addPins[${ai}].reason`, errors)) addOk = false;
        if (!addOk) continue;
        const chkNum = strictText(addPin?.number, { max: PIN_TEXT.number, field: 'pin.number' });
        const chkName = strictText(addPin?.name, { max: PIN_TEXT.name, field: 'pin.name' });
        if (!chkNum.ok) { errors.push({ path: `pinsets[${i}].addPins[${ai}].number`, error: chkNum.error }); continue; }
        if (!chkName.ok) { errors.push({ path: `pinsets[${i}].addPins[${ai}].name`, error: chkName.error }); continue; }
        if (addPin.type && !PIN_TYPES.includes(addPin.type)) { errors.push({ path: `pinsets[${i}].addPins[${ai}].type`, error: `非法电气类型 ${addPin.type}` }); continue; }
        const list = target.normalizedPins || target.pins || [];
        if (list.some((p) => String(p.number) === chkNum.value)) { errors.push({ path: `pinsets[${i}].addPins[${ai}].number`, error: `管脚编号 ${chkNum.value} 已存在` }); continue; }
        const created = {
          pinId: `pin_rev_${Date.now().toString(36)}_${ai}`,
          number: chkNum.value, rawNumber: null, name: chkName.value, rawName: null,
          type: addPin.type || 'unspecified', description: safeText(addPin.description, { max: PIN_TEXT.description }).value,
          reviewerAdded: true, reviewerEdited: ['number', 'name', 'type'],
          evidence: Object.fromEntries(['number', 'name', 'type', 'description'].map((f) => [f, reviewerAnchor(`pin.${f}`, reviewer, addPin.reason, addPin.evidence, at)]))
        };
        record(`pinsets[${id}].addPin[${created.number}]`, null, created, addPin.reason, addPin.evidence);
        list.push(created);
        target.normalizedPins = list; target.pins = list;
      }
      // item 3：删除管脚
      for (const [di, delPin] of (item.removePins || []).entries()) {
        if (typeof delPin !== 'object' || delPin === null) { errors.push({ path: `pinsets[${i}].removePins[${di}]`, error: '必须是对象' }); continue; }
        let delOk = true;
        for (const k of Object.keys(delPin)) if (!DEL_KEYS.has(k)) { errors.push({ path: `pinsets[${i}].removePins[${di}].${k}`, error: '未知字段' }); delOk = false; }
        if (!validateEvidenceShape(delPin.evidence, `pinsets[${i}].removePins[${di}].evidence`, errors)) delOk = false;
        if (!requireReason(delPin.reason, delPin.evidence, `pinsets[${i}].removePins[${di}].reason`, errors)) delOk = false;
        if (!delOk) continue;
        const key = delPin?.pinId || delPin?.number;
        if (key === undefined) { errors.push({ path: `pinsets[${i}].removePins[${di}]`, error: '缺少 pinId 或 number' }); continue; }
        const list = target.normalizedPins || target.pins || [];
        const pin = list.find((p) => p.pinId === key || String(p.number) === String(key));
        if (!pin) { errors.push({ path: `pinsets[${i}].removePins[${di}]`, error: `未知管脚 ${key}` }); continue; }
        record(`pinsets[${id}].removePin[${pin.number}]`, { ...pin }, null, delPin.reason, delPin.evidence);
        pin.reviewerDeleted = true;
        // 墓碑同时记录 pinId 与 rawNumber：重算时 pinId 会重新生成，需靠 rawNumber 定位
        target.deletedPinIds = [...new Set([...(target.deletedPinIds || []), pin.pinId].filter(Boolean))];
        target.deletedRawNumbers = [...new Set([...(target.deletedRawNumbers || []), String(pin.rawNumber ?? pin.number)].filter(Boolean))];
        target.normalizedPins = list.filter((p) => !p.reviewerDeleted);
        target.pins = target.normalizedPins;
      }
      for (const [pi, pinPatch] of (item.pins || []).entries()) {
        const key = pinPatch?.pinId ?? pinPatch?.number;
        if (key === undefined) { errors.push({ path: `pinsets[${i}].pins[${pi}]`, error: '缺少 pinId 或 number 作为管脚主键' }); continue; }
        const pin = (target.normalizedPins || target.pins || []).find((p) => p.pinId === key || String(p.number) === String(key));
        if (!pin) { errors.push({ path: `pinsets[${i}].pins[${pi}]`, error: `未知管脚 ${key}` }); continue; }
        for (const [k, entry] of Object.entries(pinPatch)) {
          if (k === 'pinId') continue;
          if (k === 'number') {
            if (pinPatch.pinId === undefined) continue;   // 无 pinId 时 number 是主键而非修改目标
            const { value, reason, evidence } = unwrap(entry);
            const chk = strictText(value, { max: PIN_TEXT.number, field: 'pin.number' });
            if (!chk.ok) { errors.push({ path: `pinsets[${i}].pins[${pi}].number`, error: chk.error }); continue; }
            const dup = (target.normalizedPins || []).some((p) => p.pinId !== pin.pinId && String(p.number) === chk.value);
            if (dup) { errors.push({ path: `pinsets[${i}].pins[${pi}].number`, error: `编号 ${chk.value} 与其他管脚冲突` }); continue; }
            if (!requireReason(reason, evidence, `pinsets[${i}].pins[${pi}].number.reason`, errors)) continue;
            record(`pinsets[${id}].pin[${pin.pinId}].number`, pin.number, chk.value, reason, evidence);
            pin.number = chk.value;
            pin.reviewerEdited = [...new Set([...(pin.reviewerEdited || []), 'number'])];
            pin.evidence = { ...(pin.evidence || {}), number: reviewerAnchor('pin.number', reviewer, reason, evidence, at) };
            continue;
          }
          if (k === 'type') {
            const { value, reason, evidence } = unwrap(entry);
            if (!PIN_TYPES.includes(value)) { errors.push({ path: `pinsets[${i}].pins[${pi}].type`, error: `非法电气类型 ${value}` }); continue; }
            if (!requireReason(reason, evidence, `pinsets[${i}].pins[${pi}].type.reason`, errors)) continue;
            record(`pinsets[${id}].pin[${pin.number}].type`, pin.type, value, reason, evidence);
            pin.type = value;
            pin.reviewerEdited = [...new Set([...(pin.reviewerEdited || []), 'type'])];
            pin.evidence = { ...(pin.evidence || {}), type: reviewerAnchor('pin.type', reviewer, reason, evidence, at) };
            continue;
          }
          if (!(k in PIN_TEXT)) { errors.push({ path: `pinsets[${i}].pins[${pi}].${k}`, error: '不可修改的字段' }); continue; }
          const { value, reason, evidence } = unwrap(entry);
          const chk = strictText(value, { max: PIN_TEXT[k], field: `pin.${k}` });
          if (!chk.ok) { errors.push({ path: `pinsets[${i}].pins[${pi}].${k}`, error: chk.error }); continue; }
          if (!validateEvidenceShape(evidence, `pinsets[${i}].pins[${pi}].${k}.evidence`, errors)) continue;
          if (!requireReason(reason, evidence, `pinsets[${i}].pins[${pi}].${k}.reason`, errors)) continue;
          record(`pinsets[${id}].pin[${pin.number}].${k}`, pin[k], chk.value, reason, evidence);
          pin[k] = chk.value;
          pin.reviewerEdited = [...new Set([...(pin.reviewerEdited || []), k])];
          pin.evidence = { ...(pin.evidence || {}), [k]: reviewerAnchor(`pin.${k}`, reviewer, reason, evidence, at) };
        }
      }
    }
  }

  // ── item 8：新增图区（tempId → 服务端正式 figureId）──
  if (patch.addFigures !== undefined) {
    if (!Array.isArray(patch.addFigures)) errors.push({ path: 'addFigures', error: 'addFigures 必须是数组' });
    else for (const [i, f] of patch.addFigures.entries()) {
      const KEYS = new Set(['tempId', 'kind', 'title', 'page', 'bbox', 'confirmed', 'reason', 'evidence']);
      let ok = true;
      for (const k of Object.keys(f || {})) if (!KEYS.has(k)) { errors.push({ path: `addFigures[${i}].${k}`, error: '未知字段' }); ok = false; }
      if (!f || typeof f !== 'object') { errors.push({ path: `addFigures[${i}]`, error: '必须是对象' }); continue; }
      if (!FIG_KINDS.includes(f.kind)) { errors.push({ path: `addFigures[${i}].kind`, error: `非法图类型 ${f.kind}` }); ok = false; }
      if (!(Number.isInteger(Number(f.page)) && Number(f.page) >= 1)) { errors.push({ path: `addFigures[${i}].page`, error: 'page 必须是正整数' }); ok = false; }
      if (!isValidBbox(f.bbox)) { errors.push({ path: `addFigures[${i}].bbox`, error: 'bbox 必须是 [0,1] 内且 x0<x1、y0<y1' }); ok = false; }
      if (f.confirmed !== undefined && typeof f.confirmed !== 'boolean') { errors.push({ path: `addFigures[${i}].confirmed`, error: 'confirmed 必须是 boolean' }); ok = false; }
      if (!validateEvidenceShape(f.evidence, `addFigures[${i}].evidence`, errors)) ok = false;
      if (!requireReason(f.reason, f.evidence, `addFigures[${i}].reason`, errors)) ok = false;
      if (!ok) continue;
      const figureId = `fig_rev_${Date.now().toString(36)}_${i}`;   // 服务端正式 ID
      const created = {
        figureId, tempId: f.tempId || null,
        kind: f.kind, title: safeText(f.title, { max: LIMITS.title }).value,
        page: Number(f.page), bbox: f.bbox.map(Number), confirmed: !!f.confirmed,
        reviewerAdded: true,
        fieldEvidence: { added: reviewerAnchor('figure.added', reviewer, f.reason, f.evidence, at) }
      };
      record(`figures[${figureId}].added`, null, created, f.reason, f.evidence);
      next.figures = [...(next.figures || []), created];
    }
  }
  // ── item 8：删除图区 ──
  if (patch.removeFigures !== undefined) {
    if (!Array.isArray(patch.removeFigures)) errors.push({ path: 'removeFigures', error: 'removeFigures 必须是数组' });
    else for (const [i, f] of patch.removeFigures.entries()) {
      const KEYS = new Set(['figureId', 'reason', 'evidence']);
      let ok = true;
      for (const k of Object.keys(f || {})) if (!KEYS.has(k)) { errors.push({ path: `removeFigures[${i}].${k}`, error: '未知字段' }); ok = false; }
      const target = (next.figures || []).find((x) => x.figureId === f?.figureId);
      if (!target) { errors.push({ path: `removeFigures[${i}].figureId`, error: `未知 figureId=${f?.figureId}` }); ok = false; }
      if (!requireReason(f?.reason, f?.evidence, `removeFigures[${i}].reason`, errors)) ok = false;
      if (!ok) continue;
      record(`figures[${target.figureId}].removed`, { ...target }, null, f.reason, f.evidence);
      next.figures = next.figures.filter((x) => x.figureId !== target.figureId);
    }
  }

  // ── figures（主键 figureId）──
  if (patch.figures !== undefined) {
    if (!Array.isArray(patch.figures)) errors.push({ path: 'figures', error: 'figures 必须是数组' });
    else for (const [i, item] of patch.figures.entries()) {
      const id = item?.figureId;
      if (!id) { errors.push({ path: `figures[${i}]`, error: '缺少 figureId' }); continue; }
      const target = (next.figures || []).find((f) => f.figureId === id);
      if (!target) { errors.push({ path: `figures[${i}].figureId`, error: `未知 figureId=${id}` }); continue; }
      for (const [k, entry] of Object.entries(item)) {
        if (k === 'figureId') continue;
        if (!FIG_FIELDS.has(k)) { errors.push({ path: `figures[${i}].${k}`, error: '不可修改的字段' }); continue; }
        const { value, reason, evidence } = unwrap(entry);
        if (!validateEvidenceShape(evidence, `figures[${i}].${k}.evidence`, errors)) continue;
        // item 4：confirmed 必须是 boolean；page 正整数；bbox [0,1] 且 x0<x1、y0<y1
        if (k === 'confirmed' && typeof value !== 'boolean') { errors.push({ path: `figures[${i}].confirmed`, error: 'confirmed 必须是 boolean' }); continue; }
        if (k === 'kind' && !FIG_KINDS.includes(value)) { errors.push({ path: `figures[${i}].kind`, error: `非法图类型 ${value}` }); continue; }
        if (k === 'bbox' && !isValidBbox(value)) { errors.push({ path: `figures[${i}].bbox`, error: 'bbox 必须是 [0,1] 内的 4 个数值且 x0<x1、y0<y1' }); continue; }
        if (k === 'page' && !(Number.isInteger(Number(value)) && Number(value) >= 1)) { errors.push({ path: `figures[${i}].page`, error: 'page 必须是正整数' }); continue; }
        const v = k === 'title' ? safeText(value, { max: LIMITS.title }).value : k === 'bbox' ? value.map(Number) : k === 'page' ? Number(value) : value;
        record(`figures[${id}].${k}`, target[k] ?? null, v, reason, evidence);
        target[k] = v;
        // item 5：图区字段级 reviewer 证据
        target.fieldEvidence = { ...(target.fieldEvidence || {}), [k]: reviewerAnchor(`figure.${k}`, reviewer, reason, evidence, at) };
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  if (!changeLog.length) return { ok: true, ir, changeLog };   // 空 Patch：IR 原样返回，不留审核痕迹
  next.reviewChangeLog = [...(ir.reviewChangeLog || []), ...changeLog];
  // item 5：只有具备 reviewer 权限的操作才写 reviewedBy
  if (markReviewed) next.reviewedBy = { sub: reviewer.sub, name: reviewer.name, at };
  return { ok: true, ir: next, changeLog };
}

/** item 5：人工修改产生的 EvidenceAnchor（sourceType=reviewer） */
function reviewerAnchor(field, reviewer, reason, evidence, at) {
  return {
    field, sourceType: 'reviewer',
    documentSha256: evidence?.documentSha256 || null,
    page: Number.isInteger(evidence?.page) ? evidence.page : null,
    bbox: Array.isArray(evidence?.bbox) ? evidence.bbox.map(Number) : null,
    quotedText: evidence?.quotedText ? String(evidence.quotedText).slice(0, 300) : null,
    extractor: 'human_review', extractorVersion: '0.8.5',
    confidence: null,
    reviewer: { sub: reviewer.sub, name: reviewer.name },
    reason: reason || '', at
  };
}

/** item 5：人工修改必须提供 reason（或明确的人工确认类型 confirmType） */
function requireReason(reason, evidence, path, errors) {
  // 非空即可（过严的长度门槛会把合法的短理由挡掉，如 "笔误"、"p63"）
  const hasReason = reason !== undefined && reason !== null && String(reason).trim().length > 0;
  const hasConfirm = evidence && (evidence.page || evidence.quotedText || evidence.note);
  if (!hasReason && !hasConfirm) {
    errors.push({ path, error: '人工修改必须提供 reason，或在 evidence 中给出 page/quotedText/note' });
    return false;
  }
  return true;
}

/** 值可以是裸值，也可以是 { value, reason, evidence } 形式 */
function unwrap(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry) {
    return { value: entry.value, reason: entry.reason, evidence: entry.evidence };
  }
  return { value: entry, reason: undefined, evidence: undefined };
}
