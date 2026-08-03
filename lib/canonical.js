// lib/canonical.js — v0.8.5 item 3：唯一 Canonical 流程。
// Patch → strict validate → normalized Reviewed IR → generate/verify → （调用方事务保存）
// 关键保证：响应 reviewedIr、数据库 IR、Part Bundle、KiCad 全部基于**同一份** normalized IR。
// 生成失败时返回 ok:false，调用方不得修改 Job。
import { applyReviewPatch } from './reviewpatch.js';
import { sanitizePackage, sanitizePinsets } from './validate.js';
import { generateBundle } from './kicadgen/index.js';
import { assembleAssets } from './assets.js';
import { currentState, STATE, transition, invalidateAffectedApprovals } from './lifecycle.js';
import { normalizeGeometryDetailed } from './kicadgen/geometry.js';
import { createHash } from 'node:crypto';

export const irHash = (ir) => createHash('sha256').update(JSON.stringify(ir)).digest('hex');

/**
 * @returns {{ok:true, normalizedIr, bundle, assets, changeLog}|{ok:false, status, error, code, errors?}}
 */
const trimNum = (v) => String(+Number(v).toFixed(2)).replace(/\.0+$/, '');

/**
 * item 1：Patch → strict validate → geometry normalization → Final immutable IR
 *        → lifecycle transition → 确定最终 revision → generate → manifest。
 * 调用方拿到结果后做**原子提交**。
 */
export function runCanonicalPipeline({ job, patch, session, includeIds, markReviewed, finalRevision, finalState }) {
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
  // item 1：几何归一化在 Final IR 阶段完成并冻结（generator 之后不得再改数值）
  const geoWarnings = [];
  const normalizedPackages = (patchedIr.packages || []).map((p) => {
    const sane = { ...sanitizePackage(p), packageId: p.packageId, evidence: p.evidence || null };
    const { normalizedPackage, transformations, warnings: gw } = normalizeGeometryDetailed(sane);
    geoWarnings.push(...gw.map((w) => `[${sane.name}] ${w}`));
    return {
      ...normalizedPackage,
      packageId: p.packageId,
      evidence: sane.evidence,
      geometryNormalized: true,                 // 冻结标记
      geometryTransformations: transformations
    };
  });
  let normalizedIr = { ...patchedIr, pinsets, packages: normalizedPackages, geometryWarnings: geoWarnings };

  // item 3：编辑后自动失效受影响资产的 review/approval/publication
  let invalidated = [];
  if (applied.changeLog.length) {
    const inv = invalidateAffectedApprovals(normalizedIr, applied.changeLog);
    normalizedIr = inv.ir;
    invalidated = inv.invalidated;
    // item 1：lifecycle 跃迁在 Final IR 内完成，之后 state 不再变化
    const t = transition(normalizedIr, 'edit', { actor: session.sub, role: 'reviewer', reason: 'review_patch' });
    if (t.ok) normalizedIr = t.ir;
  }
  Object.freeze(normalizedIr);   // Final immutable IR

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
      ir: normalizedIr, bundle,
      job: { ...job, revision: finalRevision ?? job.revision },
      reviewer: normalizedIr.lifecycle?.reviewedBy || null
    });
    verifyConsistency({
      normalizedIr, bundle, assets,
      revision: finalRevision ?? job.revision,
      state: finalState ?? currentState(normalizedIr)
    });
  } catch (e) {
    return { ok: false, status: 422, error: `生成失败（Job 未修改）: ${e.message}`, code: 'generation_failed' };
  }

  return {
    ok: true, normalizedIr, bundle, assets,
    changeLog: applied.changeLog, invalidated,
    irHash: irHash(normalizedIr),
    state: currentState(normalizedIr) || STATE.EXTRACTED
  };
}

