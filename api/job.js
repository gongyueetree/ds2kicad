// api/job.js — v0.8.7 item 11：认证态 reloadJob API。
// GET /api/job?jobId=… → 返回当前 Job 的 IR（供页面 ?job= 恢复）
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import { currentState } from '../lib/lifecycle.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const jobId = String(req.query?.jobId || '');
  if (!jobId) return res.status(400).json({ error: '缺少 jobId' });

  const store = await getJobStore();
  const got = await store.get(jobId);
  if (!got.ok) return res.status(400).json({ error: got.error, code: got.code });
  const job = got.job;
  const az = authorizeJobAccess(session, job);
  if (!az.ok) return res.status(az.status).json({ error: az.error, code: az.code });

  const ir = job.ir;
  return res.status(200).json({
    jobId: job.jobId,
    revision: job.revision,
    state: currentState(ir),
    part: ir.part,
    packages: ir.packages,
    pinsets: ir.pinsets,
    figures: ir.figures,
    recommendedPackageIndex: ir.recommendedPackageIndex ?? 0,
    pins: ir.pinsets?.[0]?.normalizedPins || [],
    mock: !!ir.mock,
    lifecycle: ir.lifecycle || null,
    canReview: hasRole(session, 'reviewer'),
    meta: { mode: ir.mock ? 'mock' : ir.degraded ? 'degraded' : 'live', pdfUrl: ir.pdfUrl || null, restored: true }
  });
}
