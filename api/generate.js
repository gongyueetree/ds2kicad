// api/generate.js — v0.8.5：POST { jobId, patch } → Canonical 流程 → 事务保存 → 完整产物。
// item 3：响应 reviewedIr、数据库 IR、Part Bundle、KiCad 全部来自同一份 normalized IR；
//         生成失败绝不修改 Job（先 run pipeline，成功后才 commit 事务）。
// item 9：postMessage/导出所需的真实文件内容与短期下载令牌一并返回。
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import { runCanonicalPipeline } from '../lib/canonical.js';
import { transition, currentState, computeCanPublish, STATE } from '../lib/lifecycle.js';
import { signAssetToken } from '../lib/assettoken.js';

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
  const result = runCanonicalPipeline({
    job, patch, session,
    includeIds: patch.includePackageIds,
    markReviewed: canReview
  });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, code: result.code, ...(result.errors ? { errors: result.errors } : {}) });
  }

  let irToSave = result.normalizedIr;
  let revision = job.revision;

  // 有实质修改 → 状态机推进到 edited，并在同一事务里保存 IR + audit + manifest
  if (result.changeLog.length) {
    const t = transition(irToSave, 'edit', { actor: session.sub, role: 'reviewer', reason: 'review_patch' });
    if (!t.ok) return res.status(409).json({ error: t.error, code: t.code });
    irToSave = t.ir;
    const commit = await store.commitGeneration(job.jobId, {
      ir: irToSave,
      expectedRevision: job.revision,
      actor: session.sub,
      auditEntries: [
        { action: 'review_patch_applied', detail: { changes: result.changeLog.length, paths: result.changeLog.map((c) => c.path).slice(0, 50) } },
        { action: 'assets_generated', detail: { nonPromotable: result.bundle.nonPromotable, files: result.assets.files.length } }
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
    assetFiles: result.assets.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, content: f.content })),
    assetToken,
    reviewer: irToSave.lifecycle?.reviewedBy || null,
    canReview,
    canPublish: computeCanPublish(irToSave, result.bundle.assetPromotion || {}, hasRole(session, 'publisher'))
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
