// lib/ocr/router.js — v0.8.2 item 12：真实 OCR 路由。
// 流程：pdf-inspector classify() → pagesNeedingOcr → OcrWorker.recognize(pages)
// 关键约束：Mixed PDF 中需要 OCR 的页面（机械图页常是矢量/扫描混排）**不得被丢弃**。
//   - 有 OCR Worker（OCR_ENDPOINT 配置）：这些页送 Worker 识别，结果并回文本层
//   - 无 OCR Worker：这些页必须仍然进入送 AI 的页面集合（AI 可读图），
//     并在响应中标记 ocrPending，绝不静默剔除。
//
// NOT VERIFIED：本仓库未内置 OCR 引擎；HttpOcrWorker 的真实识别质量未在任何语料上验证。

export const OCR_STATUS = {
  NOT_NEEDED: 'not_needed',
  DONE: 'ocr_completed',
  PENDING_NO_WORKER: 'ocr_pending_no_worker',
  FAILED: 'ocr_failed'
};

/** 通过 HTTP 调用外部 OCR Worker（PaddleOCR/Docling/OCRmyPDF 容器）。未配置端点即不可用。 */
export class HttpOcrWorker {
  constructor(endpoint = process.env.OCR_ENDPOINT, timeoutMs = 60000) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }
  get available() { return !!this.endpoint; }
  /** @returns {Promise<Array<{page:number, lines:Array}>>} 与 pdftext 同构的行结构 */
  async recognize(pdfBuf, pages) {
    if (!this.available) throw new Error('OCR_ENDPOINT 未配置');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.endpoint, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: pdfBuf.toString('base64'), pages })
      });
      if (!r.ok) throw new Error(`OCR Worker HTTP ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data?.pages)) throw new Error('OCR Worker 返回结构非法');
      return data.pages;
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * 路由决策 + 执行。
 * @param {Buffer} pdfBuf
 * @param {object} opts { profile（classify 结果）, textPages（原生文本层结果）, worker }
 * @returns {Promise<{status, ocrPages:number[], mergedPages:Array, mustKeepPages:number[], note:string}>}
 *   mustKeepPages：无论如何都不能从送 AI 页面集合中剔除的页（item 12 核心约束）
 */
export async function routeOcr(pdfBuf, { profile, textPages = [], worker } = {}) {
  // item 10：可注入 OCR Stub（OCR_STUB=<json pages 数组>），走通真实合并/重解析分支
  if (!worker && process.env.OCR_STUB) {
    try {
      const pages = JSON.parse(process.env.OCR_STUB);
      worker = { available: true, recognize: async () => pages };
    } catch { /* 忽略非法 stub */ }
  }
  const ocrPages = [...new Set(profile?.pagesNeedingOcr || [])].sort((a, b) => a - b);
  if (!ocrPages.length) {
    return { status: OCR_STATUS.NOT_NEEDED, ocrPages: [], mergedPages: textPages, mustKeepPages: [], note: '' };
  }
  const w = worker || new HttpOcrWorker();
  if (!w.available) {
    // 没有 OCR 能力：需 OCR 的页必须保留进 AI 页面集合，不得丢弃
    return {
      status: OCR_STATUS.PENDING_NO_WORKER,
      ocrPages,
      mergedPages: textPages,
      mustKeepPages: ocrPages,
      note: `${ocrPages.length} 页需要 OCR 但未配置 OCR_ENDPOINT；这些页仍会送交模型读图，识别结果需人工复核`
    };
  }
  try {
    const recognized = await w.recognize(pdfBuf, ocrPages);
    const byPage = new Map(textPages.map((p) => [p.page, p]));
    for (const r of recognized) {
      const exist = byPage.get(r.page);
      if (exist) exist.lines = [...(exist.lines || []), ...(r.lines || [])];
      else byPage.set(r.page, { page: r.page, width: r.width || 612, height: r.height || 792, lines: r.lines || [] });
    }
    return {
      status: OCR_STATUS.DONE,
      ocrPages,
      mergedPages: [...byPage.values()].sort((a, b) => a.page - b.page),
      mustKeepPages: ocrPages,
      note: `已对 ${ocrPages.length} 页执行 OCR`
    };
  } catch (e) {
    return {
      status: OCR_STATUS.FAILED,
      ocrPages,
      mergedPages: textPages,
      mustKeepPages: ocrPages,   // 失败也不丢页
      note: `OCR 失败（${e.message}），相关页仍会送交模型读图`
    };
  }
}
