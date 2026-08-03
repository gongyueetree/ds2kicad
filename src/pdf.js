// src/pdf.js — pdf.js 封装：经 /api/fetch-pdf 代理加载 PDF，渲染页面与截取图区
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let cache = { url: null, doc: null };
let localPdf = null; // 上传模式：{ name, data:ArrayBuffer }

/** 上传模式注册本地 PDF；对应的 loadPdf 标识为 `local:<fileName>` */
export function setLocalPdf(name, data) {
  localPdf = { name, data };
  cache = { url: null, doc: null };
}

let pdfToken = null;
let jobId = null;
export function setPdfToken(t) { pdfToken = t || null; }
/** v0.8.6：按 jobId 取回 PDF（多实例一致 + 复用已下载字节），替代跨实例令牌方案 */
export function setJobId(id) { jobId = id || null; }

export async function loadPdf(pdfUrl) {
  if (cache.url === pdfUrl && cache.doc) return cache.doc;
  let doc;
  if (String(pdfUrl).startsWith('local:')) {
    if (!localPdf) throw new Error('本地 PDF 已失效，请重新上传');
    // pdf.js 会转移(transfer) ArrayBuffer 所有权，必须拷贝一份，否则第二次加载报 detached
    doc = await pdfjsLib.getDocument({ data: localPdf.data.slice(0) }).promise;
  } else {
    const proxied = jobId
      ? `/api/job-pdf?jobId=${encodeURIComponent(jobId)}`
      : `/api/fetch-pdf?url=${encodeURIComponent(pdfUrl)}${pdfToken ? `&token=${encodeURIComponent(pdfToken)}` : ''}`;
    doc = await pdfjsLib.getDocument({ url: proxied }).promise;
  }
  cache = { url: pdfUrl, doc };
  return doc;
}

/** 渲染指定页到 canvas，返回 { canvas, widthPt, heightPt }（宽度目标约 targetWidth 像素） */
export async function renderPage(doc, pageNum, targetWidth = 1100) {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = targetWidth / vp1.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, scale };
}

/** 按归一化 bbox（左上原点）从整页 canvas 截取为 PNG dataURL */
export function cropToDataUrl(pageCanvas, bbox, outScale = 1) {
  const [x0, y0, x1, y1] = bbox;
  const sx = Math.round(x0 * pageCanvas.width);
  const sy = Math.round(y0 * pageCanvas.height);
  const sw = Math.max(4, Math.round((x1 - x0) * pageCanvas.width));
  const sh = Math.max(4, Math.round((y1 - y0) * pageCanvas.height));
  const out = document.createElement('canvas');
  out.width = Math.round(sw * outScale);
  out.height = Math.round(sh * outScale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
