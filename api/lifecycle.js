// api/lifecycle.js — v0.8.5 item 7：独立的 Review / Approve / Publish / Revoke API。
// POST /api/lifecycle { jobId, action, assets?, reason }
//   action=review  → 需要 reviewer
//   action=approve → 需要 reviewer，assets 为资产列表（symbol/footprint/model3d/figures）
//   action=publish → 需要 publisher，且对应资产必须已 approved 且当前闸门允许
//   action=revoke  → 需要 reviewer
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import { transition, ACTION_ROLE, computeCanPublish, currentState } from '../lib/lifecycle.js';
import { runCanonicalPipeline } from '../lib/canonical.js';

const ASSETS = ['symbol', 'footprint', 'model3d', 'figures'];

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 POST' });

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body) return res.status(422).json({ error: '请求体不是合法 JSON' });
  const { jobId, action, reason = '' } = body;
  if (!ACTION_ROLE[action]) return res.status(400).json({ error: `未知动作 ${action}`, code: 'unknown_action' });

  const store = await getJobStore();
  const got = await store.get(jobId);
  if (!got.ok) return res.status(400).json({ error: got.error, code: got.code });
  const job = got.job;

  const requiredRole = ACTION_ROLE[action];
  const az = authorizeJobAccess(session, job, { requireRole: requiredRole });
  if (!az.ok) return res.status(az.status).json({ error: az.error, code: az.code });

  let assets = null;
  if (action === 'approve' || action === 'publish') {
    assets = Array.isArray(body.assets) ? body.assets.map(String) : null;
    if (!assets?.length) return res.status(400).json({ error: 'approve/publish 必须指定 assets 列表', code: 'assets_required' });
    const bad = assets.filter((a) => !ASSETS.includes(a));
    if (bad.length) return res.status(400).json({ error: `未知资产：${bad.join(', ')}`, code: 'unknown_asset' });
    if (!reason || String(reason).trim().length < 2) return res.status(400).json({ error: '必须提供理由', code: 'reason_required' });
  }

  // approve / publish 前必须重新跑一次 Canonical 流程，确认当前闸门确实允许该资产
  if (action === 'approve' || action === 'publish') {
    const pipe = runCanonicalPipeline({ job, patch: {}, session, includeIds: null, markReviewed: false });
    if (!pipe.ok) return res.status(pipe.status).json({ error: pipe.error, code: pipe.code, errors: pipe.errors });
    const promo = pipe.bundle.assetPromotion || {};
    const blocked = assets.filter((a) => !promo[a]);
    if (blocked.length) {
      return res.status(409).json({
        error: `以下资产未通过晋升闸门，不能 ${action}：${blocked.join(', ')}`,
        code: 'asset_not_promotable',
        assetBlockReasons: pipe.bundle.assetBlockReasons
      });
    }
    if (action === 'publish') {
      const approvals = job.ir.lifecycle?.approvals || {};
      const notApproved = assets.filter((a) => !approvals[a]);
      if (notApproved.length) {
        return res.status(409).json({ error: `以下资产尚未 approve：${notApproved.join(', ')}`, code: 'asset_not_approved' });
      }
    }
  }

  const t = transition(job.ir, action, { actor: session.sub, role: requiredRole, reason, assets });
  if (!t.ok) return res.status(409).json({ error: t.error, code: t.code, from: t.from });

  const commit = await store.commitGeneration(job.jobId, {
    ir: t.ir, expectedRevision: job.revision, actor: session.sub,
    auditEntries: [{ action: `lifecycle_${action}`, detail: { from: t.from, to: t.to, assets, reason } }]
  });
  if (!commit.ok) return res.status(409).json({ error: commit.error, code: commit.code, currentRevision: commit.currentRevision });

  if (action === 'revoke') await store.revoke(job.jobId, session.sub);

  return res.status(200).json({
    jobId: job.jobId,
    revision: commit.job.revision,
    state: currentState(commit.job.ir),
    lifecycle: commit.job.ir.lifecycle,
    canPublish: computeCanPublish(commit.job.ir, {}, hasRole(session, 'publisher'))
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
