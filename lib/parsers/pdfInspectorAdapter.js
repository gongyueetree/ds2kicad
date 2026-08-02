// lib/parsers/pdfInspectorAdapter.js — Firecrawl pdf-inspector 的 Parser Adapter（审计 §6）。
// 职责边界：作为 Native Fast Parser（分类 + 文本层 + 坐标），输出与 lib/pdftext.js 完全同构的
// Canonical 行结构，业务层（heuristics）不感知底层解析器差异。
// 归一化要点（审计 §6.3 要求显式处理）：
//   - 页码统一为 1-based 原文页码
//   - 该库 bbox 为左上原点（top-left PDF point）；本项目 Canonical 约定为 PDF 原生左下原点
//     （与 pdftext.js 一致），此处显式做 y 翻转：y_canonical = pageHeight - y_topleft - h
//   - 记录 adapterVersion 与第三方包版本，供 Evidence 溯源
// 部署约束：原生 NAPI 依赖仅用于 Worker/本地（PDF_PARSER=inspector 显式开启），
// Vercel 60s 函数默认走 pdfjs 路径；Linux ARM64 无预编译包时本模块加载失败即回退。

export const ADAPTER_VERSION = 'pdf-inspector-adapter/0.1.0';

let mod = null;
async function load() {
  if (mod) return mod;
  mod = await import('@firecrawl/pdf-inspector');
  return mod;
}

/** 文档画像：TextBased/Scanned/ImageBased/Mixed + 需 OCR 页（1-based 原文页码） */
export async function classify(buf) {
  const m = await load();
  const r = await m.classifyPdf(buf);
  return {
    adapterVersion: ADAPTER_VERSION,
    pdfType: String(r.pdfType ?? r.type ?? 'unknown'),
    confidence: Number(r.confidence ?? 0),
    // 该库页码列表为 0-based，归一化为 1-based
    pagesNeedingOcr: (r.pagesNeedingOcr || []).map((i) => Number(i) + 1)
  };
}

/** 文本层提取 → 与 pdftext.extractTextPages 同构的行结构（坐标左下原点、页码 1-based）。
 *  实测（v1.11.2）：extractTextWithPositions 返回扁平 item 数组，item.page 已是 1-based，
 *  item.y 为 PDF 原生左下原点基线（与 README 中区域 bbox API 的 top-left 语义不同 —— 审计
 *  警告的"不同 API 索引/坐标语义不一致"在此实证，本适配器以契约测试钉死）。
 *  页面尺寸该 API 不返回，用 pdf-lib 读取。 */
export async function extractTextPages(buf, { maxPages = 80 } = {}) {
  const m = await load();
  const flat = await m.extractTextWithPositions(buf);
  const itemsAll = Array.isArray(flat) ? flat : (flat?.items || []);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  const sizes = doc.getPages().map((p) => p.getSize());
  const byPage = new Map();
  for (const it of itemsAll) {
    const pageNo = Math.max(1, Math.round(Number(it.page) || 1));
    if (pageNo > Math.min(sizes.length, maxPages)) continue;
    if (!(it.text ?? '').trim()) continue;
    if (!byPage.has(pageNo)) byPage.set(pageNo, []);
    byPage.get(pageNo).push({
      str: String(it.text),
      x: Number(it.x) || 0,
      y: Number(it.y) || 0,           // 实测已是左下原点，无需翻转
      w: Number(it.width) || 0,
      h: Number(it.height ?? it.fontSize) || 8
    });
  }
  const pages = [];
  for (let pi = 0; pi < Math.min(sizes.length, maxPages); pi++) {
    const W = sizes[pi].width, H = sizes[pi].height;
    const items = byPage.get(pi + 1) || [];
    // 行分组逻辑与 pdftext.js 保持一致（同一份 Canonical 契约）
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) < Math.max(2.5, it.h * 0.5)) {
        const gap = it.x - last.x1;
        last.text += (gap > it.h * 0.6 ? '  ' : ' ') + it.str;
        last.x1 = Math.max(last.x1, it.x + it.w);
        last.h = Math.max(last.h, it.h);
      } else {
        lines.push({ text: it.str, x: it.x, y: it.y, x1: it.x + it.w, h: it.h });
      }
    }
    for (const l of lines) l.text = l.text.replace(/\s{3,}/g, '  ').trim();
    pages.push({ page: pi + 1, width: W, height: H, lines });
  }
  return { pageCount: sizes.length, pages };
}
