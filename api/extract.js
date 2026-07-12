// api/extract.js — 提取接口（Node Serverless Function）
// POST { pdfUrl } → { mock, part, packages, recommendedPackageIndex, pins, figures, meta }
// 三态外部依赖开关（.env 控制，与 AltPart AI 同款模式）：
//   GEMINI_API_KEY 未配置或 MOCK_MODE=1 → 返回内置 TMUXL27518 演示数据（mock:true）
import { validatePdfUrl, sanitizePins, sanitizePackage, sanitizeFigures, guessFamily } from '../lib/validate.js';
import { extractWithGemini } from '../lib/gemini.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  const pdfUrl = body?.pdfUrl;
  const v = validatePdfUrl(pdfUrl);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const apiKey = process.env.GEMINI_API_KEY;
  const mockMode = process.env.MOCK_MODE === '1' || !apiKey;
  if (mockMode) {
    return res.status(200).json({
      ...MOCK_TMUXL27518,
      packages: MOCK_TMUXL27518.packages.map((p) => ({ ...p, family: guessFamily(p.type) })),
      meta: { mode: 'mock', reason: apiKey ? 'MOCK_MODE=1' : 'GEMINI_API_KEY 未配置', pdfUrl: v.url }
    });
  }

  // 服务端下载 PDF（尺寸上限保护）
  const maxBytes = Number(process.env.MAX_PDF_MB || 15) * 1024 * 1024;
  let pdfBuf;
  try {
    const r = await fetch(v.url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DS2KiCad/0.1)', 'Accept': 'application/pdf,*/*' }
    });
    if (!r.ok) return res.status(502).json({ error: `数据手册下载失败（上游 ${r.status}）` });
    const ab = await r.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      return res.status(413).json({ error: `PDF 超过 ${maxBytes / 1048576}MB 限制` });
    }
    pdfBuf = Buffer.from(ab);
    if (pdfBuf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(422).json({ error: '该 URL 返回的不是 PDF 文件' });
    }
  } catch (e) {
    return res.status(502).json({ error: `数据手册下载失败: ${e.message}` });
  }

  try {
    const raw = await extractWithGemini({
      pdfBase64: pdfBuf.toString('base64'),
      apiKey,
      model: process.env.GEMINI_MODEL,
      sourceUrl: v.url
    });
    const packages = (Array.isArray(raw?.packages) ? raw.packages : [])
      .map((p) => ({ ...sanitizePackage(p), family: guessFamily(p?.type || p?.name) }));
    if (!packages.length) packages.push(sanitizePackage({}));
    const idx = Math.min(Math.max(0, Math.round(Number(raw?.recommendedPackageIndex) || 0)), packages.length - 1);
    return res.status(200).json({
      mock: false,
      part: {
        mpn: String(raw?.part?.mpn || '').trim() || 'UNKNOWN',
        manufacturer: String(raw?.part?.manufacturer || '').trim(),
        title: String(raw?.part?.title || '').trim(),
        description_zh: String(raw?.part?.description_zh || '').trim()
      },
      packages,
      recommendedPackageIndex: idx,
      pins: sanitizePins(raw?.pins),
      figures: sanitizeFigures(raw?.figures),
      meta: { mode: 'live', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', pdfUrl: v.url, pdfBytes: pdfBuf.length }
    });
  } catch (e) {
    return res.status(502).json({ error: `AI 提取失败: ${e.message}` });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function setCors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req?.headers?.origin || '';
  let allow = '';
  if (allowed.length) {
    if (allowed.includes(origin) || allowed.includes('*')) allow = allowed.includes('*') ? '*' : origin;
  } else if (/^https?:\/\/([a-z0-9-]+\.)*(ezplm\.cn|eetree\.cn)(:\d+)?$/i.test(origin)) {
    allow = origin; // 默认白名单：ezPLM / eetree 子域，便于 iframe 集成
  }
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
