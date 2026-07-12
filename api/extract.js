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

  // ── 阶段 1：确定性程序化解析（零 AI 成本）──────────────────────────────
  // AI 只在程序化拿不到时按需介入；每个字段带来源溯源（parser / gemini）。
  let det = { textOk: false, part: null, pins: [], pinConfidence: 'low', figures: [], relevantPages: [] };
  if (process.env.DETERMINISTIC_FIRST !== '0') {
    try {
      const { extractTextPages } = await import('../lib/pdftext.js');
      const { findPartInfo, parsePinTable, findFigures, selectRelevantPages } = await import('../lib/heuristics.js');
      const { pages } = await extractTextPages(pdfBuf);
      const totalText = pages.reduce((n, p) => n + p.lines.length, 0);
      if (totalText > 20) { // 有文本层（非纯扫描版）
        const pi = findPartInfo(pages, v.url);
        const pt = parsePinTable(pages);
        const figs = findFigures(pages);
        det = {
          textOk: true,
          part: pi.ok ? pi.part : null,
          pins: pt.pins,
          pinConfidence: pt.confidence,
          figures: figs,
          relevantPages: selectRelevantPages(pages, figs)
        };
      }
    } catch (e) {
      console.error('程序化解析失败，回退全量 AI:', e.message);
    }
  }

  // ── 阶段 2：按需 Gemini（封装机械尺寸通常必须 AI 读图；其余能省则省）────
  const need = {
    part: !det.part,
    packages: true,
    pins: det.pinConfidence !== 'high',
    figures: det.figures.length === 0
  };

  try {
    // 相关页切片：只喂首页+管脚页+机械图页+图区页，token/时延双降；失败回退整本
    let geminiBuf = pdfBuf, sliced = false;
    if (det.relevantPages.length) {
      const { slicePdf } = await import('../lib/pdfslice.js');
      const s = await slicePdf(pdfBuf, det.relevantPages);
      if (s) { geminiBuf = s.buf; sliced = true; }
    }
    const raw = await extractWithGemini({
      pdfBase64: geminiBuf.toString('base64'),
      apiKey,
      model: process.env.GEMINI_MODEL,
      sourceUrl: v.url,
      need,
      hints: {
        mpn: det.part?.mpn,
        pinCount: need.pins ? undefined : det.pins.length,
        note: sliced ? 'The attached PDF contains only the relevant pages (first page, pin table, mechanical drawings) sliced from the full datasheet.' : undefined
      }
    });

    const packages = (Array.isArray(raw?.packages) ? raw.packages : [])
      .map((p) => ({ ...sanitizePackage(p), family: guessFamily(p?.type || p?.name) }));
    if (!packages.length) packages.push(sanitizePackage({}));
    const idx = Math.min(Math.max(0, Math.round(Number(raw?.recommendedPackageIndex) || 0)), packages.length - 1);

    const part = need.part
      ? {
          mpn: String(raw?.part?.mpn || '').trim() || det.part?.mpn || 'UNKNOWN',
          manufacturer: String(raw?.part?.manufacturer || '').trim(),
          title: String(raw?.part?.title || '').trim(),
          description_zh: String(raw?.part?.description_zh || '').trim()
        }
      : det.part;
    const pins = need.pins ? sanitizePins(raw?.pins) : sanitizePins(det.pins);
    const figures = need.figures ? sanitizeFigures(raw?.figures) : sanitizeFigures(det.figures);

    return res.status(200).json({
      mock: false,
      part,
      packages,
      recommendedPackageIndex: idx,
      pins,
      figures,
      sources: {
        part: need.part ? 'gemini' : 'parser',
        packages: 'gemini',
        pins: need.pins ? 'gemini' : 'parser',
        figures: need.figures ? 'gemini' : 'parser'
      },
      meta: {
        mode: 'live',
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        pdfUrl: v.url,
        pdfBytes: pdfBuf.length,
        strategy: det.textOk ? (need.pins ? 'hybrid' : 'parser-first') : 'gemini-full',
        pinConfidence: det.pinConfidence
      }
    });
  } catch (e) {
    // Gemini 整体失败：若程序化已拿到管脚高置信结果，降级返回（封装参数留给用户手填）
    if (det.pinConfidence === 'high') {
      return res.status(200).json({
        mock: false,
        part: det.part || { mpn: 'UNKNOWN', manufacturer: '', title: '', description_zh: '' },
        packages: [sanitizePackage({ pinCount: det.pins.length })],
        recommendedPackageIndex: 0,
        pins: sanitizePins(det.pins),
        figures: sanitizeFigures(det.figures),
        sources: { part: 'parser', packages: 'fallback', pins: 'parser', figures: 'parser' },
        meta: { mode: 'degraded', warning: `AI 不可用（${e.message}），封装尺寸为默认值，请手工核对`, pdfUrl: v.url, pdfBytes: pdfBuf.length }
      });
    }
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
