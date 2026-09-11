// lib/auth.js — ezPLM/eeHub authenticated session + v1.2 signed guest session.
// Browser secrets never enter the bundle. Authenticated sessions use HS256 JWT from ezPLM/eeHub;
// public EETree/Tindie trial sessions use a signed Guest token / HttpOnly cookie.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { guestSessionFromRequest } from './platform-session.js';

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
  const finiteInt = (v) => typeof v === 'number' && Number.isInteger(v);
  if (payload.exp === undefined || payload.exp === null) return { ok: false, error: 'JWT 缺少 exp' };
  if (!finiteInt(payload.exp)) return { ok: false, error: 'JWT exp 必须是有限整数' };
  if (now > Number(payload.exp)) return { ok: false, error: 'JWT 已过期' };
  if (payload.nbf !== undefined && payload.nbf !== null) {
    if (!finiteInt(payload.nbf)) return { ok: false, error: 'JWT nbf 必须是有限整数' };
    if (now < Number(payload.nbf) - 60) return { ok: false, error: 'JWT 尚未生效（nbf）' };
  }
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

function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > 8192) return null;
  for (const part of raw.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    if (seg.slice(0, eq) !== name) continue;
    const rawVal = seg.slice(eq + 1);
    if (!rawVal || rawVal.length > 4096) return null;
    try { return decodeURIComponent(rawVal); } catch { return rawVal; }
  }
  return null;
}

/**
 * @returns {{ok:true, session:Object} | {ok:false,status:number,error:string}}
 */
export function authenticate(req) {
  const key = process.env.EZPLM_JWT_SECRET;
  const mode = process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'production' : 'dev');
  const bearer = (req.headers?.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  const token = bearer || readCookie(req, 'ezplm_session');

  // Public trial is checked before production JWT fail-closed behavior. Guest identity never carries
  // reviewer/publisher privilege and all expensive operations are quota-gated server-side.
  if (!token) {
    const guest = guestSessionFromRequest(req);
    if (guest) return { ok: true, session: guest };
  }

  const devAnonymous = () => ({
    ok: true,
    session: {
      sub: 'dev-anonymous', name: '开发匿名用户', tenantId: 'dev',
      roles: ['viewer', 'editor', 'reviewer'], authenticated: false, devMode: true,
      authMode: mode, tokenPresent: !!token, secretConfigured: !!key
    }
  });

  if (!key) {
    if (mode === 'production') return { ok: false, status: 503, error: '服务未配置 EZPLM_JWT_SECRET：生产环境拒绝未鉴权访问' };
    return devAnonymous();
  }
  if (!token) {
    if (mode === 'dev') return devAnonymous();
    return { ok: false, status: 401, error: '缺少 ezPLM/eeHub 会话或有效 Guest Trial 会话' };
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
      authenticated: true,
      authMode: mode, tokenPresent: true, secretConfigured: true,
      channel: String(p.channel || 'ezplm'),
      locale: String(p.locale || 'zh-CN')
    }
  };
}

export const ROLES = ['viewer', 'editor', 'reviewer', 'publisher'];
const IMPLIES = {
  publisher: ['publisher', 'reviewer', 'editor', 'viewer'],
  reviewer: ['reviewer', 'editor', 'viewer'],
  editor: ['editor', 'viewer'],
  viewer: ['viewer']
};

function normalizeRoles(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out = new Set();
  for (const r of list) {
    const k = String(r).trim().toLowerCase();
    for (const implied of IMPLIES[k] || []) out.add(implied);
  }
  if (!out.size) out.add('viewer');
  return [...out];
}

export function hasRole(session, role) {
  return Array.isArray(session?.roles) && session.roles.includes(role);
}

/**
 * Job access: same tenant + owner or elevated reviewer.
 * Guest users may edit only their own draft job; they are never treated as reviewer/publisher.
 */
export function authorizeJobAccess(session, job, { requireRole } = {}) {
  if (!session?.authenticated && !session?.devMode && !session?.guest) {
    return { ok: false, status: 401, error: '需要已认证会话或有效 Guest Trial 会话' };
  }
  if (job.tenantId !== session.tenantId) return { ok: false, status: 403, error: '作业不属于当前租户', code: 'tenant_mismatch' };
  const isOwner = job.ownerId === session.sub;
  const elevated = hasRole(session, 'reviewer') || hasRole(session, 'publisher');
  if (!isOwner && !elevated) {
    return { ok: false, status: 403, error: '无权访问他人作业（需要本人或 reviewer/publisher 角色）', code: 'not_job_owner' };
  }
  if (requireRole && !hasRole(session, requireRole)) {
    // Guest Trial may make review-like edits to its own draft, but cannot publish or produce a verified approval.
    if (session.guest && isOwner && requireRole === 'reviewer') return { ok: true, guestDraftEdit: true };
    return { ok: false, status: 403, error: `缺少 ${requireRole} 权限`, code: 'insufficient_role' };
  }
  return { ok: true };
}

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
