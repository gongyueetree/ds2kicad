// lib/pdftext.js — 服务端 PDF 文本层提取（pdfjs-dist legacy，Node 无 worker）
// 输出按页的“行”结构（文本 + PDF 坐标），同时保留 item 级坐标供 Source Census 使用。
// 扫描版 PDF（无文本层）返回空行数组，上层自动回退 Vision/LLM 路径。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * @returns {Promise<{pageCount:number, pages:Array<{page:number,width:number,height:number,lines:Array,items:Array}>}>}
 * 坐标为 PDF 原生坐标系（原点左下，y 向上）。
 */
export async function extractTextPages(buf, { maxPages = 80 } = {}) {
  const task = getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false
  });
  const doc = await task.promise;
  const pageCount = doc.numPages;
  const pages = [];
  const n = Math.min(pageCount, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        str: it.str,
        text: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        x1: it.transform[4] + (it.width || 0),
        h: Math.abs(it.transform[3]) || Math.abs(it.height) || 8
      }));
    // 按基线 y 分组成行（容差取字高的一半），行内按 x 排序。
    const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of ordered) {
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
    pages.push({ page: i, width: vp.width, height: vp.height, lines, items });
    page.cleanup();
  }
  await doc.destroy();
  return { pageCount, pages };
}
