// api/lifecycle.js — v0.8.5 item 7：独立的 Review / Approve / Publish / Revoke API。
// POST /api/lifecycle { jobId, action, assets?, reason }
//   action=review  → 需要 reviewer
//   action=approve → 需要 reviewer，assets 为资产列表（symbol/footprint/model3d/figures）
//   action=publish → 需要 publisher，且对应资产必须已 approved 且当前闸门允许
//   action=revoke  → 需要 reviewer
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import {
  transition, ACTION_ROLE, currentState,
  approveAssets, publishAssets, enumerateAssetKeys, parseAssetKey, isApprovalValid
} from '../lib/lifecycle.js';
import { createHash } from 'node:crypto';
import { runCanonicalPipeline, irHash as computeIrHash } from '../lib/canonical.js';



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

  // item 4：所有 lifecycle 动作都必须携带 expectedRevision
  if (body.expectedRevision === undefined) {
    return res.status(400).json({ error: '必须携带 expectedRevision', code: 'expected_revision_required' });
  }
  if (body.expectedRevision !== job.revision) {
    return res.status(409).json({ error: `版本冲突：当前 revision ${job.revision}`, code: 'revision_conflict', currentRevision: job.revision });
  }

  // item 3：assets 为**资产版本键**（symbol:<pinsetId> / footprint:<packageId> / model3d:<packageId> / figure:<figureId>）
  let assets = null;
  if (action === 'approve' || action === 'publish') {
    assets = Array.isArray(body.assets) ? body.assets.map(String) : null;
    if (!assets?.length) return res.status(400).json({ error: 'approve/publish 必须指定资产版本键列表（如 footprint:pkg_1）', code: 'assets_required' });
    const valid = new Set(enumerateAssetKeys(job.ir));
    const bad = assets.filter((a) => !parseAssetKey(a) || !valid.has(a));
    if (bad.length) return res.status(400).json({ error: `未知或不存在的资产版本：${bad.join(', ')}`, code: 'unknown_asset', validKeys: [...valid] });
    if (!reason || String(reason).trim().length < 2) return res.status(400).json({ error: '必须提供理由', code: 'reason_required' });
  }

  // approve / publish 前重新跑 Canonical 流程，绑定当前 revision/irHash/manifestHash/assetHash
  let pipe = null, assetHashes = {}, manifestHash = null, thisIrHash = null;
  if (action === 'approve' || action === 'publish') {
    pipe = runCanonicalPipeline({ job, patch: {}, session, includeIds: null, markReviewed: false, finalRevision: job.revision, finalState: currentState(job.ir) });
    if (!pipe.ok) return res.status(pipe.status).json({ error: pipe.error, code: pipe.code, errors: pipe.errors });
    const promo = pipe.bundle.assetPromotion || {};
    const kindOf = (k) => { const kind = parseAssetKey(k).kind; return kind === 'figure' ? 'figures' : kind; };
    const blocked = assets.filter((a) => promo[kindOf(a)] !== true);
    if (blocked.length) {
      return res.status(409).json({
        error: `以下资产未通过晋升闸门，不能 ${action}：${blocked.join(', ')}`,
        code: 'asset_not_promotable',
        assetBlockReasons: pipe.bundle.assetBlockReasons
      });
    }
    thisIrHash = pipe.irHash;
    manifestHash = createHash('sha256').update(JSON.stringify(pipe.assets.manifest)).digest('hex');
    assetHashes = computeAssetHashes(pipe, assets);
    if (action === 'publish') {
      // item 3：批准必须仍然有效（绑定 revision + irHash）
      const invalid = assets.filter((a) => !isApprovalValid(job.ir, a, { revision: job.revision, irHash: thisIrHash }));
      if (invalid.length) {
        return res.status(409).json({ error: `以下资产尚未 approve 或批准已因编辑失效：${invalid.join(', ')}`, code: 'asset_not_approved' });
      }
    }
  }

  const t = transition(job.ir, action, { actor: session.sub, role: requiredRole, reason, assets });
  if (!t.ok) return res.status(409).json({ error: t.error, code: t.code, from: t.from });
  let nextIr = t.ir;
  if (action === 'approve') {
    nextIr = approveAssets(nextIr, { keys: assets, actor: session.sub, revision: job.revision, irHash: thisIrHash, manifestHash, assetHashes, reason });
  } else if (action === 'publish') {
    // item 4：发布创建不可变 AssetVersion
    nextIr = publishAssets(nextIr, { keys: assets, actor: session.sub, revision: job.revision, irHash: thisIrHash, manifestHash, assetHashes, manifest: pipe.assets.manifest });
  }

  // item 12：Lifecycle 与 Manifest/AssetVersion 全部在同一事务提交
  const commit = await store.commitGeneration(job.jobId, {
    ir: nextIr, expectedRevision: job.revision, actor: session.sub,
    auditEntries: [{ action: `lifecycle_${action}`, detail: { from: t.from, to: t.to, assets, reason, irHash: thisIrHash, manifestHash } }],
    manifest: pipe?.assets?.manifest || null
  });
  if (!commit.ok) return res.status(409).json({ error: commit.error, code: commit.code, currentRevision: commit.currentRevision });

  if (action === 'revoke') await store.revoke(job.jobId, session.sub);

  return res.status(200).json({
    jobId: job.jobId,
    revision: commit.job.revision,
    state: currentState(commit.job.ir),
    lifecycle: commit.job.ir.lifecycle,
    assetVersions: commit.job.ir.assetVersions || [],
    approvals: commit.job.ir.lifecycle?.approvals || {},
    published: commit.job.ir.lifecycle?.published || {}
  });
}

/** 每个资产版本的内容哈希（symbol 取符号块，footprint/model3d 取对应文件，figure 取 PNG 哈希） */
function computeAssetHashes(pipe, keys) {
  const out = {};
  const sha = (t) => createHash('sha256').update(t ?? '').digest('hex');
  for (const key of keys) {
    const { kind, id } = parseAssetKey(key);
    if (kind === 'symbol') {
      const sym = pipe.bundle.symbols.find((s) => (pipe.normalizedIr.packages || []).some((p) => p.pinsetId === id && p.name && s.packages?.includes(p.name)));
      out[key] = sha(sym?.legacyLib || pipe.bundle.files.kicadSym);
    } else if (kind === 'footprint' || kind === 'model3d') {
      const it = pipe.bundle.items.find((x) => x.packageId === id);
      out[key] = sha(kind === 'footprint' ? it?.files?.kicadMod : it?.files?.wrl);
    } else if (kind === 'figure') {
      const f = (pipe.normalizedIr.figures || []).find((x) => x.figureId === id);
      out[key] = f?.imageSha256 || sha(JSON.stringify(f?.bbox));
    }
  }
  return out;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
