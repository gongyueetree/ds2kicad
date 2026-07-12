// api/extract.js — 提取接口（Node Serverless Function）
// POST { pdfUrl } 或 { pdfBase64, fileName } → { mock, part, packages, recommendedPackageIndex, pins, figures, meta }
// 上传通道受 Vercel 请求体 4.5MB 限制：原始 PDF ≤3MB（base64 膨胀 ~37%）
// 三态外部依赖开关（.env 控制，与 AltPart AI 同款模式）：
//   GEMINI_API_KEY 未配置或 MOCK_MODE=1 → 返回内置 TMUXL27518 演示数据（mock:true）
import { validatePdfUrl, sanitizePins, sanitizePinsets, sanitizePackage, sanitizeFigures, guessFamily } from '../lib/validate.js';
import { extractWithGemini } from '../lib/gemini.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

export default async function handler(req, res) {
  const t0 = Date.now();
  const budgetMs = Number(process.env.EXTRACT_BUDGET_MS || 50000); // 平台 60s 上限内主动收口
  const remain = () => budgetMs - (Date.now() - t0);
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  const uploaded = typeof body?.pdfBase64 === 'string' && body.pdfBase64.length > 0;
  let v;
  let uploadedBuf = null;
  if (uploaded) {
    const fileName = String(body.fileName || 'uploaded.pdf').slice(0, 120);
    v = { ok: true, url: `local:${fileName}`, fileName };
    // 上传内容前置校验（mock 模式同样生效）：base64 → 3MB 上限 → PDF 魔数
    try {
      uploadedBuf = Buffer.from(body.pdfBase64, 'base64');
    } catch {
      return res.status(400).json({ error: '上传数据不是有效的 base64' });
    }
    if (uploadedBuf.length > 3.2 * 1024 * 1024) {
      return res.status(413).json({ error: '上传 PDF 超过 3MB（平台请求体限制），更大的文件请改用 URL 方式' });
    }
    if (uploadedBuf.slice(0, 5).toString() !== '%PDF-') {
      return res.status(422).json({ error: '上传内容不是 PDF 文件' });
    }
  } else {
    v = validatePdfUrl(body?.pdfUrl);
    if (!v.ok) return res.status(400).json({ error: v.error });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const mockMode = process.env.MOCK_MODE === '1' || !apiKey;
  if (mockMode) {
    return res.status(200).json({
      ...MOCK_TMUXL27518,
      packages: MOCK_TMUXL27518.packages.map((p) => ({ ...p, family: guessFamily(p.type) })),
      meta: { mode: 'mock', reason: apiKey ? 'MOCK_MODE=1' : 'GEMINI_API_KEY 未配置', pdfUrl: v.url }
    });
  }

  // 获取 PDF：上传通道用前置校验过的缓冲；URL 通道服务端下载（尺寸上限保护）
  const maxBytes = Number(process.env.MAX_PDF_MB || 15) * 1024 * 1024;
  let pdfBuf;
  if (uploaded) {
    pdfBuf = uploadedBuf;
  } else try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000); // 下载上限 15s
    const r = await fetch(v.url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DS2KiCad/0.1)', 'Accept': 'application/pdf,*/*' }
    }).finally(() => clearTimeout(timer));
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
    const cnTip = /ti\.com\.cn/.test(v.url) ? '；ti.com.cn 从海外节点访问较慢，建议改用 www.ti.com 全球域名链接' : '';
    const msg = e.name === 'AbortError' ? `数据手册下载超时（>15s）${cnTip}` : `数据手册下载失败: ${e.message}${cnTip}`;
    return res.status(502).json({ error: msg });
  }

  // ── 阶段 1：确定性程序化解析（零 AI 成本）──────────────────────────────
  // AI 只在程序化拿不到时按需介入；每个字段带来源溯源（parser / gemini）。
  let det = { textOk: false, part: null, pins: [], pinsets: [], pinConfidence: 'low', figures: [], relevantPages: [], assignPinsets: null };
  if (process.env.DETERMINISTIC_FIRST !== '0') {
    try {
      const { extractTextPages } = await import('../lib/pdftext.js');
      const { findPartInfo, parsePinTable, findFigures, selectRelevantPages, assignPinsets } = await import('../lib/heuristics.js');
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
          pinsets: pt.pinsets,
          pinConfidence: pt.confidence,
          figures: figs,
          relevantPages: selectRelevantPages(pages, figs),
          assignPinsets
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
    {
      const { slicePdf, pageCountOf } = await import('../lib/pdfslice.js');
      let pagesToUse = det.relevantPages;
      if (!pagesToUse.length) {
        // 程序化未能定位相关页（扫描版/图形化排版）：确定性兜底切片 = 首 6 页 + 末 8 页（机械图惯例在书末）
        const total = await pageCountOf(pdfBuf);
        if (total && total > 16) {
          pagesToUse = [
            ...Array.from({ length: 6 }, (_, i) => i + 1),
            ...Array.from({ length: 8 }, (_, i) => total - 7 + i)
          ];
        }
      }
      if (pagesToUse.length) {
        const s = await slicePdf(pdfBuf, pagesToUse);
        if (s) { geminiBuf = s.buf; sliced = true; }
      }
    }
    const raw = await extractWithGemini({
      pdfBase64: geminiBuf.toString('base64'),
      apiKey,
      model: process.env.GEMINI_MODEL,
      sourceUrl: v.url,
      need,
      deadlineMs: Math.max(10000, remain() - 3000),
      hints: {
        mpn: det.part?.mpn,
        pinCount: need.pins ? undefined : det.pins.length,
        note: sliced ? 'The attached PDF contains only the relevant pages (first page, pin table, mechanical drawings) sliced from the full datasheet.' : undefined
      }
    });

    let packages = (Array.isArray(raw?.packages) ? raw.packages : [])
      .map((p) => ({ ...sanitizePackage(p), family: guessFamily(p?.type || p?.name) }));
    if (!packages.length) packages.push(sanitizePackage({}));
    const idx = Math.min(Math.max(0, Math.round(Number(raw?.recommendedPackageIndex) || 0)), packages.length - 1);

    // pinsets：程序化高置信用解析结果（并按列头标签归属封装）；否则用 Gemini 的 pinsets（pinsetId 由 AI 标注）
    let pinsets;
    if (!need.pins) {
      pinsets = sanitizePinsets(det.pinsets, det.pins);
      if (det.assignPinsets) packages = det.assignPinsets(packages, pinsets);
    } else {
      pinsets = sanitizePinsets(raw?.pinsets, raw?.pins);
      const valid = new Set(pinsets.map((s2) => s2.id));
      packages = packages.map((p) => valid.has(p.pinsetId) ? p : { ...p, pinsetId: pinsets[0]?.id || 'default' });
    }

    const part = need.part
      ? {
          mpn: String(raw?.part?.mpn || '').trim() || det.part?.mpn || 'UNKNOWN',
          manufacturer: String(raw?.part?.manufacturer || '').trim(),
          title: String(raw?.part?.title || '').trim(),
          description_zh: String(raw?.part?.description_zh || '').trim()
        }
      : det.part;
    const recSet = pinsets.find((s2) => s2.id === packages[idx].pinsetId) || pinsets[0];
    const pins = recSet ? recSet.pins : [];
    const { filterFigures } = await import('../lib/figfilter.js');
    const figures = filterFigures(
      need.figures ? sanitizeFigures(raw?.figures) : sanitizeFigures(det.figures),
      { pkgCount: packages.length }
    );

    return res.status(200).json({
      mock: false,
      part,
      packages,
      recommendedPackageIndex: idx,
      pins,
      pinsets,
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
        pinsets: sanitizePinsets(det.pinsets, det.pins),
        figures: (await import('../lib/figfilter.js')).filterFigures(sanitizeFigures(det.figures), { pkgCount: 1 }),
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
