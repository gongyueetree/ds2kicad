// test/v089.test.js — v0.8.9 图区几何确定性引擎
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInkGrid, inkRatio, columnBounds, growBlock, segmentBlocks,
  normText, similarity, pickCaptionLine, autoFitFigure, detectChrome
} from '../src/figfit.js';

/* ── 合成一页：白底 + 若干墨块 ────────────────────────────── */
const W = 400, H = 800;
function blankPage() {
  const d = new Uint8Array(W * H * 4).fill(255);
  return d;
}
function rect(d, x0, y0, x1, y1, v = 0) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
}

test('buildInkGrid：透明像素按纸白处理，不得被当成黑墨', () => {
  const d = new Uint8Array(W * 40 * 4); // 全 0 = 透明黑
  const g = buildInkGrid(d, W, 40);
  assert.equal(g.rowCount.reduce((a, b) => a + b, 0), 0, '透明区域不应产生任何墨格');
});

test('buildInkGrid / inkRatio / columnBounds 基本正确', () => {
  const d = blankPage();
  rect(d, 100, 200, 300, 400);
  const g = buildInkGrid(d, W, H);
  // 注意：inkRatio 用的是"格坐标"。像素 0..190（= 格 0..47）是空白带。
  assert.equal(inkRatio(g, 0, Math.floor(190 / g.cell), 0, g.gw - 1), 0, '空白带占比应为 0');
  // 墨块正中（像素 200..400 → 格 50..99；像素 100..300 → 格 25..74）应为满墨
  assert.equal(inkRatio(g, 51, 98, 26, 73), 1, '实心墨块内部占比应为 1');
  const cb = columnBounds(g, Math.round(200 / g.cell), Math.round(399 / g.cell));
  assert.ok(cb, '应找到列边界');
  assert.ok(Math.abs(cb.c0 * g.cell - 100) <= g.cell, `左边界应≈100，实际 ${cb.c0 * g.cell}`);
  assert.ok(Math.abs((cb.c1 + 1) * g.cell - 300) <= g.cell, `右边界应≈300，实际 ${(cb.c1 + 1) * g.cell}`);
});

test('growBlock：遇到足够大的空白带即停止，不吞并下一个图块', () => {
  const d = blankPage();
  rect(d, 50, 100, 350, 200);   // 块 A
  rect(d, 50, 400, 350, 500);   // 块 B（相距 200px = 25% 页高）
  const g = buildInkGrid(d, W, H);
  const blk = growBlock(g, {
    startRow: Math.round(100 / g.cell), dir: +1,
    limitTop: 0, limitBottom: g.gh - 1,
    minInk: 2, maxGap: Math.round(g.gh * 0.03), leadGap: Math.round(g.gh * 0.055),
    maxRows: Math.round(g.gh * 0.8)
  });
  assert.ok(blk, '应生长出块 A');
  assert.ok(blk.r1 * g.cell < 260, `不应跨过空白带吞并块 B，实际下界 ${blk.r1 * g.cell}px`);
});

test('growBlock：stopRows（正文行）是硬边界', () => {
  const d = blankPage();
  rect(d, 50, 100, 350, 300);
  const g = buildInkGrid(d, W, H);
  const stop = new Uint8Array(g.gh);
  const stopAt = Math.round(200 / g.cell);
  stop[stopAt] = 1;
  const blk = growBlock(g, {
    startRow: Math.round(100 / g.cell), dir: +1,
    limitTop: 0, limitBottom: g.gh - 1, minInk: 2,
    maxGap: 12, leadGap: 20, maxRows: 999, stopRows: stop
  });
  assert.ok(blk.r1 < stopAt, '生长必须在正文行之前停下');
});

