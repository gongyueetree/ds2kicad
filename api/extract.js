// api/extract.js — 提取接口（Node Serverless Function）
// POST { pdfUrl } 或 { pdfBase64, fileName } → { mock, part, packages, recommendedPackageIndex, pins, figures, meta }
// 上传通道受 Vercel 请求体 4.5MB 限制：原始 PDF ≤3MB（base64 膨胀 ~37%）
// 三态外部依赖开关（.env 控制，与 AltPart AI 同款模式）：
//   GEMINI_API_KEY 未配置或 MOCK_MODE=1 → 返回内置 TMUXL27518 演示数据（mock:true）
import { validatePdfUrl, sanitizePins, sanitizePinsDetailed, sanitizePinsets, sanitizePackage, sanitizeFigures, guessFamily } from '../lib/validate.js';
import { extractWithGemini } from '../lib/gemini.js';
import { signPdfToken } from '../lib/pdftoken.js';
import { sealJob } from '../lib/jobstore.js';
import { authenticate } from '../lib/auth.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

export default async function handler(req, res) {
  const t0 = Date.now();
  const budgetMs = Number(process.env.EXTRACT_BUDGET_MS || 50000); // 平台 60s 上限内主动收口
  const remain = () => budgetMs - (Date.now() - t0);
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const auth = authenticate(req);          // item 10：ezPLM 会话鉴权，浏览器不持密钥
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;
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
  const mockAllowed = process.env.MOCK_MODE === '1'; // P0-3：mock 必须显式开启，缺 Key 不再静默回退演示数据
  if (!apiKey && !mockAllowed) {
    return res.status(503).json({
      error: '服务未配置：缺少 GEMINI_API_KEY（不再自动回退演示数据）。请在部署环境变量配置 Key，或显式设置 MOCK_MODE=1 用于联调',
      code: 'model_not_configured'
    });
  }
  if (mockAllowed) {
    const mockIr = {
      part: MOCK_TMUXL27518.part,
      packages: MOCK_TMUXL27518.packages,
      pinsets: MOCK_TMUXL27518.pinsets,
      figures: MOCK_TMUXL27518.figures,
      mock: true,                       // 服务端权威，客户端无法删除
      tenantId: session.tenantId,
      pdfUrl: v.url
    };
    const sealed = sealJob(mockIr);
    return res.status(200).json({
      ...MOCK_TMUXL27518,
      jobId: sealed.jobId,
      mock: true,
      non_promotable: true,
      packages: MOCK_TMUXL27518.packages.map((p) => ({ ...p, family: guessFamily(p.type) })),
      pdfToken: uploaded ? null : signPdfToken(v.url), // item 9：mock 响应同样提供 PDF 访问方式
      meta: { mode: 'mock', reason: 'MOCK_MODE=1', pdfUrl: v.url }
    });
  }

  // 获取 PDF：上传通道用前置校验过的缓冲；URL 通道服务端下载（尺寸上限保护）
  const maxBytes = Number(process.env.MAX_PDF_MB || 15) * 1024 * 1024;
  let pdfBuf;
  if (uploaded) {
    pdfBuf = uploadedBuf;
  } else try {
    // P0-4：统一 SafeDownloader（逐跳重定向校验 / DNS 私网拒绝 / 流式字节上限）
    const { safeDownload } = await import('../lib/safedl.js');
    const origin = new URL(v.url).origin;
    const dl = await safeDownload(v.url, {
      maxBytes,
      timeoutMs: 15000,
      headers: {
        // 国产厂商官网（novosns/ti.com.cn 等）常按 UA/Referer 防盗链：请求头浏览器化 + 同源 Referer
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,application/octet-stream,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': origin + '/'
      }
    });
    pdfBuf = dl.buf;
    if (pdfBuf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      // 诊断型报错：报告上游 Content-Type 与页面线索，给出可操作建议
      let clue = '';
      const head = pdfBuf.subarray(0, 4096).toString('utf8');
      if (/html/i.test(dl.contentType) || head.includes('<')) {
        const title = /<title[^>]*>([^<]{0,80})/i.exec(head);
        clue = title ? `，页面标题「${title[1].trim()}」` : '';
        if (/404|not found|不存在/i.test(head)) clue += '（疑似链接失效/404）';
      }
      return res.status(422).json({
        error: `该 URL 返回的不是 PDF（Content-Type: ${dl.contentType || '未知'}${clue}）。建议：① 浏览器打开确认是否直达 PDF ② 找厂商官网真实下载直链（部分 /datasheet/ 路径是网页）③ 下载后用「上传本地 PDF」通道`
      });
    }
  } catch (e) {
    const cnTip = /ti\.com\.cn/.test(v.url) ? '；ti.com.cn 从海外节点访问较慢，建议改用 www.ti.com 全球域名链接' : '';
    return res.status(502).json({ error: `数据手册下载失败: ${e.message}${cnTip}` });
  }

  // ── 阶段 1：确定性程序化解析（零 AI 成本）──────────────────────────────
  // AI 只在程序化拿不到时按需介入；每个字段带来源溯源（parser / gemini）。
  let det = { textOk: false, part: null, pins: [], pinsets: [], pinConfidence: 'low', figures: [], relevantPages: [], assignPinsets: null };
  let docProfile = null; // pdf-inspector 文档画像（TextBased/Scanned/Mixed + 需 OCR 页）
  if (process.env.DETERMINISTIC_FIRST !== '0') {
    try {
      const useInspector = process.env.PDF_PARSER === 'inspector';
      const { extractTextPages } = useInspector
        ? await import('../lib/parsers/pdfInspectorAdapter.js')  // 原生 NAPI，仅 Worker/本地显式开启
        : await import('../lib/pdftext.js');
      if (useInspector) {
        try {
          const { classify } = await import('../lib/parsers/pdfInspectorAdapter.js');
          docProfile = await classify(pdfBuf); // { pdfType, confidence, pagesNeedingOcr }
        } catch (e) {
          docProfile = { pdfType: 'unknown', error: e.message };
        }
      }
      var ocrResult = null; // item 12：OCR 路由结果（含 mustKeepPages）
      const { findPartInfo, parsePinTable, findFigures, selectRelevantPages, assignPinsets } = await import('../lib/heuristics.js');
      const { pages } = await extractTextPages(pdfBuf);
      const totalText = pages.reduce((n, p) => n + p.lines.length, 0);
      if (totalText > 20) { // 有文本层（非纯扫描版）
        const pi = findPartInfo(pages, v.url);
        const pt = parsePinTable(pages);
        const figs = findFigures(pages);
        // item 12：需 OCR 的页面走 OCR Worker；无 Worker 时也绝不丢弃这些页
        if (docProfile?.pagesNeedingOcr?.length) {
          const { routeOcr } = await import('../lib/ocr/router.js');
          ocrResult = await routeOcr(pdfBuf, { profile: docProfile, textPages: pages });
        }
        det = {
          textOk: true,
          ocr: ocrResult ? { status: ocrResult.status, ocrPages: ocrResult.ocrPages, mustKeepPages: ocrResult.mustKeepPages, note: ocrResult.note } : null,
          textPages: pages.map((pg) => ({ page: pg.page, text: pg.lines.map((l) => l.text).join('\n').slice(0, 4000) })),
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
    let geminiBuf = pdfBuf, sliced = false, pageMap = null, sliceStrategy = det.relevantPages.length ? 'parser_relevant_pages' : 'none';
    {
      const { slicePdf, pageCountOf } = await import('../lib/pdfslice.js');
      let pagesToUse = det.relevantPages;
      if (!pagesToUse.length) {
        // item 11：不再"前 6 页 + 后 8 页"盲切。按页面证据选页：
        //   1) 有 pdf-inspector 画像时，剔除需 OCR 的页（喂过去也读不出文本，只会浪费预算）
        //   2) 优先取"有文本且命中关键词（pin/package/mechanical/outline/dimension）"的页
        //   3) 仍为空时保留首页 + 有文本的最后若干页（机械图惯例在书末），并记录该回退
        const total = await pageCountOf(pdfBuf);
        const ocrPages = new Set(docProfile?.pagesNeedingOcr || []);
        const textPages = (det.textPages || []).filter((tp) => !ocrPages.has(tp.page));
        const KEY = /pin (configuration|functions)|package (outline|option|information)|mechanical|land pattern|dimension|引脚|封装|机械/i;
        const hits = textPages.filter((tp) => KEY.test(tp.text)).map((tp) => tp.page);
        if (hits.length) {
          pagesToUse = [...new Set([1, ...hits])].sort((a, b) => a - b).slice(0, 20);
          sliceStrategy = 'keyword_pages';
        } else if (textPages.length) {
          const tail = textPages.slice(-8).map((tp) => tp.page);
          pagesToUse = [...new Set([1, ...tail])].sort((a, b) => a - b);
          sliceStrategy = 'first_plus_text_tail';
        } else if (ocrPages.size && total) {
          // 全文档需 OCR：本版本没有 OCR Worker，不做盲切，交由 AI 读整本或走审核
          sliceStrategy = 'scanned_no_ocr_worker';
        }
      }
      // item 12：需 OCR 的页（常含机械图）无论选页策略如何都必须保留
      if (det.ocr?.mustKeepPages?.length && pagesToUse.length) {
        pagesToUse = [...new Set([...pagesToUse, ...det.ocr.mustKeepPages])].sort((a, b) => a - b);
        sliceStrategy += '+ocr_must_keep';
      }
      if (pagesToUse.length) {
        const s = await slicePdf(pdfBuf, pagesToUse);
        if (s) { geminiBuf = s.buf; sliced = true; pageMap = s.pageMap; }
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

    if (sliced && pageMap) remapDerivedPages(raw, pageMap);
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
    const recDet = sanitizePinsDetailed(recSet ? recSet.pins : []);
    const pins = recDet.pins;
    const pinsReviewRequired = recDet.reviewRequired;
    const { filterFiguresDetailed } = await import('../lib/figfilter.js');
    const figFiltered = filterFiguresDetailed(
      need.figures ? sanitizeFigures(raw?.figures) : sanitizeFigures(det.figures),
      { pkgCount: packages.length }
    );
    const figures = figFiltered.figures;

    return res.status(200).json({
      mock: false,
      part,
      packages,
      recommendedPackageIndex: idx,
      pins,
      pinsets,
      pinTransformationLog: recDet.transformationLog,
      pinsReviewRequired,
      figures,
      figureCandidates: figFiltered.rejected, // 被过滤候选（含原因），供审核复活，不默认展示
      sources: {
        part: need.part ? 'gemini' : 'parser',
        packages: 'gemini',
        pins: need.pins ? 'gemini' : 'parser',
        figures: need.figures ? 'gemini' : 'parser'
      },
      jobId: sealJob({
        part, packages, pinsets, figures,
        recommendedPackageIndex: idx,
        mock: false,
        pinsReviewRequired: pinsReviewRequired,
        tenantId: session.tenantId,
        pdfUrl: v.url
      }).jobId,
      pdfToken: uploaded ? null : signPdfToken(v.url), // 供前端图区裁剪经受控端点取回
      meta: {
        mode: 'live',
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        pdfUrl: v.url,
        pdfBytes: pdfBuf.length,
        strategy: det.textOk ? (need.pins ? 'hybrid' : 'parser-first') : 'gemini-full',
        sliceStrategy,
        docProfile: docProfile ? { pdfType: docProfile.pdfType, confidence: docProfile.confidence, ocrPageCount: (docProfile.pagesNeedingOcr || []).length } : null,
        ocr: det.ocr || null,
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
        jobId: sealJob({
          part: det.part || { mpn: 'UNKNOWN' },
          packages: [sanitizePackage({ pinCount: det.pins.length })],
          pinsets: sanitizePinsets(det.pinsets, det.pins),
          figures: sanitizeFigures(det.figures),
          mock: false, degraded: true, tenantId: session.tenantId, pdfUrl: v.url
        }).jobId,
        pdfToken: uploaded ? null : signPdfToken(v.url), // item 9：degraded 响应同样提供 PDF 访问方式
        sources: { part: 'parser', packages: 'fallback', pins: 'parser', figures: 'parser' },
        meta: { mode: 'degraded', warning: `AI 不可用（${e.message}），封装尺寸为默认值，请手工核对`, pdfUrl: v.url, pdfBytes: pdfBuf.length }
      });
    }
    return res.status(502).json({ error: `AI 提取失败: ${e.message}` });
  }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** P0-1：切片 PDF 的派生页码 → 原文页码反向映射（页码是证据，映射不了就删除引用，绝不带错误页码出门） */
function remapDerivedPages(raw, pageMap) {
  const map = (d) => {
    const n = Math.round(Number(d));
    return n >= 1 && n <= pageMap.length ? pageMap[n - 1] : null;
  };
  if (Array.isArray(raw?.figures)) {
    raw.figures = raw.figures.filter((f) => {
      const orig = map(f?.page);
      if (orig === null) return false; // 无法映射 → 丢弃该图候选（宁缺勿错）
      f.page = orig;
      return true;
    });
  }
  if (Array.isArray(raw?.packages)) {
    for (const pk of raw.packages) {
      if (Array.isArray(pk?.sourcePages)) {
        pk.sourcePages = pk.sourcePages.map(map).filter((x) => x !== null);
      }
      if (pk?.landPattern && pk.landPattern.sourcePage !== undefined) {
        const orig = map(pk.landPattern.sourcePage);
        if (orig === null) delete pk.landPattern.sourcePage;
        else pk.landPattern.sourcePage = orig;
      }
    }
  }
}
export { remapDerivedPages }; // 供测试



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
