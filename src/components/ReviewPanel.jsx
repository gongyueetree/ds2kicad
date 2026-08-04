// src/components/ReviewPanel.jsx — v0.8.12 资产版本级复核面板
//
// 补上 extract → review → approve → publish 的最后一段：此前 api/lifecycle.js 与
// apiLifecycle() 都已就绪，但页面上没有任何调用点，"复核"只能手工敲 API。
//
// 判定一律以服务端为准：
//   · 能否勾选 approve  → bundle.assetKeyPromotion[key].promotable（闸门的资产键级结论）
//   · 能否勾选 publish  → bundle.canPublish[key]（已批准 + 闸门通过 + 具备 publisher 角色）
// 前端不自行推断可晋升性，只负责呈现原因与收集理由。
import { useMemo, useState } from 'react';
import { apiLifecycle } from '../api.js';
import { REASON_HELP } from '../promotionHelp.js';

const KIND_LABEL = { symbol: '符号', footprint: '封装', model3d: '3D 模型', figure: '图区' };

export default function ReviewPanel({ bundle, onLifecycle }) {
  const [sel, setSel] = useState(() => new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  // 状态机：extracted/edited → review → reviewed → approve → approved → publish
  // approve 在 extracted 状态下会被拒（invalid_transition），必须先走一次 review
  const state = bundle?.state || 'extracted';
  const canApproveNow = ['reviewed', 'approved', 'published'].includes(state);

  const ad = bundle?.authDiagnostics || {};
  const byKey = bundle?.assetKeyPromotion || {};
  const canPublish = bundle?.canPublish || {};
  const approvals = bundle?.lifecycle?.approvals || {};
  const published = bundle?.lifecycle?.published || {};

  const rows = useMemo(() => Object.keys(byKey).sort().map((key) => {
    const [kind, id] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
    return {
      key, kind, id,
      promotable: byKey[key]?.promotable === true,
      reasons: byKey[key]?.reasons || [],
      approved: !!approvals[key],
      isPublished: !!published[key],
      // 服务端 canPublish 是**生成时**算的，approve 之后就过期了。
      // 这里按与服务端相同的规则重新推导（批准记录存在 + 闸门通过 + publisher 角色），
      // 使"批准 → 发布"能在同一屏内连续完成；老响应缺 canPublishRole 时回退到服务端值。
      publishable: bundle?.canPublishRole === undefined
        ? canPublish[key] === true
        : (bundle.canPublishRole === true && byKey[key]?.promotable === true && !!approvals[key])
    };
  }), [byKey, canPublish, approvals, published, bundle?.canPublishRole]);


  const toggle = (key) => setSel((s) => {
    const n = new Set(s);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  const LABEL = { review: '标记已复核', approve: '批准', publish: '发布' };

  const act = async (action) => {
    setErr('');
    const keys = [...sel];
    if (action !== 'review') {
      if (!keys.length) { setErr('请先勾选要处理的资产版本'); return; }
      if (reason.trim().length < 2) { setErr('必须填写理由（至少 2 个字符）'); return; }
    }
    setBusy(`正在${LABEL[action]}…`);
    try {
      const r = await apiLifecycle({
        jobId: bundle.jobId, action,
        ...(action === 'review' ? {} : { assets: keys }),
        reason: reason.trim() || '页面复核', expectedRevision: bundle.revision
      });
      // lifecycle 动作必然 revision+1 —— 不回写就会复现 v0.8.11 的 409 连锁
      onLifecycle?.(r);
      setSel(new Set());
      setBusy(`${LABEL[action]}成功 ✓（revision → ${r.revision}）`);
      setTimeout(() => setBusy(''), 4000);
    } catch (e) {
      setBusy('');
      if (e.code === 'asset_not_promotable') {
        setErr(`${e.message}。闸门结论以服务端为准，请先清除下方列出的阻断原因。`);
      } else if (e.code === 'insufficient_role') {
        setErr(`${e.message}。请在 ezPLM 签发的 JWT 中补上对应角色（approve 需 reviewer，publish 需 publisher）。`);
      } else if (e.code === 'tenant_mismatch' || e.code === 'not_job_owner') {
        setErr(`${e.message}。JWT 的 tenantId 必须与作业所属租户一致。`);
      } else if (e.code === 'invalid_transition') {
        setErr(`${e.message}。approve 必须先经过「标记已复核」，publish 必须先 approve。`);
      } else if (e.code === 'revision_conflict') {
        onLifecycle?.({ revision: e.currentRevision });
        setErr(`版本冲突：已同步到 revision ${e.currentRevision}，请重新点击生成后再复核。`);
      } else {
        setErr(e.message);
      }
    }
  };

  const selectable = rows.filter((r) => r.promotable && !r.approved);
  const publishable = rows.filter((r) => r.publishable && !r.isPublished);
  const blockedReasons = [...new Set(rows.flatMap((r) => r.reasons))];

  return (
    <div className="review-panel">
      <h3>资产版本复核</h3>
      <p className="hint">
        当前 revision <b>{bundle.revision}</b> · 状态 <b>{bundle.state}</b>
        {bundle.sessionAuthenticated === false && <span className="src-badge src-fallback" style={{ marginLeft: 8 }}>会话未认证 — 任何资产都无法晋升</span>}
        {bundle.canReview === false && <span className="src-badge src-fallback" style={{ marginLeft: 8 }}>无 reviewer 角色</span>}
        {bundle.canPublishRole === false && <span className="src-badge src-fallback" style={{ marginLeft: 8 }}>无 publisher 角色</span>}
      </p>

      {ad.devMode && (
        <div className="warn-box" style={{ marginBottom: 10 }}>
          <p><b>⚠ 当前是 AUTH_MODE=dev 的匿名身份，不是你配置的 JWT 会话。</b></p>
          <p>
            服务端收到的这次请求{ad.tokenPresent ? '带了令牌但验签未通过' : <b>没有携带任何令牌</b>}
            {ad.secretConfigured ? '（EZPLM_JWT_SECRET 已配置）' : '（EZPLM_JWT_SECRET 未配置）'}，
            于是被静默降级为匿名会话 <code>dev-anonymous</code>（roles: viewer/editor/reviewer，<b>authenticated: false</b>）。
            这正是每个资产都挂着 <code>no_authenticated_ezplm_session</code>、且「无 publisher 角色」的原因 ——
            匿名身份恰好带 reviewer，所以「标记已复核」能点，但任何资产都晋升不了。
          </p>
          <p>
            前端 <code>src/api.js</code> 不会把令牌写进浏览器 bundle，它依赖<b>同源 Cookie <code>ezplm_session</code></b>
            或网关注入的 <code>Authorization: Bearer</code>。只配 <code>EZPLM_JWT_SECRET</code> 不会让浏览器自动带上令牌。
          </p>
          <p>本地联调可用仓库里的 <code>node scripts/mint-session.mjs</code> 生成令牌与设置 Cookie 的命令；生产环境请设 <code>AUTH_MODE=production</code>，届时无令牌会直接 401，而不是静默降级。</p>
          {ad.jobTenantId && ad.sessionTenantId && ad.jobTenantId !== ad.sessionTenantId && (
            <p><b>注意：</b>本作业属于租户 <code>{ad.jobTenantId}</code>，当前会话租户是 <code>{ad.sessionTenantId}</code>。
              换成真实 JWT 后访问旧作业会得到 403 <code>tenant_mismatch</code> —— <b>需要重新提取一次，生成属于新租户的作业</b>。</p>
          )}
        </div>
      )}

      <details className="review-help" open={!rows.length || bundle.canReview === false}>
        <summary>会话与权限诊断</summary>
        <ul>
          <li>AUTH_MODE：<b>{ad.authMode ?? '未知'}</b>　EZPLM_JWT_SECRET 已配置：<b>{String(ad.secretConfigured ?? '未知')}</b></li>
          <li>本次请求携带令牌：<b>{String(ad.tokenPresent ?? '未知')}</b>　匿名降级：<b>{String(ad.devMode ?? '未知')}</b></li>
          <li>会话角色：<code>{(ad.roles || []).join(', ') || '（无）'}</code>　租户：<code>{ad.sessionTenantId ?? '?'}</code>　作业租户：<code>{ad.jobTenantId ?? '?'}</code></li>
          <li>会话已认证：<b>{String(bundle.sessionAuthenticated ?? '未知（服务端未返回，多半是后端仍是旧版本）')}</b></li>
          <li>reviewer 角色：<b>{String(bundle.canReview ?? '未知')}</b>
            {bundle.canReview === false && <span className="hint">　—— JWT 缺少 <code>roles</code> 声明（也接受 <code>role</code> / <code>scope</code>），需包含 <code>reviewer</code>；否则 lifecycle 调用会被 403 拒绝</span>}
          </li>
          <li>publisher 角色：<b>{String(bundle.canPublishRole ?? '未知')}</b></li>
          <li>作业状态：<b>{state}</b>　revision <b>{bundle.revision}</b></li>
          <li>资产版本键：<b>{rows.length}</b> 个
            {!rows.length && <span className="hint">　—— 服务端未返回 assetKeyPromotion。请确认后端已更新到 v0.8.12 并重新点击「生成」（面板读的是生成结果，不是提取结果）</span>}
          </li>
        </ul>
      </details>

      {!rows.length && (
        <p className="error-line">
          ✕ 没有拿到任何资产版本键，无法逐项复核。「标记已复核」不依赖资产列表，仍可先执行；
          批准与发布需要资产列表，请先重新生成。
        </p>
      )}

      {rows.length > 0 && (
      <table className="review-table">
        <thead>
          <tr><th /><th>资产版本</th><th>闸门</th><th>状态</th><th>阻断原因</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const checkable = (r.promotable && !r.approved) || r.publishable;
            return (
              <tr key={r.key} className={r.promotable ? '' : 'blocked'}>
                <td>
                  <input type="checkbox" disabled={!checkable} checked={sel.has(r.key)}
                    onChange={() => toggle(r.key)} title={checkable ? '' : '未通过晋升闸门或已处理'} />
                </td>
                <td><code>{r.key}</code> <span className="hint">{KIND_LABEL[r.kind] || r.kind}</span></td>
                <td>
                  <span className={`src-badge ${r.promotable ? 'src-parser' : 'src-fallback'}`}>
                    {r.promotable ? '通过' : '阻断'}
                  </span>
                </td>
                <td>
                  {r.isPublished ? <span className="src-badge src-parser">已发布</span>
                    : r.approved ? <span className="src-badge src-parser">已批准</span>
                      : <span className="hint">草稿</span>}
                </td>
                <td className="hint">{r.reasons.length ? r.reasons.join('、') : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}

      <div className="review-actions">
        <input className="review-reason" value={reason} placeholder="复核理由（必填，会写入审计日志）"
          onChange={(e) => setReason(e.target.value)} />
        <button className="btn-secondary" disabled={!!busy || bundle.canReview === false || canApproveNow}
          title={canApproveNow ? '已完成复核标记' : '状态机要求：approve 之前必须先 review'}
          onClick={() => act('review')}>
          ① 标记已复核{canApproveNow ? ' ✓' : ''}
        </button>
        <button className="btn-primary" disabled={!!busy || !sel.size || bundle.canReview === false || !canApproveNow}
          title={canApproveNow ? '' : '请先点「标记已复核」'}
          onClick={() => act('approve')}>
          ② 批准所选（{sel.size}）
        </button>
        <button className="btn-secondary" disabled={!!busy || !sel.size || bundle.canPublishRole === false} onClick={() => act('publish')}>
          ③ 发布所选
        </button>
      </div>
      {bundle.canReview === false && (
        <p className="error-line">
          ✕ 当前会话没有 <code>reviewer</code> 角色，「标记已复核」与「批准」均不可用。
          请在 ezPLM 签发的 JWT 中加入 <code>"roles": ["reviewer"]</code>（发布还需 <code>publisher</code>）。
          注意：<code>sessionAuthenticated</code> 为 true 只说明验签通过，与角色是两回事。
        </p>
      )}
      <p className="hint">
        当前状态 <b>{state}</b>{canApproveNow ? '' : '（需先「标记已复核」才能批准）'}　可批准 {selectable.length} 项 · 可发布 {publishable.length} 项。
        批准与发布都会使 revision +1；任何后续编辑会自动使受影响的批准失效。
      </p>
      {err && <p className="error-line">✕ {err}</p>}
      {busy && <p className="status-line">{busy}</p>}

      {blockedReasons.length > 0 && (
        <details className="review-help">
          <summary>阻断原因说明与处理位置（{blockedReasons.length} 条）</summary>
          <ul>
            {blockedReasons.map((code) => {
              const h = REASON_HELP[code];
              return (
                <li key={code}>
                  <code>{code}</code>
                  {h ? <> —— {h[0]}。<span className="hint">{h[1]}</span></> : ' —— 未登记的阻断原因，请查看生成告警'}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
