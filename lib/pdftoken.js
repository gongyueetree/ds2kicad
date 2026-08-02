// lib/pdftoken.js — 短期签名令牌（HMAC）。绑定具体 URL + 过期时间，
// 防止 /api/fetch-pdf 被当作开放代理使用。密钥来自 PDF_TOKEN_SECRET（未配置时用进程级随机值，
// 意味着重启后旧令牌失效——对本用途可接受）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.PDF_TOKEN_SECRET || randomBytes(32).toString('hex');
const TTL_MS = 15 * 60 * 1000;

const sign = (url, exp) => createHmac('sha256', SECRET).update(`${url}|${exp}`).digest('base64url');

export function signPdfToken(url, ttlMs = TTL_MS) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(url, exp)}`;
}

export function verifyPdfToken(url, token) {
  if (!token) return { ok: false, error: '缺少 token' };
  const [expStr, mac] = String(token).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || !mac) return { ok: false, error: 'token 格式非法' };
  if (Date.now() > exp) return { ok: false, error: 'token 已过期' };
  const expect = Buffer.from(sign(url, exp));
  const got = Buffer.from(mac);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, error: '签名不匹配' };
  return { ok: true };
}
