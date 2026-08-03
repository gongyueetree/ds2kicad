// lib/auth.js — v0.8.2 item 2 & 10：ezPLM 会话鉴权（BFF 模式）。
// 设计：浏览器不持有任何 API 密钥。身份来自 ezPLM 签发的会话 JWT，通过
//   - HttpOnly Cookie（同源 BFF 部署，浏览器自动携带），或
//   - Authorization: Bearer（服务端到服务端调用）
// 服务端用 EZPLM_JWT_SECRET（HS256）验签，取出 sub/tenantId/name 作为 **唯一** reviewer 身份来源。
// 前端自填的 reviewer 字符串一律忽略（item 2）。
//
// 未配置 EZPLM_JWT_SECRET 时的行为由 AUTH_MODE 决定：
//   production（默认，NODE_ENV=production 时强制）→ 拒绝所有请求（fail closed）
//   dev                                            → 放行为匿名开发身份，且结果标记不可晋升
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function verifyJwtHs256(token, key) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, error: 'JWT 格式非法' };
  const [h, p, s] = parts;
  const expect = Buffer.from(b64u(createHmac('sha256', key).update(`${h}.${p}`).digest()));
  const got = Buffer.from(s);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, error: 'JWT 签名不匹配' };
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'JWT 载荷损坏' };
  }
  if (header.alg !== 'HS256') return { ok: false, error: `不支持的 alg=${header.alg}` };
  const now = Date.now() / 1000;
  // item 5：exp/nbf 必须是**有限数值**（"not-a-number"、Infinity、null 一律拒绝）
  // item 11：exp/nbf 只接受**有限整数**（字符串、小数、Infinity、NaN 全部拒绝）
  const finiteInt = (v) => typeof v === 'number' && Number.isInteger(v);
  if (payload.exp === undefined || payload.exp === null) return { ok: false, error: 'JWT 缺少 exp' };
  if (!finiteInt(payload.exp)) return { ok: false, error: 'JWT exp 必须是有限整数' };
  if (now > Number(payload.exp)) return { ok: false, error: 'JWT 已过期' };
  if (payload.nbf !== undefined && payload.nbf !== null) {
    if (!finiteInt(payload.nbf)) return { ok: false, error: 'JWT nbf 必须是有限整数' };
    if (now < Number(payload.nbf) - 60) return { ok: false, error: 'JWT 尚未生效（nbf）' };
  }
  // item 5：生产环境必须配置 iss/aud 且严格校验
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || !!process.env.VERCEL;
  const wantIss = process.env.EZPLM_JWT_ISS;
  const wantAud = process.env.EZPLM_JWT_AUD;
  if (isProd && (!wantIss || !wantAud)) return { ok: false, error: '生产环境必须配置 EZPLM_JWT_ISS 与 EZPLM_JWT_AUD' };
  if (wantIss && payload.iss !== wantIss) return { ok: false, error: `iss 不匹配（期望 ${wantIss}）` };
  if (wantAud) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(wantAud)) return { ok: false, error: `aud 不匹配（期望 ${wantAud}）` };
  }
  return { ok: true, payload };
}

/** item 11：畸形 Cookie 必须安全处理（超长、无 '='、重复、非法百分号编码都不得抛异常） */
function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > 8192) return null;                 // 超长 Cookie 直接放弃
  for (const part of raw.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;                            // 无 '=' 或以 '=' 开头 → 跳过
    if (seg.slice(0, eq) !== name) continue;
    const rawVal = seg.slice(eq + 1);
    if (!rawVal || rawVal.length > 4096) return null;
    try {
      return decodeURIComponent(rawVal);              // 非法 % 序列会抛错
    } catch {
      return rawVal;                                  // 解码失败则按原样返回，绝不抛出
    }
  }
  return null;
}

/**
 * @returns {{ok:true, session:{sub,name,tenantId,authenticated:boolean}} | {ok:false,status:number,error:string}}
 */
