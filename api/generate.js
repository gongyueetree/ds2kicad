// api/generate.js — 生成接口（Node Serverless Function）
// POST { part, pkg, pins } → { files:{kicadSym,legacyLib,kicadMod,wrl}, names, warnings }
// 纯确定性引擎，无任何 AI 参与；同一套 lib/kicadgen 未来可被 ezPLM 服务端直接复用。
import { generateAll } from '../lib/kicadgen/index.js';
import { setCors } from './extract.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body && typeof req.body === 'object'
    ? req.body
    : (() => { try { return JSON.parse(req.body); } catch { return null; } })();
  if (!body) return res.status(400).json({ error: '请求体不是有效 JSON' });

  try {
    const result = generateAll(body);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(422).json({ error: e.message });
  }
}
