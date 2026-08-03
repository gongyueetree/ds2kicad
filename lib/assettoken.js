// lib/assettoken.js — v0.8.5 item 9：与 tenant/job/revision 绑定的短期资产下载令牌。
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || !!process.env.VERCEL;
if (IS_PROD && !process.env.ASSET_TOKEN_SECRET && !process.env.PDF_TOKEN_SECRET) {
  throw new Error('[DS2KiCad] 生产环境必须配置 ASSET_TOKEN_SECRET（或复用 PDF_TOKEN_SECRET）');
}
const SECRET = () => process.env.ASSET_TOKEN_SECRET || process.env.PDF_TOKEN_SECRET || FALLBACK;
const FALLBACK = randomBytes(32).toString('hex');
const TTL_MS = 15 * 60 * 1000;

const mac = (payload) => createHmac('sha256', SECRET()).update(payload).digest('base64url');

export function signAssetToken({ tenantId, jobId, revision, sub, ttlMs = TTL_MS }) {
  const exp = Date.now() + ttlMs;
  const payload = [tenantId, jobId, String(revision), sub, String(exp)].join('|');
  return `${Buffer.from(payload).toString('base64url')}.${mac(payload)}`;
}

export function verifyAssetToken(token, { tenantId, jobId, revision } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, error: '令牌格式非法' };
  const i = token.lastIndexOf('.');
  const payload = Buffer.from(token.slice(0, i), 'base64url').toString();
  const sig = token.slice(i + 1);
  const expect = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, error: '签名不匹配' };
  const [t, j, r, sub, exp] = payload.split('|');
  if (Date.now() > Number(exp)) return { ok: false, error: '令牌已过期' };
  if (tenantId !== undefined && t !== tenantId) return { ok: false, error: 'tenant 不匹配' };
  if (jobId !== undefined && j !== jobId) return { ok: false, error: 'job 不匹配' };
  if (revision !== undefined && String(revision) !== r) return { ok: false, error: 'revision 不匹配' };
  return { ok: true, tenantId: t, jobId: j, revision: Number(r), sub };
}
