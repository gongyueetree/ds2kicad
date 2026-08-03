// lib/lifecycle.js — v0.8.5 item 7：显式作业状态机。
// extracted → edited → reviewed → approved → published / revoked
// 每次跃迁记录 actor/role/at/reason，并写入 job.ir.lifecycle（随 IR 持久化）。
export const STATE = {
  EXTRACTED: 'extracted', EDITED: 'edited', REVIEWED: 'reviewed',
  APPROVED: 'approved', PUBLISHED: 'published', REVOKED: 'revoked'
};

const TRANSITIONS = {
  [STATE.EXTRACTED]: { edit: STATE.EDITED, review: STATE.REVIEWED, revoke: STATE.REVOKED },
  [STATE.EDITED]: { edit: STATE.EDITED, review: STATE.REVIEWED, revoke: STATE.REVOKED },
  [STATE.REVIEWED]: { edit: STATE.EDITED, review: STATE.REVIEWED, approve: STATE.APPROVED, revoke: STATE.REVOKED },
  [STATE.APPROVED]: { edit: STATE.EDITED, publish: STATE.PUBLISHED, revoke: STATE.REVOKED }, // 再编辑退回 edited
  [STATE.PUBLISHED]: { revoke: STATE.REVOKED },
  [STATE.REVOKED]: {}
};

/** 各动作所需角色 */
export const ACTION_ROLE = { edit: 'reviewer', review: 'reviewer', approve: 'reviewer', publish: 'publisher', revoke: 'reviewer' };

export function currentState(ir) {
  return ir?.lifecycle?.state || STATE.EXTRACTED;
}

export function canTransition(ir, action) {
  const from = currentState(ir);
  const to = TRANSITIONS[from]?.[action];
  return to ? { ok: true, from, to } : { ok: false, from, error: `状态 ${from} 不允许动作 ${action}` };
}

/**
 * 应用状态跃迁（纯函数，返回新 IR）。
 * approve 会记录**资产级批准**（item 7/11：canPublish 依赖持久化批准状态）。
 */
export function transition(ir, action, { actor, role, reason = '', assets = null, at = new Date().toISOString() } = {}) {
  const t = canTransition(ir, action);
  if (!t.ok) return { ok: false, error: t.error, code: 'invalid_transition', from: t.from };
  const next = structuredClone(ir);
  const history = [...(next.lifecycle?.history || []), { action, from: t.from, to: t.to, actor, role, reason, at, ...(assets ? { assets } : {}) }];
  next.lifecycle = { ...(next.lifecycle || {}), state: t.to, updatedAt: at, updatedBy: actor, history };
  if (action === 'review') {
    next.lifecycle.reviewedBy = { sub: actor, role, at, reason };
  }
  if (action === 'approve') {
    // 资产级批准：合并已有批准（可分多次批不同资产）
    const prev = next.lifecycle.approvals || {};
    const merged = { ...prev };
    for (const a of assets || []) merged[a] = { approvedBy: actor, at, reason };
    next.lifecycle.approvals = merged;
  }
  if (action === 'publish') {
    const prev = next.lifecycle.published || {};
    const merged = { ...prev };
    for (const a of assets || []) merged[a] = { publishedBy: actor, at };
    next.lifecycle.published = merged;
  }
  return { ok: true, ir: next, from: t.from, to: t.to };
}

/** item 7/11：canPublish 依赖持久化批准状态 + publisher 角色 + 当前闸门结论 */
export function computeCanPublish(ir, assetPromotion = {}, hasPublisherRole = false) {
  const approvals = ir?.lifecycle?.approvals || {};
  const out = {};
  for (const asset of ['symbol', 'footprint', 'model3d', 'figures']) {
    out[asset] = !!(approvals[asset] && assetPromotion[asset] && hasPublisherRole);
  }
  return out;
}

// ─────────────── v0.8.6 item 3：资产版本级批准 ───────────────
// 批准键为具体资产版本：symbol:<pinsetId> / footprint:<packageId> / model3d:<packageId> / figure:<figureId>
// 每条批准绑定 revision + irHash + manifestHash + assetHash；一旦相关内容变化即失效。

export const ASSET_KIND = { SYMBOL: 'symbol', FOOTPRINT: 'footprint', MODEL3D: 'model3d', FIGURE: 'figure' };

export function assetKey(kind, id) { return `${kind}:${id}`; }

export function parseAssetKey(key) {
  const i = String(key).indexOf(':');
  if (i < 1) return null;
  const kind = key.slice(0, i), id = key.slice(i + 1);
  if (!Object.values(ASSET_KIND).includes(kind) || !id) return null;
  return { kind, id };
}

