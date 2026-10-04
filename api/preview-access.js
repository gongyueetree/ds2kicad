import { createHash, timingSafeEqual } from 'node:crypto';
import { authenticate, issueDevSession } from '../lib/auth.js';

const digest = value => createHash('sha256').update(value).digest();
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expiry = Date.parse(process.env.PREVIEW_ACCESS_EXPIRES_AT || '');
  const enabled = process.env.VERCEL_ENV === 'preview' && process.env.OBJECT_STORE_MODE === 'preview-postgres'
    && (process.env.PREVIEW_ACCESS_CODE || '').length >= 24 && Number.isFinite(expiry) && expiry > Date.now();
  if (req.method === 'GET') {
    const auth = enabled ? authenticate(req) : null;
    return res.status(200).json({ enabled: !!enabled, authenticated: !!(auth?.ok && auth.session.authenticated), expiresAt: enabled ? expiry : null });
  }
  if (!enabled) return res.status(404).json({ error: '测试登录入口未启用或已到期' });
  if (req.method !== 'POST') return res.status(405).json({ error: '仅支持 GET / POST' });
  // Same-origin JSON POST only; no code/token in URLs, referrers or response bodies.
  const host = req.headers.host;
  if (req.headers.origin && req.headers.origin !== `https://${host}` && !(process.env.NODE_ENV !== 'production' && req.headers.origin === `http://${host}`)) return res.status(403).json({ error: '来源不匹配' });
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: '需要 JSON 请求' });
  const code = req.body?.code;
  if (typeof code !== 'string' || code.length > 256 || !timingSafeEqual(digest(code), digest(process.env.PREVIEW_ACCESS_CODE))) return res.status(401).json({ error: '测试访问码不正确' });
  if (!process.env.EZPLM_JWT_SECRET || !process.env.EZPLM_JWT_ISS || !process.env.EZPLM_JWT_AUD || !/^[a-zA-Z0-9_-]{1,80}$/.test(process.env.PREVIEW_STORAGE_NAMESPACE || '')) return res.status(503).json({ error: '测试会话配置未完成' });
  const ttlSec = Math.min(86400, Math.floor((expiry - Date.now()) / 1000));
  const token = issueDevSession({ sub: 'preview-tester', name: '测试复核员', tenantId: `preview-${process.env.PREVIEW_STORAGE_NAMESPACE}`, roles: ['publisher'], iss: process.env.EZPLM_JWT_ISS, aud: process.env.EZPLM_JWT_AUD, ttlSec }, process.env.EZPLM_JWT_SECRET);
  res.setHeader('Set-Cookie', `ezplm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSec}`);
  return res.status(200).json({ ok: true });
}
