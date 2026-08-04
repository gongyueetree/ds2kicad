// src/pdf.js — pdf.js 封装：加载 PDF、渲染页面、提取文本层真实坐标、截取图区
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildInkGrid, detectChrome } from './figfit.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

let cache = { url: null, doc: null };
let localPdf = null; // 上传模式：{ name, data:ArrayBuffer }

/** 上传模式注册本地 PDF；对应的 loadPdf 标识为 `local:<fileName>` */
export function setLocalPdf(name, data) {
  localPdf = { name, data };
  cache = { url: null, doc: null };
  pageCache = new WeakMap();
}

let pdfToken = null;
let jobId = null;
export function setPdfToken(t) { pdfToken = t || null; }
/** v0.8.6：按 jobId 取回 PDF（多实例一致 + 复用已下载字节），替代跨实例令牌方案 */
export function setJobId(id) { jobId = id || null; }

export async function loadPdf(pdfUrl) {
  if (cache.url === pdfUrl && cache.doc) return cache.doc;
  let doc;
  // 上传通道：浏览器已持有原始字节，直接用，避免绕服务端（v0.8.7 修复图集空白）
  if (localPdf && (String(pdfUrl).startsWith('local:') || pdfUrl === `local:${localPdf.name}`)) {
    doc = await pdfjsLib.getDocument({ data: localPdf.data.slice(0) }).promise;
    cache = { url: pdfUrl, doc };
    return doc;
  }
  if (String(pdfUrl).startsWith('local:')) {
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

/* ───────────────────────── 页面渲染（带缓存）───────────────────────── */

// v0.8.9：同一页在图集里会被多张图复用，重复 render 既慢又浪费；按 doc→"页码|宽度"缓存
let pageCache = new WeakMap();
function cacheOf(doc) {
  let m = pageCache.get(doc);
  if (!m) { m = new Map(); pageCache.set(doc, m); }
  return m;
}

/** 渲染指定页到 canvas，返回 { canvas, scale, viewport } */
export async function renderPage(doc, pageNum, targetWidth = 1100) {
  const key = `${pageNum}|${targetWidth}`;
  const m = cacheOf(doc);
  if (m.has(key)) return m.get(key);
  const pending = (async () => {
    const page = await doc.getPage(pageNum);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = targetWidth / vp1.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // 显式铺白底：墨迹分析要求"未绘制区域 = 纸白"，不能是透明（透明会被当成纯黑）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { canvas, scale, viewport, pageNum };
  })();
  m.set(key, pending);
  const out = await pending;
  m.set(key, out);
  return out;
}

/* ───────────────────────── 文本层真实坐标 ───────────────────────── */

/**
 * 提取指定页的文本"行"，坐标为设备像素、原点左上（与 canvas 一致）。
 * 这是图区定位的坐标基准 —— 唯一可信的几何来源。
 * @returns {Array<{text:string,left:number,right:number,top:number,bottom:number,h:number}>}
 */
export async function getTextLines(doc, pageNum, viewport) {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fh = Math.hypot(tr[2], tr[3]) || 8;      // 设备像素字高
    const w = (it.width || 0) * viewport.scale;
    items.push({ str: it.str, left: tr[4], right: tr[4] + w, base: tr[5], h: fh });
  }
  items.sort((a, b) => a.base - b.base || a.left - b.left);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.base - it.base) < Math.max(2.5, it.h * 0.5)) {
      const gap = it.left - last.right;
      last.text += (gap > it.h * 0.6 ? '  ' : ' ') + it.str;
      last.left = Math.min(last.left, it.left);
      last.right = Math.max(last.right, it.right);
      last.h = Math.max(last.h, it.h);
    } else {
      lines.push({ text: it.str, left: it.left, right: it.right, base: it.base, h: it.h });
    }
  }
  for (const l of lines) {
    l.text = l.text.replace(/\s{3,}/g, '  ').trim();
    l.top = l.base - l.h;
    l.bottom = l.base + l.h * 0.25;
  }
  return lines;
}

/**
 * 页面完整画像：渲染 + 墨迹图 + 文本行 + 页眉页脚边界。供 figfit.autoFitFigure 使用。
 * 结果按 doc 缓存，一页只算一次。
 */
export async function analyzePage(doc, pageNum, targetWidth = 1200) {
  const key = `analysis|${pageNum}|${targetWidth}`;
  const m = cacheOf(doc);
  if (m.has(key)) return m.get(key);
  const pending = (async () => {
    const { canvas, viewport, scale } = await renderPage(doc, pageNum, targetWidth);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const grid = buildInkGrid(img.data, canvas.width, canvas.height);
    let lines = [];
    try { lines = await getTextLines(doc, pageNum, viewport); } catch { /* 扫描版无文本层 */ }
    const chrome = detectChrome(lines, canvas.height);
    return { canvas, grid, lines, scale, viewport, pageNum, ...chrome };
  })();
  m.set(key, pending);
  const out = await pending;
  m.set(key, out);
  return out;
}

/* ───────────────────────── 截取 ───────────────────────── */

/** 按归一化 bbox（左上原点）从整页 canvas 截取为 PNG dataURL */
/** pad 为归一化留白比例，避免图形边缘的管脚标注/引出线被裁掉 */
export function cropToDataUrl(pageCanvas, bbox, outScale = 1, pad = 0) {
  let b = bbox;
  if (pad > 0) {
    b = [
      Math.max(0, b[0] - pad), Math.max(0, b[1] - pad),
      Math.min(1, b[2] + pad), Math.min(1, b[3] + pad)
    ];
  }
  return cropInner(pageCanvas, b, outScale);
}

function cropInner(pageCanvas, bbox, outScale = 1) {
  // v0.8.9：源矩形一律钳制在画布内，越界部分曾被画成透明 → 导出 PNG 出现大片"空白"
  const x0 = Math.max(0, Math.min(1, bbox[0]));
  const y0 = Math.max(0, Math.min(1, bbox[1]));
  const x1 = Math.max(x0, Math.min(1, bbox[2]));
  const y1 = Math.max(y0, Math.min(1, bbox[3]));
  const sx = Math.round(x0 * pageCanvas.width);
  const sy = Math.round(y0 * pageCanvas.height);
  const sw = Math.max(4, Math.min(pageCanvas.width - sx, Math.round((x1 - x0) * pageCanvas.width)));
  const sh = Math.max(4, Math.min(pageCanvas.height - sy, Math.round((y1 - y0) * pageCanvas.height)));
  const out = document.createElement('canvas');
  out.width = Math.round(sw * outScale);
  out.height = Math.round(sh * outScale);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
