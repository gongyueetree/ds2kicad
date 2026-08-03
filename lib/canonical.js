// lib/canonical.js — v0.8.5 item 3：唯一 Canonical 流程。
// Patch → strict validate → normalized Reviewed IR → generate/verify → （调用方事务保存）
// 关键保证：响应 reviewedIr、数据库 IR、Part Bundle、KiCad 全部基于**同一份** normalized IR。
// 生成失败时返回 ok:false，调用方不得修改 Job。
import { applyReviewPatch } from './reviewpatch.js';
import { sanitizePackage, sanitizePinsets } from './validate.js';
import { generateBundle } from './kicadgen/index.js';
import { assembleAssets } from './assets.js';
import { currentState, STATE } from './lifecycle.js';

/**
 * @returns {{ok:true, normalizedIr, bundle, assets, changeLog}|{ok:false, status, error, code, errors?}}
 */
export function runCanonicalPipeline({ job, patch, session, includeIds, markReviewed }) {
  // 1) Patch → strict validate
  const applied = applyReviewPatch(job.ir, patch, {
    reviewer: { sub: session.sub, name: session.name },
    markReviewed
  });
  if (!applied.ok) return { ok: false, status: 400, error: 'ReviewPatch 校验失败', code: 'invalid_patch', errors: applied.errors };

  // 2) normalized Reviewed IR —— 之后所有产物都只能来自这一份
  const patchedIr = applied.ir;
  const pinsets = sanitizePinsets(patchedIr.pinsets, []);
  const pinsetById = Object.fromEntries(pinsets.map((s) => [s.id, s]));
  const normalizedPackages = (patchedIr.packages || []).map((p) => ({
    ...sanitizePackage(p),
    packageId: p.packageId,
    evidence: p.evidence || null
  }));
  const normalizedIr = { ...patchedIr, pinsets, packages: normalizedPackages };

  const selected = Array.isArray(includeIds) && includeIds.length ? includeIds.map(String) : null;
  const items = [];
  let anyPinsReview = false;
  for (const pkg of normalizedPackages) {
    if (selected && !selected.includes(pkg.packageId)) continue;
    const ps = pinsetById[pkg.pinsetId] || pinsets[0];
    if (ps?.reviewRequired) anyPinsReview = true;
    items.push({ pkg, pins: ps ? (ps.normalizedPins || ps.pins) : [] });
  }
  if (!items.length) return { ok: false, status: 422, error: '没有可生成的封装（检查 patch.includePackageIds）', code: 'no_packages' };

  // 3) generate / verify —— 任一步失败即整体失败，Job 不得被修改
  let bundle, assets;
  try {
    bundle = generateBundle({
      part: normalizedIr.part,
      mock: !!normalizedIr.mock,
      pinsReviewRequired: anyPinsReview,
      sessionAuthenticated: session.authenticated === true,
      confirmedFigureCount: (normalizedIr.figures || []).filter((f) => f.confirmed).length,
      figures: normalizedIr.figures,
      items
    });
    assets = assembleAssets({
      ir: normalizedIr, bundle, job,
      reviewer: normalizedIr.lifecycle?.reviewedBy || null
    });
    verifyConsistency({ normalizedIr, bundle, assets });
  } catch (e) {
    return { ok: false, status: 422, error: `生成失败（Job 未修改）: ${e.message}`, code: 'generation_failed' };
  }

  return { ok: true, normalizedIr, bundle, assets, changeLog: applied.changeLog, state: currentState(normalizedIr) || STATE.EXTRACTED };
}

/** 一致性自检：Part Bundle 与 KiCad 必须来自同一份 normalized IR */
export function verifyConsistency({ normalizedIr, bundle, assets }) {
  const pb = assets.partBundle;
  if (pb.part.mpn !== normalizedIr.part.mpn) throw new Error('part-bundle 与 IR 的 MPN 不一致');
  if ((pb.packages || []).length !== (normalizedIr.packages || []).length) throw new Error('part-bundle 与 IR 的封装数量不一致');
  for (const p of pb.packages || []) {
    const src = normalizedIr.packages.find((x) => x.packageId === p.packageId);
    if (!src) throw new Error(`part-bundle 含 IR 中不存在的 packageId=${p.packageId}`);
    if (src.name !== p.name) throw new Error(`封装名不一致：${src.name} vs ${p.name}`);
  }
  for (const ps of pb.pinsets || []) {
    const src = normalizedIr.pinsets.find((x) => x.id === ps.id);
    if (!src) throw new Error(`part-bundle 含 IR 中不存在的 pinsetId=${ps.id}`);
    if ((src.normalizedPins || []).length !== (ps.normalizedPins || []).length) throw new Error(`pinset ${ps.id} 管脚数不一致`);
  }
  // 符号必须包含 IR 中每个管脚名
  const symText = bundle.files.kicadSym;
  for (const ps of normalizedIr.pinsets || []) {
    const used = (bundle.items || []).some((it) => {
      const pkg = normalizedIr.packages.find((x) => x.name === it.pkgName);
      return pkg && pkg.pinsetId === ps.id;
    });
    if (!used) continue;
    for (const pin of ps.normalizedPins || []) {
      if (!symText.includes(`(number "${pin.number}"`)) throw new Error(`符号缺少管脚 ${pin.number}（IR 与 KiCad 不一致）`);
    }
  }
  return true;
}
