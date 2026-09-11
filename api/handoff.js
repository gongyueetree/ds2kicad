import { authenticate } from '../lib/auth.js';
import { issueHandoff, signupTarget } from '../lib/platform-session.js';
import { setCors } from './extract.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const session = auth.session;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const target = signupTarget({ channel: session.channel, locale: session.locale });

  if (!session.guest) {
    return res.status(200).json({ ok: true, authenticated: true, url: target });
  }

  const token = issueHandoff({
    guestId: session.guestId,
    channel: session.channel,
    locale: session.locale,
    returnTo: body.returnTo || '',
    jobId: body.jobId || null
  });
  const u = new URL(target);
  u.searchParams.set('handoff', token);
  u.searchParams.set('source', session.channel || 'direct');
  return res.status(200).json({ ok: true, authenticated: false, handoff: token, url: u.toString() });
}