/** 枚举当前 IR 下所有合法资产版本键 */
export function enumerateAssetKeys(ir) {
  const keys = [];
  for (const ps of ir?.pinsets || []) keys.push(assetKey(ASSET_KIND.SYMBOL, ps.id));
  for (const p of ir?.packages || []) {
    keys.push(assetKey(ASSET_KIND.FOOTPRINT, p.packageId));
    keys.push(assetKey(ASSET_KIND.MODEL3D, p.packageId));
  }
  for (const f of ir?.figures || []) keys.push(assetKey(ASSET_KIND.FIGURE, f.figureId));
  return keys;
}

/** 记录资产版本批准（分批调用即分批批准） */
export function approveAssets(ir, { keys, actor, revision, irHash, manifestHash, assetHashes = {}, reason, at = new Date().toISOString() }) {
  const next = structuredClone(ir);
  const approvals = { ...(next.lifecycle?.approvals || {}) };
  for (const k of keys) {
    approvals[k] = {
      approvedBy: actor, at, reason,
      revision, irHash, manifestHash,
      assetHash: assetHashes[k] || null
    };
  }
  next.lifecycle = { ...(next.lifecycle || {}), approvals };
  return next;
}

/** item 3：编辑后自动失效受影响资产的 review/approval/publication。
 *  changeLog 的 path 形如 part.mpn / packages[pkg_1].pitch / pinsets[default].pin[3].name / figures[fig_1].confirmed */
export function invalidateAffectedApprovals(ir, changeLog = []) {
  if (!changeLog.length) return { ir, invalidated: [] };
  const next = structuredClone(ir);
  const approvals = { ...(next.lifecycle?.approvals || {}) };
  const published = { ...(next.lifecycle?.published || {}) };
  const affected = new Set();
  let globalChange = false;

  for (const c of changeLog) {
    const path = String(c.path || '');
    let m;
    if ((m = /^packages\[([^\]]+)\]/.exec(path))) {
      affected.add(assetKey(ASSET_KIND.FOOTPRINT, m[1]));
      affected.add(assetKey(ASSET_KIND.MODEL3D, m[1]));
      // 封装改了 pinsetId → 其符号也受影响
      if (/\.pinsetId$/.test(path)) {
        for (const k of enumerateAssetKeys(next)) if (k.startsWith('symbol:')) affected.add(k);
      }
    } else if ((m = /^pinsets\[([^\]]+)\]/.exec(path))) {
      affected.add(assetKey(ASSET_KIND.SYMBOL, m[1]));
      // 管脚变化会改焊盘编号 → 引用该 pinset 的封装资产同样失效
      for (const p of next.packages || []) {
        if (p.pinsetId === m[1]) {
          affected.add(assetKey(ASSET_KIND.FOOTPRINT, p.packageId));
          affected.add(assetKey(ASSET_KIND.MODEL3D, p.packageId));
        }
      }
    } else if ((m = /^figures\[([^\]]+)\]/.exec(path))) {
      affected.add(assetKey(ASSET_KIND.FIGURE, m[1]));
    } else if (/^part\./.test(path)) {
      globalChange = true;      // MPN/厂商影响所有文件名与内容
    }
  }
  if (globalChange) for (const k of Object.keys(approvals)) affected.add(k);

  const invalidated = [];
  for (const k of affected) {
    if (approvals[k]) { delete approvals[k]; invalidated.push(k); }
    if (published[k]) { delete published[k]; invalidated.push(`published:${k}`); }
  }
  next.lifecycle = { ...(next.lifecycle || {}), approvals, published };
  // 任一实质修改都作废整体 review 结论
  if (next.lifecycle.reviewedBy) { next.lifecycle.reviewedBy = null; invalidated.push('reviewedBy'); }
  return { ir: next, invalidated };
}

/** item 3/4：某资产版本是否已批准且批准仍然有效（绑定的 revision/irHash 未变） */
export function isApprovalValid(ir, key, { revision, irHash } = {}) {
  const a = ir?.lifecycle?.approvals?.[key];
  if (!a) return false;
  if (revision !== undefined && a.revision !== revision) return false;
  if (irHash !== undefined && a.irHash !== irHash) return false;
  return true;
}

/** item 4：发布创建**不可变 AssetVersion** */
export function publishAssets(ir, { keys, actor, revision, irHash, manifestHash, assetHashes = {}, manifest = null, at = new Date().toISOString() }) {
  const next = structuredClone(ir);
  const published = { ...(next.lifecycle?.published || {}) };
  const versions = [...(next.assetVersions || [])];
  for (const k of keys) {
    const version = {
      assetKey: k,
      versionId: `${k}@r${revision}`,
      revision, irHash, manifestHash,
      assetHash: assetHashes[k] || null,
      publishedBy: actor, publishedAt: at,
      files: (manifest?.files || []).map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
      immutable: true
    };
    versions.push(Object.freeze(version));
    published[k] = { versionId: version.versionId, publishedBy: actor, at, revision };
  }
  next.assetVersions = versions;
  next.lifecycle = { ...(next.lifecycle || {}), published };
  return next;
}
