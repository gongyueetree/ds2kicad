import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const GUEST_COOKIE = 'ds2k_guest';
const GUEST_TTL_SEC = Number(process.env.GUEST_SESSION_TTL_SEC || 30 * 24 * 60 * 60);
const HANDOFF_TTL_SEC = Number(process.env.HANDOFF_TOKEN_TTL_SEC || 10 * 60);
const CHANNELS = new Set(['eetree', 'tindie', 'ezplm', 'eehub', 'direct']);

const b64u = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const fromB64uJson = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export function normalizeChannel(value) {
  const v = String(value || '').trim().toLowerCase();
  return CHANNELS.has(v) ? v : 'direct';
}

export function normalizeLocale(value, channel = 'direct') {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('zh')) return 'zh-CN';
  if (v.startsWith('en')) return 'en-US';
  return ['eetree', 'ezplm'].includes(normalizeChannel(channel)) ? 'zh-CN' : 'en-US';
}

export function getGuestSecret() {
  const secret = process.env.GUEST_SESSION_SECRET || process.env.ASSET_TOKEN_SECRET || process.env.PDF_TOKEN_SECRET;
  if (secret) return secret;
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production' || !!process.env.VERCEL;
  return isProd ? null : 'ds2kicad-dev-guest-secret-change-me';
}

export function getHandoffSecret() {
  return process.env.HANDOFF_TOKEN_SECRET || getGuestSecret();
}

export function readCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return null;
  for (const part of raw.split(';')) {
    const seg = part.trim();
    const eq = seg.indexOf('=');
    if (eq <= 0 || seg.slice(0, eq) !== name) continue;
    const val = seg.slice(eq + 1);
    if (!val || val.length > 4096) return null;
    try { return decodeURIComponent(val); } catch { return val; }
  }
  return null;
}

function signPayload(kind, payload, secret) {
  if (!secret) throw new Error(`${kind} secret 未配置`);
  const body = b64u({ ...payload, typ: kind });
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `v1.${body}.${sig}`;
}

function verifyPayload(token, kind, secret) {
  if (!secret || typeof token !== 'string') return { ok: false, error: 'token/secret missing' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, error: 'token format invalid' };
  const [, body, sig] = parts;
  const expect = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const got = Buffer.from(sig);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return { ok: false, error: 'token signature invalid' };
  let payload;
  try { payload = fromB64uJson(body); } catch { return { ok: false, error: 'token payload invalid' }; }
  if (payload.typ !== kind) return { ok: false, error: 'token type mismatch' };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(payload.exp) || payload.exp < now) return { ok: false, error: 'token expired' };
  return { ok: true, payload };
}

export function issueGuestSession({ channel = 'direct', locale, sid = randomUUID() } = {}) {
  const ch = normalizeChannel(channel);
  const loc = normalizeLocale(locale, ch);
  const now = Math.floor(Date.now() / 1000);
  const payload = { sid, channel: ch, locale: loc, iat: now, exp: now + GUEST_TTL_SEC };
  const token = signPayload('guest', payload, getGuestSecret());
  return { token, payload };
}

export function verifyGuestSession(token) {
  const v = verifyPayload(token, 'guest', getGuestSecret());
  if (!v.ok) return v;
  const p = v.payload;
  if (!p.sid || typeof p.sid !== 'string') return { ok: false, error: 'guest sid missing' };
  p.channel = normalizeChannel(p.channel);
  p.locale = normalizeLocale(p.locale, p.channel);
  return { ok: true, payload: p };
}

export function guestCookieHeader(token, req) {
  const secure = !!process.env.VERCEL || process.env.NODE_ENV === 'production' || req?.headers?.['x-forwarded-proto'] === 'https';
  return [
    `${GUEST_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${GUEST_TTL_SEC}`,
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

export function guestSessionFromRequest(req) {
  if (process.env.ALLOW_GUEST_TRIAL === '0') return null;
  // Header fallback is required for third-party iframe contexts where browsers may block cookies.
  // The token carries guest identity only; it grants no publish/reviewer privilege and is quota-gated.
  const headerToken = req?.headers?.['x-guest-session'];
  const token = (typeof headerToken === 'string' && headerToken) ? headerToken : readCookie(req, GUEST_COOKIE);
  if (!token) return null;
  const v = verifyGuestSession(token);
  if (!v.ok) return null;
  const p = v.payload;
  return {
    sub: `guest:${p.sid}`,
    name: 'Guest',
    tenantId: 'guest',
    roles: ['viewer', 'editor'],
    authenticated: false,
    guest: true,
    guestId: p.sid,
    channel: p.channel,
    locale: p.locale,
    authMode: 'guest',
    tokenPresent: true,
    secretConfigured: !!getGuestSecret()
  };
}

export function signupTarget({ channel, locale } = {}) {
  const ch = normalizeChannel(channel);
  const loc = normalizeLocale(locale, ch);
  const chinese = ch === 'eetree' || ch === 'ezplm' || loc === 'zh-CN';
  return chinese
    ? (process.env.EZPLM_SIGNUP_URL || 'https://www.ezplm.cn/')
    : (process.env.EEHUB_SIGNUP_URL || 'https://www.eehub.io/');
}

export function issueHandoff({ guestId, channel = 'direct', locale, returnTo = '', jobId = null } = {}) {
  if (!guestId) throw new Error('guestId required');
  const ch = normalizeChannel(channel);
  const loc = normalizeLocale(locale, ch);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    guestId,
    channel: ch,
    locale: loc,
    returnTo: String(returnTo || '').slice(0, 1200),
    ...(jobId ? { jobId: String(jobId) } : {}),
    iat: now,
    exp: now + HANDOFF_TTL_SEC,
    nonce: randomUUID()
  };
  return signPayload('handoff', payload, getHandoffSecret());
}

export function verifyHandoff(token) {
  return verifyPayload(token, 'handoff', getHandoffSecret());
}