test('segmentBlocks：按空白带切块并按墨量排序', () => {
  const d = blankPage();
  rect(d, 50, 100, 350, 160);    // 小块
  rect(d, 50, 400, 350, 600);    // 大块
  const g = buildInkGrid(d, W, H);
  const bs = segmentBlocks(g, 0, g.gh - 1, 2, Math.round(g.gh * 0.03));
  assert.equal(bs.length, 2);
  assert.ok(bs[0].cells > bs[1].cells, '首个应为墨量最大的块');
  assert.ok(bs[0].r0 * g.cell >= 380 && bs[0].r0 * g.cell <= 410);
});

/* ── 标题匹配 ────────────────────────────────────────────── */
test('normText / similarity：中英文标题归一化与相似度', () => {
  assert.equal(normText('图 4-1.  RTW 封装（24 引脚）'), '图41rtw封装24引脚');
  assert.ok(similarity(normText('图4-1. RTW 封装 24 引脚 WQFN 顶视图'), normText('图 4-1. RTW封装24引脚WQFN顶视图')) > 0.9);
  assert.ok(similarity(normText('Functional Block Diagram'), normText('Application Curves')) < 0.4);
});

test('pickCaptionLine：在多行中挑出真正的图注', () => {
  const lines = [
    { text: '7.1 概述', top: 100, bottom: 112, h: 12 },
    { text: '图 4-1. RTW封装24引脚WQFN顶视图', top: 500, bottom: 512, h: 12 },
    { text: '本器件适用于多种电源应用场景，具体参数见下表所示内容。', top: 600, bottom: 612, h: 12 }
  ];
  const hit = pickCaptionLine(lines, '图4-1. RTW 封装 24 引脚 WQFN 顶视图');
  assert.ok(hit, '应命中图注行');
  assert.equal(hit.line.top, 500);
  assert.equal(pickCaptionLine(lines, '完全不相干的标题字符串'), null);
});

/* ── 页眉页脚 ────────────────────────────────────────────── */
test('detectChrome：识别 TI 中文页脚，缩回内容下界', () => {
  const h = 800;
  const lines = [
    { text: '图 7-1. 功能方框图', top: 300, bottom: 312, h: 12 },
    { text: '提交文档反馈  23', top: 740, bottom: 752, h: 12 },
    { text: 'English Data Sheet: SLVSJZ9', top: 762, bottom: 774, h: 12 }
  ];
  const c = detectChrome(lines, h);
  assert.ok(c.chromeBottom < 740, `内容下界应在页脚之上，实际 ${c.chromeBottom}`);
  assert.ok(c.chromeBottom >= h * 0.75, '下界不应缩得过狠');
});

/* ── 端到端：复现 v0.8.8 的缺陷场景 ─────────────────────── */
function pageWithFigureAndFooter() {
  // 图形在 y=180..430（页面上中部），图注在 y=450，页脚在 y=740+
  const d = blankPage();
  rect(d, 80, 180, 320, 430);          // 图形本体
  rect(d, 60, 450, 340, 462);          // 图注文字（墨）
  rect(d, 40, 735, 360, 738);          // 页脚分隔线
  rect(d, 40, 745, 200, 757);          // 页脚文字
  const grid = buildInkGrid(d, W, H);
  const lines = [
    { text: '图 4-1. RTW封装24引脚WQFN顶视图', top: 450, bottom: 462, h: 12 },
    { text: '提交文档反馈  3', top: 745, bottom: 757, h: 12 },
    { text: 'English Data Sheet: SLVSJZ9', top: 762, bottom: 774, h: 12 }
  ];
  return { grid, lines, ...detectChrome(lines, H) };
}

