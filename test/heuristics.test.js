// test/heuristics.test.js — 确定性提取器测试：pdf-lib 现场构造合成数据手册 → pdftext → heuristics
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextPages } from '../lib/pdftext.js';
import { findPartInfo, parsePinTable, findFigures, selectRelevantPages } from '../lib/heuristics.js';
import { slicePdf } from '../lib/pdfslice.js';

let pages;

async function buildSyntheticDatasheet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const W = 612, H = 792;

  // 第 1 页：型号 + 标题 + 首页 Simplified Schematic 标题
  const p1 = doc.addPage([W, H]);
  const t = (pg, s, x, y, size = 10) => pg.drawText(s, { x, y, size, font });
  t(p1, 'FAKE1234', 60, 740, 16);
  t(p1, '3.3-V, 2:1 (SPDT), 6-channel analog multiplexer with 1.0-V control', 60, 715, 11);
  t(p1, 'Texas Instruments', 60, 60, 8);
  t(p1, 'Simplified Schematic', 60, 640, 11);
  // 640 下方是"图"（无文本），下一条实质文本在 y=300
  t(p1, 'The device is a general-purpose analog multiplexer supporting rail-to-rail operation on all channels.', 60, 300, 9);

  // 第 2 页：管脚表（NAME NO TYPE DESC 列序，各列独立 drawText 形成列间距）
  const p2 = doc.addPage([W, H]);
  t(p2, '5 Pin Configuration and Functions', 60, 740, 12);
  const rows = [
    ['NO1', '1', 'I/O', 'Normally open source 1'],
    ['COM1', '2', 'I/O', 'Common drain 1'],
    ['NC1', '3', 'I/O', 'Normally closed source 1'],
    ['IN1', '4', 'I', 'Logic select input 1'],
    ['GND', '5', 'G', 'Ground'],
    ['VCC', '6', 'P', 'Positive supply'],
    ['OUT', '7', 'O', 'Buffered output'],
    ['EN', '8', 'I', 'Enable, active high']
  ];
  rows.forEach((r, i) => {
    const y = 700 - i * 18;
    t(p2, r[0], 60, y); t(p2, r[1], 160, y); t(p2, r[2], 220, y); t(p2, r[3], 280, y);
  });
  t(p2, 'Thermal pad  Connect the exposed thermal pad to GND', 60, 700 - rows.length * 18);
  t(p2, '6 Specifications', 60, 700 - (rows.length + 2) * 18, 12);

  // 第 3 页：Figure 说明行（图在其上方）
  const p3 = doc.addPage([W, H]);
  t(p3, '7.2 Functional Block Diagram', 60, 730, 12);
  t(p3, 'Figure 12. Functional Block Diagram', 200, 420, 9);
  t(p3, 'Figure 13. Typical Application Circuit', 200, 120, 9);

  // 第 4 页：机械图关键词页
  const p4 = doc.addPage([W, H]);
  t(p4, 'PACKAGE OUTLINE', 60, 740, 12);
  t(p4, 'RSM0024A  WQFN - 0.8 mm max height', 60, 715, 9);

  return Buffer.from(await doc.save());
}

before(async () => {
  const buf = await buildSyntheticDatasheet();
  ({ pages } = await extractTextPages(buf));
});

test('pdftext：4 页均有文本行且行坐标合理', () => {
  assert.equal(pages.length, 4);
  assert.ok(pages.every((p) => p.lines.length > 0));
  const first = pages[0].lines.find((l) => l.text.includes('FAKE1234'));
  assert.ok(first && first.y > 700, '首页型号应在页面上部');
});

test('findPartInfo：URL 优先取型号，首页取标题与厂商', () => {
  const r = findPartInfo(pages, 'https://www.ti.com/lit/ds/symlink/fake1234.pdf');
  assert.equal(r.part.mpn, 'FAKE1234');
  assert.match(r.part.title, /analog multiplexer/);
  assert.equal(r.part.manufacturer, 'Texas Instruments');
  // 无 URL 时回退首页全大写 token
  const r2 = findPartInfo(pages, '');
  assert.equal(r2.part.mpn, 'FAKE1234');
});

test('parsePinTable：8 行高置信解析 + EP 追加为 9 脚，类型映射正确', () => {
  const r = parsePinTable(pages);
  assert.equal(r.confidence, 'high', `coverage=${r.coverage}`);
  assert.equal(r.pins.length, 9);
  const by = Object.fromEntries(r.pins.map((p) => [p.name, p]));
  assert.equal(by.NO1.type, 'bidirectional'); // 表内 I/O 的确定性映射（解析器不猜"模拟开关通道"语义）
  assert.equal(by.IN1.type, 'input');
  assert.equal(by.GND.type, 'power_in');
  assert.equal(by.VCC.type, 'power_in');
  assert.equal(by.OUT.type, 'output');
  assert.equal(by.EP.number, '9');
});

test('findFigures：block_diagram 1 个 + application 1 个，bbox 在合理区间', () => {
  const figs = findFigures(pages);
  const bd = figs.find((f) => f.kind === 'block_diagram');
  const ap = figs.find((f) => f.kind === 'application');
  assert.ok(bd, '应找到 block diagram');
  assert.ok(ap, '应找到 application');
  for (const f of [bd, ap]) {
    const [x0, y0, x1, y1] = f.bbox;
    assert.ok(x1 > x0 && y1 > y0 && y1 - y0 >= 0.04, `bbox 异常 ${JSON.stringify(f.bbox)}`);
    assert.ok(y0 >= 0.02 && y1 <= 0.98);
  }
  // Figure 12 说明行在 y=420（页高 792 → 归一化 ~0.47），图区应覆盖说明行上方
  assert.ok(bd.bbox[3] > 0.45 && bd.bbox[1] < 0.45, `block bbox=${JSON.stringify(bd.bbox)}`);
});

test('selectRelevantPages：含首页/管脚页/图页/机械页', () => {
  const figs = findFigures(pages);
  const rel = selectRelevantPages(pages, figs);
  for (const p of [1, 2, 3, 4]) assert.ok(rel.includes(p), `缺页 ${p}`);
});

test('slicePdf：抽取子集页数正确，占比过高时返回 null', async () => {
  const buf = await buildSyntheticDatasheet();
  const s = await slicePdf(buf, [1, 3]);
  assert.ok(s && s.pageMap.length === 2);
  const { pages: sub } = await extractTextPages(s.buf);
  assert.equal(sub.length, 2);
  assert.ok(sub[1].lines.some((l) => /Figure 12/.test(l.text)));
  assert.equal(await slicePdf(buf, [1, 2, 3, 4]), null, '全选时不切片');
});
