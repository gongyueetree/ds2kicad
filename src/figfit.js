// src/figfit.js — v0.8.9 图区几何确定性引擎
//
// 设计原则（与全线产品一致）：AI 管语义，确定性引擎管几何。
//   AI 只负责回答：这一页上有哪张图、是什么类型、标题是什么。
//   裁剪坐标一律由「页面渲染像素的墨迹分布」+「PDF 文本层的真实行坐标」推导，
//   绝不信任 AI 给出的 bbox（VLM 读 PDF 时没有真实视觉栅格，坐标是猜的，
//   且 TOP-LEFT / BOTTOM-LEFT 原点常常反转）。
//
// 本文件不依赖 DOM / pdfjs，纯函数，可在 Node 下单测。
// 调用方（src/pdf.js）负责把 canvas 像素与文本层整理成 analysis 结构后传进来。

export const DEFAULTS = {
  cell: 4,                 // 墨迹图降采样格边长（像素）
  inkThreshold: 236,       // 灰度低于此值视为墨
  minRowInkRatio: 0.006,   // 一行至少这么多比例的格子有墨，才算"有内容的行"
  maxGapRatio: 0.030,      // 图形内部允许的最大空白带（占页高）
  leadGapRatio: 0.055,     // 标题与图形之间允许的空白（占页高）
  maxBlockRatio: 0.80,     // 单张图最大高度（占页高）
  minBlockRatio: 0.040,    // 单张图最小高度（占页高）
  minInkRatio: 0.0030,     // 结果框内最小墨迹占比，低于此判为空白
  padRatio: 0.014,         // 结果四周留白
  bodyTextLen: 40          // 超过这么多字符的文本行视为正文，作为生长硬边界
};

/* ───────────────────────── 墨迹图 ───────────────────────── */

/**
 * 从 RGBA 像素构建降采样墨迹图。
 * 透明像素(a<16)一律当作纸白 —— 否则 pdf.js 未绘制区域会被当成纯黑墨迹。
 * @returns {{gw:number,gh:number,cell:number,ink:Uint8Array,rowCount:Uint32Array,w:number,h:number}}
 */
export function buildInkGrid(data, w, h, opt = {}) {
  const cell = opt.cell || DEFAULTS.cell;
  const th = opt.inkThreshold ?? DEFAULTS.inkThreshold;
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const ink = new Uint8Array(gw * gh);
  const rowCount = new Uint32Array(gh);
  for (let y = 0; y < h; y++) {
    const gy = (y / cell) | 0;
    const base = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = base + x * 4;
      const a = data[i + 3];
      const lum = a < 16 ? 255 : (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum >= th) continue;
      const gi = gy * gw + ((x / cell) | 0);
      if (!ink[gi]) { ink[gi] = 1; rowCount[gy]++; }
    }
  }
  return { gw, gh, cell, ink, rowCount, w, h };
}

/** 统计矩形（格坐标，闭区间）内的墨格数 */
export function inkCells(grid, r0, r1, c0, c1) {
  let n = 0;
  for (let r = Math.max(0, r0); r <= Math.min(grid.gh - 1, r1); r++) {
    const off = r * grid.gw;
    for (let c = Math.max(0, c0); c <= Math.min(grid.gw - 1, c1); c++) if (grid.ink[off + c]) n++;
  }
  return n;
}

/** 矩形内墨迹占比 */
export function inkRatio(grid, r0, r1, c0, c1) {
  const area = (Math.min(grid.gh - 1, r1) - Math.max(0, r0) + 1) * (Math.min(grid.gw - 1, c1) - Math.max(0, c0) + 1);
  return area <= 0 ? 0 : inkCells(grid, r0, r1, c0, c1) / area;
}