test('autoFitFigure：标题锚定（图注在下 → 图在上方）', () => {
  const an = pageWithFigureAndFooter();
  // 故意传入一个"被镜像"的错误 AI 框（正是 v0.8.8 现场的症状）
  const fit = autoFitFigure(an, { title: '图4-1. RTW 封装 24 引脚 WQFN 顶视图', bbox: [0.06, 0.46, 0.94, 0.78] });
  assert.ok(fit, '应贴合成功');
  assert.equal(fit.method, 'caption_up');
  const [x0, y0, x1, y1] = fit.bbox;
  assert.ok(y0 * H < 200, `上界应贴近图形顶部 180px，实际 ${(y0 * H).toFixed(0)}px`);
  assert.ok(y1 * H > 440 && y1 * H < 520, `下界应含图注(≈462px)且不触及页脚，实际 ${(y1 * H).toFixed(0)}px`);
  assert.ok(y1 * H < 700, '绝不能裁到页脚');
  assert.ok(x0 * W < 80 && x1 * W > 320, '左右应覆盖图形并留白');
});

test('autoFitFigure：章节标题（图在下方）', () => {
  const d = blankPage();
  rect(d, 60, 200, 340, 212);          // 标题 "7.2 功能方框图"
  rect(d, 80, 240, 320, 520);          // 图形在标题下方
  const grid = buildInkGrid(d, W, H);
  const lines = [{ text: '7.2 功能方框图', top: 200, bottom: 212, h: 12 }];
  const fit = autoFitFigure({ grid, lines, chromeTop: 0, chromeBottom: H }, { title: '7.2 功能方框图', bbox: [0.1, 0.1, 0.9, 0.4] });
  assert.ok(fit);
  assert.equal(fit.method, 'caption_down');
  assert.ok(fit.bbox[3] * H > 500, '应包含标题下方的图形');
});

test('autoFitFigure：无图注时以 AI 框为种子精修（含被截断的引脚标注）', () => {
  const d = blankPage();
  rect(d, 80, 200, 320, 400);
  const grid = buildInkGrid(d, W, H);
  const fit = autoFitFigure({ grid, lines: [], chromeTop: 0, chromeBottom: H },
    { title: '', bbox: [0.2, 0.30, 0.8, 0.42] });   // 种子只盖住中间一小条
  assert.ok(fit);
  assert.ok(['seed_trim', 'largest_block'].includes(fit.method));
  assert.ok(fit.bbox[1] * H < 220 && fit.bbox[3] * H > 380, '应向外扩到图形真实边界');
});

test('autoFitFigure：AI 框落在空白页脚区时自动镜像纠偏', () => {
  const d = blankPage();
  rect(d, 80, 120, 320, 320);          // 真实图形在页面上部
  const grid = buildInkGrid(d, W, H);
  // AI 按 PDF 原生左下原点给坐标 → 上下颠倒后落在空白处
  const fit = autoFitFigure({ grid, lines: [], chromeTop: 0, chromeBottom: H },
    { title: '', bbox: [0.2, 1 - 320 / H, 0.8, 1 - 120 / H] });
  assert.ok(fit);
  assert.ok(fit.bbox[1] * H < 160 && fit.bbox[3] * H > 300,
    `应纠正到真实图形位置，实际 ${(fit.bbox[1] * H).toFixed(0)}–${(fit.bbox[3] * H).toFixed(0)}px`);
});

test('autoFitFigure：整页空白时返回 null（宁可报错也不给假图）', () => {
  const grid = buildInkGrid(blankPage(), W, H);
  assert.equal(autoFitFigure({ grid, lines: [], chromeTop: 0, chromeBottom: H }, { title: 'x', bbox: [0.1, 0.1, 0.9, 0.5] }), null);
});

test('autoFitFigure：结果 bbox 始终合法（[0,1] 且 x0<x1、y0<y1）', () => {
  const an = pageWithFigureAndFooter();
  for (const seed of [[0, 0, 1, 1], [0.9, 0.9, 1, 1], [0, 0, 0.05, 0.05]]) {
    const fit = autoFitFigure(an, { title: '图4-1. RTW封装24引脚WQFN顶视图', bbox: seed });
    if (!fit) continue;
    const [x0, y0, x1, y1] = fit.bbox;
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1, `越界: ${fit.bbox}`);
    assert.ok(x1 > x0 && y1 > y0, `退化: ${fit.bbox}`);
  }
});
