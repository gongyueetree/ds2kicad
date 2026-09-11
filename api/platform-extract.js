// Public/multi-channel wrapper around the existing extraction handler.
// One successful Datasheet→KiCad conversion consumes one Credit. Failed runs are refunded.
import extractHandler, { setCors } from './extract.js';
import { authenticate } from '../lib/auth.js';
import { reserveCredit, commitCredit, refundCredit } from '../lib/credits.js';
import { signupTarget } from '../lib/platform-session.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Explicit mock is free so developers can test the complete UX without consuming quota.
  if (process.env.MOCK_MODE === '1') return extractHandler(req, res);

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const session = auth.session;
  const reservation = await reserveCredit(session, 'datasheet_to_kicad', {
    refKey: req.headers?.['idempotency-key'] || null,
    metadata: { channel: session.channel || 'direct' }
  });

  if (!reservation.ok) {
    return res.status(402).json({
      error: session.guest
        ? '免费体验次数已用完。注册 ezPLM / eeHub 后可保存个人库并继续使用。'
        : 'Credit 余额不足，请充值后继续生成。',
      code: 'credits_exhausted',
      wallet: reservation.wallet,
      requiredCredits: reservation.cost,
      signupUrl: signupTarget({ channel: session.channel, locale: session.locale })
    });
  }

  let thrown = null;
  try {
    await extractHandler(req, res);
  } catch (e) {
    thrown = e;
  }

  try {
    if (!thrown && res.statusCode >= 200 && res.statusCode < 300) await commitCredit(reservation.reservationId);
    else await refundCredit(reservation.reservationId);
  } catch (billingError) {
    console.error('[platform-extract] billing finalization failed', billingError);
  }

  if (thrown) throw thrown;
}