export function authenticate(req) {
  const key = process.env.EZPLM_JWT_SECRET;
  const mode = process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'production' : 'dev');

  const bearer = (req.headers?.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  const token = bearer || readCookie(req, 'ezplm_session');

  // v0.8.6 修复：AUTH_MODE=dev 的匿名回退此前写在 `if (!key)` 内部，
  // 导致"同时配了 EZPLM_JWT_SECRET + AUTH_MODE=dev"时 dev 完全失效。
  // 正确语义：显式声明 dev 时，无 token 一律回退匿名；带了 token 仍走正常验签。
  const devAnonymous = () => ({
    ok: true,
    session: { sub: 'dev-anonymous', name: '开发匿名用户', tenantId: 'dev', roles: ['viewer', 'editor', 'reviewer'], authenticated: false, devMode: true }
  });
  if (!key) {
    if (mode === 'production') {
      return { ok: false, status: 503, error: '服务未配置 EZPLM_JWT_SECRET：生产环境拒绝未鉴权访问' };
    }
    return devAnonymous();
  }
  if (!token) {
    if (mode === 'dev') return devAnonymous();
    return { ok: false, status: 401, error: '缺少 ezPLM 会话（Cookie ezplm_session 或 Authorization: Bearer）' };
  }
  const v = verifyJwtHs256(token, key);
  if (!v.ok) return { ok: false, status: 401, error: `会话校验失败：${v.error}` };
  const p = v.payload;
  if (!p.sub) return { ok: false, status: 401, error: '会话缺少 sub' };
  if (!p.tenantId && !p.tid) return { ok: false, status: 401, error: '会话缺少 tenantId' };
  const roles = normalizeRoles(p.roles ?? p.role ?? p.scope);
  return {
    ok: true,
    session: {
      sub: String(p.sub),
      name: String(p.name || p.preferred_username || p.sub),
      tenantId: String(p.tenantId || p.tid),
      roles,
      authenticated: true
    }
  };
}

/** item 2：角色模型。viewer < editor < reviewer < publisher（后者隐含前者） */
export const ROLES = ['viewer', 'editor', 'reviewer', 'publisher'];
const IMPLIES = { publisher: ['publisher', 'reviewer', 'editor', 'viewer'], reviewer: ['reviewer', 'editor', 'viewer'], editor: ['editor', 'viewer'], viewer: ['viewer'] };

function normalizeRoles(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out = new Set();
  for (const r of list) {
    const k = String(r).trim().toLowerCase();
    for (const implied of IMPLIES[k] || []) out.add(implied);
  }
  if (!out.size) out.add('viewer'); // 默认最小权限
  return [...out];
}

export function hasRole(session, role) {
  return Array.isArray(session?.roles) && session.roles.includes(role);
}

/** 作业访问授权：同租户 + （本人 or reviewer/publisher）。同租户其他普通用户不得重放他人 jobId */
export function authorizeJobAccess(session, job, { requireRole } = {}) {
  // v0.8.6：AUTH_MODE=dev 的匿名会话允许访问（结果仍被 PromotionGate 标记不可晋升，
  // 见 no_authenticated_ezplm_session），否则 dev 模式只能提取、无法生成。
  if (!session?.authenticated && !session?.devMode) {
    return { ok: false, status: 401, error: '需要已认证的 ezPLM 会话' };
  }
  if (job.tenantId !== session.tenantId) return { ok: false, status: 403, error: '作业不属于当前租户', code: 'tenant_mismatch' };
  const isOwner = job.ownerId === session.sub;
  const elevated = hasRole(session, 'reviewer') || hasRole(session, 'publisher');
  if (!isOwner && !elevated) {
    return { ok: false, status: 403, error: '无权访问他人作业（需要本人或 reviewer/publisher 角色）', code: 'not_job_owner' };
  }
  if (requireRole && !hasRole(session, requireRole)) {
    return { ok: false, status: 403, error: `缺少 ${requireRole} 权限`, code: 'insufficient_role' };
  }
  return { ok: true };
}

/** 测试/本地联调用：签发一个 ezPLM 风格会话 JWT */
export function issueDevSession({ sub, name, tenantId, roles = ['editor'], iss, aud, nbf, ttlSec = 3600 }, key) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    sub, name, tenantId, roles,
    ...(iss ? { iss } : {}), ...(aud ? { aud } : {}), ...(nbf ? { nbf } : {}),
    exp: Math.floor(Date.now() / 1000) + ttlSec
  }));
  const sig = b64u(createHmac('sha256', key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