/** item 2：完整一致性自检 —— 关键数值、lifecycle、revision、文件哈希、Figure 全比对 */
export function verifyConsistency({ normalizedIr, bundle, assets, revision, state }) {
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
  // 关键几何数值：Part Bundle 必须与 Final IR 逐字段相等（生成器不得改数）
  const GEO = ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'height', 'leadSpan', 'leadLength', 'leadWidth', 'epLength', 'epWidth', 'rowSpan'];
  for (const p of pb.packages || []) {
    const src = normalizedIr.packages.find((x) => x.packageId === p.packageId);
    for (const f of GEO) {
      if ((src[f] ?? null) !== (p[f] ?? null)) throw new Error(`几何字段 ${f} 不一致（IR ${src[f]} vs bundle ${p[f]}）: ${p.packageId}`);
    }
    if (JSON.stringify(src.landPattern ?? null) !== JSON.stringify(p.landPattern ?? null)) {
      throw new Error(`landPattern 不一致: ${p.packageId}`);
    }
  }
  // 生成产物的文件名必须由 Final IR 的几何算出（尺寸后缀比对）
  for (const it of bundle.items || []) {
    if (!it.fpName) continue;
    // item 13：只按 packageId 匹配，禁止用名称回查（同名封装会匹配到错误对象）
    const src = normalizedIr.packages.find((x) => x.packageId === it.packageId);
    if (!src) throw new Error(`生成产物缺少 packageId 关联：${it.pkgName}`);
    if (src && src.family !== 'dip') {
      const expect = `${trimNum(src.bodyWidth)}x${trimNum(src.bodyLength)}mm`;
      if (!it.fpName.includes(expect)) throw new Error(`封装文件名 ${it.fpName} 与 Final IR 几何 ${expect} 不一致`);
    }
  }
  // revision / state / lifecycle
  if (revision !== undefined && pb.job?.revision !== revision) throw new Error(`part-bundle revision ${pb.job?.revision} != ${revision}`);
  if (state !== undefined && pb.review?.state !== state) throw new Error(`part-bundle state ${pb.review?.state} != ${state}`);
  if ((assets.manifest.revision ?? null) !== (revision ?? null)) throw new Error(`manifest revision 不一致`);
  // Figure：已确认图区必须逐一出现在 bundle，且有 PNG 时必须进 manifest
  const confirmed = (normalizedIr.figures || []).filter((f) => f.confirmed);
  if (confirmed.length !== (pb.figures || []).length) throw new Error(`已确认图区数量不一致：IR ${confirmed.length} vs bundle ${(pb.figures || []).length}`);
  for (const f of pb.figures || []) {
    if (!confirmed.some((x) => x.figureId === f.figureId)) throw new Error(`bundle 含未确认图区 ${f.figureId}`);
    if (f.imagePath && !assets.manifest.files.some((m) => m.path === f.imagePath && m.sha256 === f.imageSha256)) {
      throw new Error(`图区 PNG ${f.imagePath} 未进入 manifest 或哈希不一致`);
    }
  }
  // 文件哈希：manifest 必须覆盖全部产出文件且哈希一致
  if (assets.manifest.files.length !== assets.files.length) throw new Error('manifest 文件数与产出文件数不一致');
  for (const f of assets.files) {
    const m = assets.manifest.files.find((x) => x.path === f.path);
    if (!m) throw new Error(`manifest 缺少文件 ${f.path}`);
    if (m.sha256 !== f.sha256) throw new Error(`文件哈希不一致 ${f.path}`);
  }
  // 符号必须包含 IR 中每个管脚名
  const symText = bundle.files.kicadSym;
  for (const ps of normalizedIr.pinsets || []) {
    const used = (bundle.items || []).some((it) => {
      const pkg = normalizedIr.packages.find((x) => x.packageId === it.packageId);   // item 13
      return pkg && pkg.pinsetId === ps.id;
    });
    if (!used) continue;
    for (const pin of ps.normalizedPins || []) {
      if (!symText.includes(`(number "${pin.number}"`)) throw new Error(`符号缺少管脚 ${pin.number}（IR 与 KiCad 不一致）`);
    }
  }
  return true;
}
