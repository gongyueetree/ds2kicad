// test/p0.test.js — 审计 P0 修复回归（页码映射 / 禁猜测 / fail-closed / SafeDownloader / 适配器契约）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { remapDerivedPages } from '../api/extract.js';
import { sanitizePackage } from '../lib/validate.js';
import { generateBundle } from '../lib/kicadgen/index.js';
import { isForbiddenIp, validateHopUrl } from '../lib/safedl.js';
import { filterFiguresDetailed } from '../lib/figfilter.js';

test('P0-1：非连续切片 [1,5,9] 的页码反向映射；越界引用被剔除', () => {
  const pageMap = [1, 5, 9]; // 派生第 1/2/3 页 ← 原文 1/5/9
  const raw = {
    figures: [
      { kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 2, bbox: [0.1, 0.1, 0.9, 0.5] },
      { kind: 'application', title: 'Figure 2. Typical Application', page: 7, bbox: [0.1, 0.1, 0.9, 0.5] } // 越界
    ],
    packages: [{ name: 'SOIC-8', sourcePages: [1, 3, 6], landPattern: { padW: 0.6, padL: 1.5, rowSpan: 5.4, sourcePage: 3 } }]
  };
  remapDerivedPages(raw, pageMap);
  assert.equal(raw.figures.length, 1, '无法映射的图候选必须丢弃');
  assert.equal(raw.figures[0].page, 5);
  assert.deepEqual(raw.packages[0].sourcePages, [1, 9], '越界 sourcePage 剔除，其余映射回原文');
  assert.equal(raw.packages[0].landPattern.sourcePage, 9);
});

test('P0-2：missingFields 留痕 → blocked / placeholder / nonPromotable 语义', () => {
  // 全缺 → blocked，不产出封装/3D
  const emptyPkg = sanitizePackage({ name: 'MYSTERY', pinCount: 8 });
  assert.ok(emptyPkg.missingFields.includes('pitch') && emptyPkg.missingFields.includes('bodyLength'));
  const pins8 = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const r1 = generateBundle({ part: { mpn: 'X' }, items: [{ pkg: emptyPkg, pins: pins8 }] });
  assert.equal(r1.items[0].blocked, true);
  assert.equal(r1.items[0].files.kicadMod, undefined, 'blocked 不得产出封装文件');
  assert.equal(r1.nonPromotable, true);
  assert.ok(r1.warnings.some((w) => /blocked_missing_geometry/.test(w)));
  // 部分缺（height）→ 生成但 placeholder
  const partial = sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0 });
  assert.deepEqual(partial.missingFields, ['height']);
  const r2 = generateBundle({ part: { mpn: 'X' }, items: [{ pkg: partial, pins: pins8 }] });
  assert.equal(r2.items[0].blocked, false);
  assert.ok(r2.items[0].files.kicadMod?.length > 100, 'placeholder 仍生成预览产物');
  assert.equal(r2.items[0].placeholder, true);
  assert.equal(r2.nonPromotable, true);
  // 全齐且无先验修正 → 可晋升
  // v0.8.2：即使字段齐全，无手册 land pattern + 参数化 WRL 仍不可晋升（真实性要求）
  const full = sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, height: 1.75 });
  const r3 = generateBundle({ part: { mpn: 'X' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: full, pins: pins8 }] });
  // v0.8.5 item 5：无字段级 EvidenceAnchor 时 fail closed，故额外含 field_evidence_unverified
  assert.ok(r3.reasons.includes('approximate_parametric_3d_not_vendor_step'));
  assert.ok(r3.reasons.includes('land_pattern_derived_not_from_datasheet'));
  assert.ok(r3.reasons.includes('field_evidence_unverified'));
  assert.ok(!r3.reasons.includes('missing_required_geometry'), '字段齐全不应报缺失');
});

test('P0-4：私网/保留 IP 判定与单跳 URL 校验', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isForbiddenIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '2606:4700::1111']) {
    assert.equal(isForbiddenIp(ip), false, ip);
  }
  assert.ok(!validateHopUrl('http://127.0.0.1/x.pdf').ok);
  assert.ok(!validateHopUrl('http://[::ffff:192.168.1.1]/x.pdf').ok);
  assert.ok(!validateHopUrl('https://a.com:22/x.pdf').ok, '非常规端口拒绝');
  assert.ok(!validateHopUrl('ftp://a.com/x.pdf').ok);
  assert.ok(validateHopUrl('https://www.ti.com/lit/x.pdf').ok);
});

test('图区候选保留：被拒候选带原因返回而非永久丢弃', () => {
  const { figures, rejected } = filterFiguresDetailed([
    { kind: 'application', title: 'Figure 1. Typical Application Circuit', page: 5, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'application', title: 'Figure 2. Application Curves', page: 6, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'application', title: 'Some Random Photo', page: 7, bbox: [0.1, 0.1, 0.9, 0.5] }
  ], { pkgCount: 1 });
  assert.equal(figures.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(rejected.find((r) => /Curves/.test(r.title)).rejectReason, 'blacklist_curve_plot');
  assert.equal(rejected.find((r) => /Random/.test(r.title)).rejectReason, 'keyword_not_matched');
});

test('pdf-inspector 适配器契约：1-based 页码 + 左下原点坐标（与 pdftext 同构）', async (t) => {
  let adapter;
  try {
    adapter = await import('../lib/parsers/pdfInspectorAdapter.js');
    await import('@firecrawl/pdf-inspector'); // 原生模块加载 = 平台可用性探测
  } catch (e) {
    t.skip(`pdf-inspector 本平台不可用（${e.message.slice(0, 60)}）— NOT VERIFIED`);
    return;
  }
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('TOP LINE', { x: 60, y: 720, size: 12, font });   // 高 y（左下原点）
  pg.drawText('BOTTOM LINE', { x: 60, y: 100, size: 12, font });
  const buf = Buffer.from(await doc.save());
  const cls = await adapter.classify(buf);
  assert.ok(['TextBased', 'textBased', 'text_based'].some((k) => cls.pdfType.toLowerCase().includes('text')), cls.pdfType);
  const { pageCount, pages } = await adapter.extractTextPages(buf);
  assert.equal(pageCount, 1);
  assert.equal(pages[0].page, 1, '页码必须 1-based');
  const top = pages[0].lines.find((l) => /TOP LINE/.test(l.text));
  const bot = pages[0].lines.find((l) => /BOTTOM LINE/.test(l.text));
  assert.ok(top && bot, JSON.stringify(pages[0].lines.map((l) => l.text)));
  assert.ok(top.y > bot.y, `坐标应为左下原点（top.y=${top?.y} 应大于 bottom.y=${bot?.y}）`);
});
