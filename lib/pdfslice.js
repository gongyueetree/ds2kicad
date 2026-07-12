// lib/pdfslice.js — 用 pdf-lib 抽取相关页子集，缩小 Gemini 输入（token/时延双降）。
// 任何失败都返回 null，上层回退整本 PDF —— 切片只是优化，不是依赖。
import { PDFDocument } from 'pdf-lib';

/**
 * @param {Buffer} buf 原 PDF
 * @param {number[]} pageNums 1-based 页码（升序去重后使用）
 * @returns {Promise<{buf:Buffer, pageMap:number[]}|null>} pageMap[i] = 子集第 i+1 页对应的原页码
 */
export async function slicePdf(buf, pageNums) {
  try {
    const nums = [...new Set(pageNums)].sort((a, b) => a - b);
    if (!nums.length) return null;
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const total = src.getPageCount();
    const valid = nums.filter((n) => n >= 1 && n <= total);
    if (!valid.length || valid.length >= total * 0.7) return null; // 省不了多少就不切
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, valid.map((n) => n - 1));
    copied.forEach((p) => out.addPage(p));
    const bytes = await out.save();
    return { buf: Buffer.from(bytes), pageMap: valid };
  } catch {
    return null;
  }
}
