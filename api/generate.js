// api/generate.js — v0.8.5：POST { jobId, patch } → Canonical 流程 → 事务保存 → 完整产物。
// item 3：响应 reviewedIr、数据库 IR、Part Bundle、KiCad 全部来自同一份 normalized IR；
//         生成失败绝不修改 Job（先 run pipeline，成功后才 commit 事务）。
// item 9：postMessage/导出所需的真实文件内容与短期下载令牌一并返回。
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import { runCanonicalPipeline } from '../lib/canonical.js';
import { currentState, enumerateAssetKeys, isApprovalValid, publishedAssetsTouched, forkDraft, STATE } from '../lib/lifecycle.js';
import { signAssetToken } from '../lib/assettoken.js';
import { getObjectStore } from '../lib/objectstore.js';

const FORBIDDEN_CLIENT_FIELDS = ['part', 'items', 'pins', 'pinsets', 'packages', 'mock', 'provenance', 'fieldProvenance', 'nonPromotable', 'reviewer', 'figures', 'ir', 'lifecycle'];

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body) return res.status(422).json({ error: '请求体不是合法 JSON' });

  const offending = FORBIDDEN_CLIENT_FIELDS.filter((k) => body[k] !== undefined);
  if (offending.length) {
    return res.status(400).json({
      error: `不接受客户端提交的权威字段：${offending.join(', ')}。请只提交 { jobId, patch }`,
      code: 'client_authoritative_fields_rejected'
    });
  }

  const store = await getJobStore();
  const got = await store.get(body.jobId);
  if (!got.ok) return res.status(400).json({ error: got.error, code: got.code });
  const job = got.job;

  const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {};
  const hasEdits = Object.keys(patch).some((k) => !['includePackageIds', 'schemaVersion', 'expectedRevision'].includes(k));
  const az = authorizeJobAccess(session, job, hasEdits ? { requireRole: 'reviewer' } : {});
  if (!az.ok) return res.status(az.status).json({ error: az.error, code: az.code });

  // item 2：每次请求携带 expectedRevision（乐观锁）
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== job.revision) {
    return res.status(409).json({ error: `版本冲突：当前 revision ${job.revision}`, code: 'revision_conflict', currentRevision: job.revision });
  }

  const canReview = hasRole(session, 'reviewer');
  // item 1/2/3：预跑确定变更集与最终 revision，再以最终值生成产物
  // item 8：从对象存储载入已确认图区的 PNG 字节（IR 中不存 base64）
  const figureBlobs = {};
  {
    const oStore = getObjectStore();
    for (const f of job.ir.figures || []) {
      if (!f.confirmed || !f.image?.objectKey) continue;
      const buf = await oStore.get(f.image.objectKey);
      if (buf) figureBlobs[f.image.objectKey] = Buffer.from(buf).toString('base64');
    }
  }
  const probe = runCanonicalPipeline({ job, patch, session, includeIds: patch.includePackageIds, markReviewed: canReview, figureBlobs });
  if (!probe.ok) return res.status(probe.status).json({ error: probe.error, code: probe.code, ...(probe.errors ? { errors: probe.errors } : {}) });

  // item 4：编辑已发布资产 —— 要么拒绝，要么显式创建新 draft revision（禁止"改了但 state 仍 published"）
  const touchedPublished = publishedAssetsTouched(job.ir, probe.changeLog);
  if (touchedPublished.length) {
    if (body.allowDraftFork !== true) {
      return res.status(409).json({
        error: `以下资产已发布，不能直接修改：${touchedPublished.join(', ')}。如需修改请带 allowDraftFork:true 创建新的 draft revision`,
        code: 'published_asset_immutable',
        publishedAssets: touchedPublished
      });
    }
  }

  // item 1：**空 Patch 也必须持久化**几何归一化后的 Final IR（首次归一化会改动 IR 内容）
  const irChanged = JSON.stringify(job.ir) !== JSON.stringify(probe.normalizedIr);
  const willCommit = probe.changeLog.length > 0 || irChanged || touchedPublished.length > 0;
  const finalRevision = willCommit ? job.revision + 1 : job.revision;
  // item 4：编辑已发布资产时先 fork 出 draft（在生成之前），保证产物与最终 state 一致
  const jobForGen = (touchedPublished.length && body.allowDraftFork === true)
    ? { ...job, ir: forkDraft(job.ir, { actor: session.sub, reason: body.reason || 'edit published asset' }) }
    : job;
  const finalState = (touchedPublished.length && body.allowDraftFork === true) ? STATE.EDITED : probe.state;
  const result = runCanonicalPipeline({
    job: jobForGen, patch, session,
    includeIds: patch.includePackageIds,
    markReviewed: canReview,
    finalRevision, finalState, figureBlobs
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code, ...(result.errors ? { errors: result.errors } : {}) });
  let irToSave = result.normalizedIr;
  let revision = job.revision;

  // item 1/3/12：原子提交 IR + revision + audit + manifest（空 Patch 但 IR 归一化有变化时同样提交）
  if (willCommit) {
    const commit = await store.commitGeneration(job.jobId, {
      ir: irToSave,
      expectedRevision: job.revision,
      actor: session.sub,
      auditEntries: [
        { action: result.changeLog.length ? 'review_patch_applied' : 'final_ir_normalized', detail: { changes: result.changeLog.length, paths: result.changeLog.map((c) => c.path).slice(0, 50), irNormalizedOnly: result.changeLog.length === 0 } },
        { action: 'approvals_invalidated', detail: { invalidated: result.invalidated } },
        { action: 'assets_generated', detail: { nonPromotable: result.bundle.nonPromotable, files: result.assets.allFiles.length, irHash: result.irHash } }
      ],
      manifest: result.assets.manifest
    });
    if (!commit.ok) return res.status(409).json({ error: commit.error, code: commit.code, currentRevision: commit.currentRevision });
    revision = commit.job.revision;
    irToSave = commit.job.ir;   // 以库内为准
  } else {
    await store.appendAudit({ jobId: job.jobId, actor: session.sub, action: 'assets_generated', detail: { nonPromotable: result.bundle.nonPromotable, readOnly: true } });
  }

  const assetToken = signAssetToken({ tenantId: job.tenantId, jobId: job.jobId, revision, sub: session.sub });
  return res.status(200).json({
    ...result.bundle,
    jobId: job.jobId,
    revision,
    state: currentState(irToSave),
    reviewedIr: irToSave,
    partBundle: result.assets.partBundle,
    manifest: result.assets.manifest,
    // item 9：真实文件内容 + 与 tenant/job/revision 绑定的短期下载令牌
    assetFiles: result.assets.allFiles.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, content: f.content, encoding: f.encoding || 'utf8' })),
    assetToken,
    reviewer: irToSave.lifecycle?.reviewedBy || null,
    canReview,
    // v0.8.12：复核面板需要区分"无 publisher 角色"与"资产尚未批准" ——
    // canPublish 把两者压成了同一个 false，面板无法给出正确提示
    canPublishRole: hasRole(session, 'publisher'),
    sessionAuthenticated: session.authenticated === true,
    lifecycle: irToSave.lifecycle || null,
    // item 3/11：资产版本级发布许可（键为 symbol:<pinsetId> / footprint:<packageId> / …）
    canPublish: Object.fromEntries(enumerateAssetKeys(irToSave).map((key) => {
      const kind = key.split(':')[0];
      const promotable = (result.bundle.assetPromotion || {})[kind === 'figure' ? 'figures' : kind] === true;
      return [key, isApprovalValid(irToSave, key, { revision, irHash: result.irHash }) && promotable && hasRole(session, 'publisher')];
    })),
    assetPromotionByKind: result.bundle.assetPromotion || {},
    irHash: result.irHash,
    invalidatedApprovals: result.invalidated
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
