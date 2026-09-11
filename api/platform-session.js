import { authenticate } from '../lib/auth.js';
import {
  GUEST_COOKIE,
  guestCookieHeader,
  issueGuestSession,
  normalizeChannel,
  normalizeLocale,
  readCookie,
  signupTarget,
  verifyGuestSession
} from '../lib/platform-session.js';
import { getWallet, OPERATION_COSTS } from '../lib/credits.js';
import { setCors } from './extract.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET/POST only' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestedChannel = normalizeChannel(body.channel || req.query?.channel || 'direct');
  const requestedLocale = normalizeLocale(body.locale || req.query?.locale, requestedChannel);

  const auth = authenticate(req);
  let issued = false;
  let session;
  let guestToken = null;

  if (auth.ok) {
    session = auth.session;
    if (session.guest) {
      guestToken = (typeof req.headers?.['x-guest-session'] === 'string' && req.headers['x-guest-session'])
        || readCookie(req, GUEST_COOKIE);
    }
  } else {
    if (process.env.ALLOW_GUEST_TRIAL === '0') {
      return res.status(auth.status || 401).json({ error: auth.error || 'Guest Trial 已关闭', code: 'guest_disabled' });
    }
    const presentedToken = (typeof req.headers?.['x-guest-session'] === 'string' && req.headers['x-guest-session'])
      || readCookie(req, GUEST_COOKIE);
    const existing = presentedToken ? verifyGuestSession(presentedToken) : null;
    const guest = issueGuestSession({
      sid: existing?.ok ? existing.payload.sid : undefined,
      channel: existing?.ok ? existing.payload.channel : requestedChannel,
      locale: existing?.ok ? existing.payload.locale : requestedLocale
    });
    guestToken = guest.token;
    res.setHeader('Set-Cookie', guestCookieHeader(guest.token, req));
    issued = true;
    session = {
      sub: `guest:${guest.payload.sid}`,
      name: 'Guest',
      tenantId: 'guest',
      roles: ['viewer', 'editor'],
      authenticated: false,
      guest: true,
      guestId: guest.payload.sid,
      channel: guest.payload.channel,
      locale: guest.payload.locale,
      authMode: 'guest',
      tokenPresent: true,
      secretConfigured: true
    };
  }

  const wallet = await getWallet(session);
  const channel = normalizeChannel(session.channel || requestedChannel);
  const locale = normalizeLocale(session.locale || requestedLocale, channel);
  return res.status(200).json({
    ok: true,
    issuedGuest: issued,
    sessionType: session.guest ? 'guest' : session.authenticated ? 'registered' : 'dev',
    authenticated: session.authenticated === true,
    guest: session.guest === true,
    ...(session.guest && guestToken ? { guestToken } : {}),
    channel,
    locale,
    displayName: session.name || null,
    wallet,
    operationCosts: OPERATION_COSTS,
    signupUrl: signupTarget({ channel, locale })
  });
}