/** 指定行区间内的左右墨迹边界（格坐标），全空返回 null */
export function columnBounds(grid, r0, r1) {
  let c0 = -1, c1 = -1;
  for (let c = 0; c < grid.gw; c++) {
    let hit = false;
    for (let r = Math.max(0, r0); r <= Math.min(grid.gh - 1, r1); r++) {
      if (grid.ink[r * grid.gw + c]) { hit = true; break; }
    }
    if (hit) { if (c0 < 0) c0 = c; c1 = c; }
  }
  return c0 < 0 ? null : { c0, c1 };
}

/**
 * 从锚点行沿 dir 方向生长出一个连通图块。
 * 遇到以下任一条件停止：超出上下界、撞上 stopRows（正文行）、
 * 已见墨且连续空白超过 maxGap、未见墨且连续空白超过 leadGap。
 * @returns {{r0:number,r1:number}|null}
 */
export function growBlock(grid, o) {
  const { startRow, dir, limitTop, limitBottom, minInk, maxGap, leadGap, maxRows, stopRows } = o;
  let r = startRow + dir;
  let seen = false, gap = 0, last = startRow;
  while (r >= limitTop && r <= limitBottom) {
    if (stopRows && stopRows[r]) break;
    if (grid.rowCount[r] >= minInk) { seen = true; gap = 0; last = r; }
    else {
      gap++;
      if (!seen) { if (gap > leadGap) break; }
      else if (gap > maxGap) break;
    }
    if (Math.abs(r - startRow) > maxRows) break;
    r += dir;
  }
  if (!seen) return null;
  return dir < 0 ? { r0: last, r1: startRow } : { r0: startRow, r1: last };
}

/** 把页面（chrome 之间）按空白带切成若干图块，按墨量降序 */
export function segmentBlocks(grid, limitTop, limitBottom, minInk, maxGap) {
  const out = [];
  let r = limitTop, cur = null, gap = 0;
  while (r <= limitBottom) {
    if (grid.rowCount[r] >= minInk) {
      if (!cur) cur = { r0: r, r1: r };
      cur.r1 = r; gap = 0;
    } else if (cur) {
      gap++;
      if (gap > maxGap) { out.push(cur); cur = null; gap = 0; }
    }
    r++;
  }
  if (cur) out.push(cur);
  for (const b of out) b.cells = inkCells(grid, b.r0, b.r1, 0, grid.gw - 1);
  return out.sort((a, b) => b.cells - a.cells);
}

/* ───────────────────────── 标题锚定 ───────────────────────── */

