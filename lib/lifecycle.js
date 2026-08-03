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
