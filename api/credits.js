import { authenticate } from '../lib/auth.js';
import { getWallet, topupCredits, OPERATION_COSTS } from '../lib/credits.js';
import { setCors } from './extract.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const session = auth.session;

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, wallet: await getWallet(session), operationCosts: OPERATION_COSTS });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET/POST only' });

  const configured = process.env.CREDIT_ADMIN_SECRET;
  const supplied = req.headers?.['x-credit-admin-secret'];
  if (!configured || supplied !== configured) return res.status(403).json({ error: '充值接口仅供受信任后台调用', code: 'admin_required' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const wallet = await topupCredits(session, body.amount, { reason: String(body.reason || 'admin topup').slice(0, 200) });
  return res.status(200).json({ ok: true, wallet });
}