/** 归一化：全角→半角、去空白、去标点、小写 */
export function normText(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[.。．,，、:：;；()（）\[\]【】"'“”‘’\-–—_/\\|]+/g, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice 相似度 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.92;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 在文本行中找出与 AI 标题最匹配的那一行（真实坐标即由此而来）。
 * @returns {{line:object,score:number}|null}
 */
export function pickCaptionLine(lines, title, minScore = 0.58) {
  const t = normText(title);
  if (t.length < 3) return null;
  let best = null;
  for (const L of lines || []) {
    const n = normText(L.text);
    if (n.length < 3) continue;
    const s = similarity(t, n);
    if (s >= minScore && (!best || s > best.score)) best = { line: L, score: s };
  }
  return best;
}

/* ───────────────────────── 主入口 ───────────────────────── */

const CAPTION_BELOW_FIG = /^\s*(figure|fig\.?|图|圖)\s*\d/i;      // 图注在下 → 图在上方
const HEADING_ABOVE_FIG = /^\s*\d+(\.\d+)*[\s.、]/;                // 章节标题 → 图在下方

/**
 * @param {object} analysis {grid, lines, chromeTop, chromeBottom}
 *        lines: [{text, top, bottom, left, right, h}]（设备像素，原点左上）
 * @param {object} fig {title, bbox:[x0,y0,x1,y1] AI 建议框（仅作兜底种子）, kind}
 * @returns {{bbox:number[], method:string, score?:number, caption?:string}|null}
 */
export function autoFitFigure(analysis, fig, opt = {}) {
  const C = { ...DEFAULTS, ...opt };
  const { grid } = analysis;
  const R = (yPx) => Math.max(0, Math.min(grid.gh - 1, Math.round(yPx / grid.cell)));

  const minInk = Math.max(2, Math.round(grid.gw * C.minRowInkRatio));
  const maxGap = Math.max(2, Math.round(grid.gh * C.maxGapRatio));
  const leadGap = Math.max(3, Math.round(grid.gh * C.leadGapRatio));
  const maxRows = Math.round(grid.gh * C.maxBlockRatio);
  const limitTop = R(analysis.chromeTop ?? 0);
  const limitBottom = R(analysis.chromeBottom ?? grid.h);

  // 正文行 → 生长硬边界（示意图里几乎不会出现 40 字以上的连续长行）
  const stopRows = new Uint8Array(grid.gh);
  for (const L of analysis.lines || []) {
    if (String(L.text || '').length <= C.bodyTextLen) continue;
    for (let r = R(L.top); r <= R(L.bottom); r++) stopRows[r] = 1;
  }

  const ctx = { limitTop, limitBottom, minInk, maxGap, leadGap, maxRows, stopRows };
  const finish = (r0, r1, method, extra) => {
    const cols = columnBounds(grid, r0, r1);
    if (!cols) return null;
    const hRatio = (r1 - r0 + 1) / grid.gh;
    if (hRatio < C.minBlockRatio || hRatio > C.maxBlockRatio) return null;
    if (inkRatio(grid, r0, r1, cols.c0, cols.c1) < C.minInkRatio) return null;
    const padY = C.padRatio, padX = C.padRatio;
    const bbox = [
      clamp01((cols.c0 * grid.cell) / grid.w - padX),
      clamp01((r0 * grid.cell) / grid.h - padY),
      clamp01(((cols.c1 + 1) * grid.cell) / grid.w + padX),
      clamp01(((r1 + 1) * grid.cell) / grid.h + padY)
    ];
    return { bbox, method, ...extra };
  };

  // ── 路径 A：标题锚定（最可靠，坐标来自 PDF 文本层，零猜测）────────────
  const cap = pickCaptionLine(analysis.lines, fig.title);
  if (cap) {
    const capR0 = R(cap.line.top), capR1 = R(cap.line.bottom);
    const raw = String(cap.line.text || '');
    let dir = 0;
    if (CAPTION_BELOW_FIG.test(raw)) dir = -1;            // "图4-1. …" → 图在标题上方
    else if (HEADING_ABOVE_FIG.test(raw)) dir = +1;       // "7.2 功能方框图" → 图在标题下方
    else {
      // 未知：比较标题上下 30% 页高内的墨量，取多的一侧
      const span = Math.round(grid.gh * 0.30);
      const up = inkCells(grid, Math.max(limitTop, capR0 - span), capR0 - 1, 0, grid.gw - 1);
      const dn = inkCells(grid, capR1 + 1, Math.min(limitBottom, capR1 + span), 0, grid.gw - 1);
      dir = dn > up ? +1 : -1;
    }
    const blk = growBlock(grid, { ...ctx, startRow: dir < 0 ? capR0 : capR1, dir });
    if (blk) {
      const out = finish(Math.min(blk.r0, capR0), Math.max(blk.r1, capR1),
        dir < 0 ? 'caption_up' : 'caption_down', { score: cap.score, caption: raw });
      if (out) return out;
    }
    // 单侧失败 → 换另一侧再试一次
    const blk2 = growBlock(grid, { ...ctx, startRow: dir < 0 ? capR1 : capR0, dir: -dir });
    if (blk2) {
      const out = finish(Math.min(blk2.r0, capR0), Math.max(blk2.r1, capR1),
        dir < 0 ? 'caption_down' : 'caption_up', { score: cap.score, caption: raw });
      if (out) return out;
    }
  }

  // ── 路径 B：以 AI 框为种子做贴合 / 纵向镜像纠偏 ────────────────────
  const seeds = [];
  if (Array.isArray(fig.bbox) && fig.bbox.length === 4) {
    const [, y0, , y1] = fig.bbox;
    seeds.push({ r0: R(y0 * grid.h), r1: R(y1 * grid.h), method: 'seed_trim' });
    // AI 常把 PDF 原生（左下原点）坐标当成左上原点输出 → 纵向镜像是高命中率的纠偏
    seeds.push({ r0: R((1 - y1) * grid.h), r1: R((1 - y0) * grid.h), method: 'seed_mirror' });
  }
  let bestSeed = null;
  for (const s of seeds) {
    const ratio = inkRatio(grid, s.r0, s.r1, 0, grid.gw - 1);
    if (!bestSeed || ratio > bestSeed.ratio) bestSeed = { ...s, ratio };
  }
  if (bestSeed && bestSeed.ratio >= C.minInkRatio) {
    const ref = refineSeed(grid, bestSeed.r0, bestSeed.r1, ctx);
    if (ref) {
      const out = finish(ref.r0, ref.r1, bestSeed.method);
      if (out) return out;
    }
  }

  // ── 路径 C：整页最大图块（与种子纵向重叠者优先）────────────────────
  const blocks = segmentBlocks(grid, limitTop, limitBottom, minInk, maxGap);
  const seedMid = bestSeed ? (bestSeed.r0 + bestSeed.r1) / 2 : null;
  const scored = blocks.map((b) => ({
    ...b,
    score: b.cells * (seedMid !== null && seedMid >= b.r0 && seedMid <= b.r1 ? 1.5 : 1)
  })).sort((a, b) => b.score - a.score);
  for (const b of scored) {
    const out = finish(b.r0, b.r1, 'largest_block');
    if (out) return out;
  }
  return null;
}

/** 种子精修：先内缩去空白，再向外吃掉被截断的引脚标注/引出线 */
export function refineSeed(grid, r0, r1, ctx) {
  let a = -1, b = -1;
  for (let r = Math.max(0, r0); r <= Math.min(grid.gh - 1, r1); r++) {
    if (grid.rowCount[r] >= ctx.minInk) { if (a < 0) a = r; b = r; }
  }
  if (a < 0) return null;
  const half = Math.max(2, Math.round(ctx.maxGap / 2));
  const up = growBlock(grid, { ...ctx, startRow: a, dir: -1, leadGap: half });
  const dn = growBlock(grid, { ...ctx, startRow: b, dir: +1, leadGap: half });
  return { r0: up ? up.r0 : a, r1: dn ? dn.r1 : b };
}

/**
 * 页眉/页脚（chrome）边界识别 —— 避免把"提交文档反馈 / English Data Sheet / 页码"
 * 这类每页都有的装饰行当成图形内容（v0.8.8 截图空白的直接表现就是裁到了页脚）。
 * @returns {{chromeTop:number, chromeBottom:number}} 设备像素
 */
export function detectChrome(lines, h) {
  const FOOTER = /提交文档反馈|submit\s+document\s+feedback|english\s+data\s+sheet|copyright\s*©|版权所有|product\s+folder|www\.[a-z0-9-]+\.com|^\s*\d{1,4}\s*$/i;
  let bottom = h, top = 0;
  for (const L of lines || []) {
    if (L.top > h * 0.90 || (L.top > h * 0.80 && FOOTER.test(L.text))) {
      bottom = Math.min(bottom, L.top - Math.max(4, L.h * 1.1));
    }
    if (L.bottom < h * 0.075 && FOOTER.test(L.text)) {
      top = Math.max(top, L.bottom + L.h * 0.5);
    }
  }
  return {
    chromeTop: Math.max(0, Math.min(h * 0.12, top)),
    chromeBottom: Math.min(h, Math.max(h * 0.75, bottom))
  };
}

function clamp01(v) { return Math.max(0, Math.min(1, +v.toFixed(5))); }

export const METHOD_LABEL = {
  caption_up: '标题锚定',
  caption_down: '标题锚定',
  seed_trim: 'AI 框贴合',
  seed_mirror: '镜像纠偏',
  largest_block: '最大图块',
  ai: 'AI 原框',
  manual: '手动框选'
};
