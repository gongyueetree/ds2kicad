// api/generate.js — 生成接口（Node Serverless Function）
// POST { part, pkg, pins } → { files:{kicadSym,legacyLib,kicadMod,wrl}, names, warnings }
// 纯确定性引擎，无任何 AI 参与；同一套 lib/kicadgen 未来可被 ezPLM 服务端直接复用。
import { generateAll, generateBundle } from '../lib/kicadgen/index.js';
import { setCors, checkAuth } from './extract.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method !== 'OPTIONS' && !checkAuth(req)) return res.status(401).json({ error: '未授权（需要 Bearer API_TOKEN）' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body && typeof req.body === 'object'
    ? req.body
    : (() => { try { return JSON.parse(req.body); } catch { return null; } })();
  if (!body) return res.status(400).json({ error: '请求体不是有效 JSON' });

  try {
    // 新形状 { part, items:[{pkg,pins}] } → 多封装批量；旧形状 { part, pkg, pins } → 单封装
    // 旧形状经 generateAll 转换后同样走 generateBundle + PromotionGate，无绕过路径
    const result = Array.isArray(body.items) ? generateBundle(body) : generateAll(body);
    // 防御：闸门结论必须存在，缺失视为不可晋升（fail-safe）
    if (typeof result.nonPromotable !== 'boolean') { result.nonPromotable = true; result.reasons = ['gate_missing']; }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }
}
