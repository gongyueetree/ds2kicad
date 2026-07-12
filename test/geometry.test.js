// test/geometry.test.js — 几何校验层 + 管脚排布图提取
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { normalizeGeometry } from '../lib/kicadgen/geometry.js';
import { generateFootprint } from '../lib/kicadgen/footprint.js';
import { guessFamily } from '../lib/validate.js';
import { extractTextPages } from '../lib/pdftext.js';
import { findFigures } from '../lib/heuristics.js';

test('dual 长宽颠倒自动纠正（LM358 SOIC 实际案例形态）', () => {
  const w = [];
  // Gemini 把 4.9（沿引脚）与 3.9（跨引脚）颠倒后的输入
  const p = normalizeGeometry({
    name: 'SOIC-8', family: 'dual', pinCount: 8, pitch: 1.27,
    bodyLength: 3.9, bodyWidth: 4.9, leadSpan: 6.0, leadLength: 1.0, leadWidth: 0.4, height: 1.5, rowSpan: 7.62
  }, w);
  assert.equal(p.bodyLength, 4.9);
  assert.equal(p.bodyWidth, 3.9);
  assert.ok(w.some((x) => /颠倒/.test(x)));
  // 纠正后焊盘必须在本体之外（回归：SO-8 焊盘画进本体）
  const mod = generateFootprint({ mpn: 'LM358', pkg: p });
  const pads = [...mod.matchAll(/\(pad "\d+" smd \S+ \(at ([-\d.]+) [-\d.]+\) \(size ([\d.]+)/g)]
    .map((m) => ({ x: Math.abs(+m[1]), w: +m[2] }));
  for (const pad of pads) assert.ok(pad.x - pad.w / 2 >= p.bodyWidth / 2 - 0.3, `焊盘内沿 ${pad.x - pad.w / 2} 应不深入本体（半宽 ${p.bodyWidth / 2}）`);
});

test('dual leadSpan 不大于本体宽 → 派生 + 告警', () => {
  const w = [];
  const p = normalizeGeometry({ name: 'X', family: 'dual', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 3.5, height: 1.5 }, w);
  assert.ok(p.leadSpan > p.bodyWidth + 0.6);
  assert.ok(w.some((x) => /leadSpan/.test(x)));
});

test('dual 本体长与引脚数不符 → 派生', () => {
  const w = [];
  const p = normalizeGeometry({ name: 'X', family: 'dual', pinCount: 20, pitch: 0.65, bodyLength: 2.0, bodyWidth: 1.8, leadSpan: 6.4, height: 1.1 }, w);
  assert.ok(p.bodyLength >= (10 - 1) * 0.65 + 0.2, `派生后 ${p.bodyLength}`);
  assert.ok(w.length > 0);
});

test('DIP 孔距小于本体宽 → 标准值', () => {
  const w = [];
  const p = normalizeGeometry({ name: 'PDIP-8', family: 'dip', pinCount: 8, pitch: 2.54, bodyLength: 9.8, bodyWidth: 6.35, rowSpan: 5.0, height: 3.3 }, w);
  assert.equal(p.rowSpan, 7.62);
});

test('LCCC/PLCC 家族映射为 qfn（四边）', () => {
  assert.equal(guessFamily('LCCC'), 'qfn');
  assert.equal(guessFamily('PLCC'), 'qfn');
  // LCCC-20：每边 5 脚，四边生成 20 焊盘
  const w = [];
  const p = normalizeGeometry({ name: 'LCCC-20', family: 'qfn', pinCount: 20, pitch: 1.27, bodyLength: 8.89, bodyWidth: 8.89, leadLength: 1.0, height: 2.0 }, w);
  const mod = generateFootprint({ mpn: 'LM358', pkg: p });
  const pads = [...mod.matchAll(/\(pad "(\d+)" smd/g)];
  assert.equal(pads.length, 20);
});

test('QFN 本体放不下每边引脚 → 派生', () => {
  const w = [];
  const p = normalizeGeometry({ name: 'QFN-24', family: 'qfn', pinCount: 24, pitch: 0.5, bodyLength: 2.0, bodyWidth: 2.0, leadLength: 0.4, height: 0.8 }, w);
  assert.ok(p.bodyLength >= (6 - 1) * 0.5 + 0.8);
  assert.ok(w.length >= 2);
});

test('findFigures：识别 "(Top View)" 说明行为 pin_configuration；章节标题形态不误报', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  const t = (s, x, y, sz = 10) => pg.drawText(s, { x, y, size: sz, font });
  t('5 Pin Configuration and Functions', 60, 740, 12); // 章节标题：不应成为图
  t('Figure 5-1. D Package, 8-Pin SOIC (Top View)', 150, 500, 9);
  t('Figure 5-2. P Package, 8-Pin PDIP (Top View)', 150, 200, 9);
  const buf = Buffer.from(await doc.save());
  const { pages } = await extractTextPages(buf);
  const figs = findFigures(pages);
  const pc = figs.filter((f) => f.kind === 'pin_configuration');
  assert.equal(pc.length, 2, JSON.stringify(figs));
  assert.match(pc[0].title, /SOIC/);
  assert.ok(!figs.some((f) => /Pin Configuration and Functions/.test(f.title)), '章节标题不应成图');
});
