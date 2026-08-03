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
  if (payload.exp && Date.now() / 1000 > payload.exp) return { ok: false, error: 'JWT 已过期' };
  return { ok: true, payload };
}

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
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

  if (!key) {
    if (mode === 'production') {
      return { ok: false, status: 503, error: '服务未配置 EZPLM_JWT_SECRET：生产环境拒绝未鉴权访问' };
    }
    // 开发模式：匿名身份，且下游据此标记不可晋升
    return { ok: true, session: { sub: 'dev-anonymous', name: '开发匿名用户', tenantId: 'dev', authenticated: false } };
  }
  if (!token) return { ok: false, status: 401, error: '缺少 ezPLM 会话（Cookie ezplm_session 或 Authorization: Bearer）' };
  const v = verifyJwtHs256(token, key);
  if (!v.ok) return { ok: false, status: 401, error: `会话校验失败：${v.error}` };
  const p = v.payload;
  if (!p.sub) return { ok: false, status: 401, error: '会话缺少 sub' };
  return {
    ok: true,
    session: {
      sub: String(p.sub),
      name: String(p.name || p.preferred_username || p.sub),
      tenantId: String(p.tenantId || p.tid || 'default'),
      authenticated: true
    }
  };
}

/** 测试/本地联调用：签发一个 ezPLM 风格会话 JWT */
export function issueDevSession({ sub, name, tenantId, ttlSec = 3600 }, key) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ sub, name, tenantId, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = b64u(createHmac('sha256', key).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
