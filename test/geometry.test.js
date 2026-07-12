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

test('landPattern：优先采用数据手册推荐焊盘（SOIC-8 实测值）', () => {
  const pkg = {
    name: 'SOIC-8', family: 'dual', pinCount: 8, pitch: 1.27,
    bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, height: 1.75,
    landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 }
  };
  const mod = generateFootprint({ mpn: 'LM358', pkg });
  const m = /\(pad "2" smd \S+ \(at ([-\d.]+) [-\d.]+\) \(size ([\d.]+) ([\d.]+)\)/.exec(mod);
  assert.ok(m, mod.slice(0, 400));
  // rowSpan=内沿间距 5.4 → 焊盘中心 |x| = 5.4/2 + padL/2 = 3.475
  assert.equal(Math.abs(+m[1]), 3.475);
  assert.equal(+m[2], 1.55); // padL（垂直排布方向）
  assert.equal(+m[3], 0.6);  // padW
  assert.match(mod, /land pattern per datasheet p\.63/);
});

test('landPattern 自相矛盾 → 弃用回退派生 + 告警', () => {
  const w = [];
  const p = normalizeGeometry({
    name: 'X', family: 'dual', pinCount: 8, pitch: 1.27,
    bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, height: 1.5,
    landPattern: { padW: 1.5, padL: 1.5, rowSpan: 5.4 } // padW ≥ pitch → 相邻短路
  }, w);
  assert.equal(p.landPattern, null);
  assert.ok(w.some((x) => /land pattern/.test(x)));
});

test('DIP landPattern：孔径/焊盘径采用推荐值', () => {
  const pkg = {
    name: 'PDIP-8', family: 'dip', pinCount: 8, pitch: 2.54,
    bodyLength: 9.81, bodyWidth: 6.35, rowSpan: 7.62, height: 5.08,
    landPattern: { padW: 1.6, padL: 1.6, rowSpan: 7.62, holeDia: 0.9 }
  };
  const mod = generateFootprint({ mpn: 'LM358', pkg });
  // KLC F7.2：THT 锚点在 1 脚 → pad "1" 位于原点
  assert.match(mod, /\(pad "1" thru_hole rect \(at 0 0\) \(size 1\.6 1\.6\) \(drill 0\.9\)/);
});

test('filterFigures：关键词白名单+曲线黑名单+上限', async () => {
  const { filterFigures } = await import('../lib/figfilter.js');
  const mk = (kind, title, page = 1, y = Math.random()) => ({ kind, title, page, bbox: [0.1, y, 0.9, Math.min(0.98, y + 0.2)] });
  const figs = [
    mk('block_diagram', 'Figure 8-1. Functional Block Diagram', 10, 0.1),
    mk('application', 'Figure 9-2. Typical Application Circuit', 20, 0.1),
    mk('application', 'Figure 9-5. Application Curves', 21, 0.1),           // 黑名单：曲线
    mk('application', 'Figure 6-3. Gain vs Frequency', 22, 0.1),            // 白名单未命中
    mk('application', 'Simplified Schematic', 1, 0.2),
    mk('application', 'Figure 9-8. Typical Application, Comparator', 23, 0.1),
    mk('application', 'Figure 9-9. Typical Application, Follower', 24, 0.1), // 超上限 2 应被裁
    mk('pin_configuration', 'D Package, 8-Pin SOIC (Top View)', 3, 0.1),
    mk('pin_configuration', 'Random Photo', 4, 0.1),                        // 未命中
    mk('block_diagram', 'Another Block Diagram', 11, 0.1)                   // 超上限 1
  ];
  const out = filterFigures(figs, { pkgCount: 5 });
  assert.equal(out.filter((f) => f.kind === 'block_diagram').length, 1);
  assert.equal(out.filter((f) => f.kind === 'application').length, 2);
  assert.equal(out.filter((f) => f.kind === 'pin_configuration').length, 1);
  assert.ok(!out.some((f) => /Curves|vs Frequency|Random/.test(f.title)));
  // 带 Figure 编号的优先于无编号标题
  assert.ok(out.some((f) => f.title.includes('Typical Application Circuit')));
});

test('findFigures：Application Curves 说明行不再入选', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('Figure 9-1. Typical Application Circuit', { x: 150, y: 500, size: 9, font });
  pg.drawText('Figure 9-2. Application Curves', { x: 150, y: 200, size: 9, font });
  const { pages } = await extractTextPages(Buffer.from(await doc.save()));
  const figs = findFigures(pages);
  assert.equal(figs.filter((f) => f.kind === 'application').length, 1);
  assert.match(figs[0].title, /Circuit/);
});

test('KLC 合规：F5.2 第二RefDes / F5.3 庭院网格 / F6.3 圆角上限 / F2.1 命名 / F7.2 模型offset', () => {
  const soic = {
    name: 'SOIC-8', family: 'dual', pinCount: 8, pitch: 1.27,
    bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, height: 1.75,
    landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4 }
  };
  const mod = generateFootprint({ mpn: 'LM358', pkg: soic });
  // F5.2.4 第二 RefDes 居中于本体
  assert.match(mod, /\(fp_text user "\$\{REFERENCE\}" \(at 0 0\) \(layer "F\.Fab"\)/);
  // F6.3 圆角半径 ≤0.25mm：padW=0.6 → rratio 应为 0.25/0.6 ≈ 0.417 → 截为 0.25？0.25*0.6=0.15<0.25 → 保持 0.25
  assert.match(mod, /roundrect_rratio 0\.25\b/);
  // 大焊盘圆角截断：构造 2mm 宽焊盘应 rratio=0.125
  const big = generateFootprint({ mpn: 'X', pkg: { name: 'PWR', family: 'dual', pinCount: 4, pitch: 3, bodyLength: 6, bodyWidth: 4, leadSpan: 8, height: 2, landPattern: { padW: 2.0, padL: 2.4, rowSpan: 6 } } });
  assert.match(big, /roundrect_rratio 0\.104|roundrect_rratio 0\.125/);
  // F5.3 庭院坐标 0.01 网格（不出现三位小数）
  const crt = [...mod.matchAll(/F\.CrtYd"\)/g)];
  assert.ok(crt.length >= 4);
  assert.ok(!/\(start -?\d+\.\d{3,}/.test(mod.split('F.CrtYd')[0].slice(-200)), '庭院坐标应两位小数内');
  // F2.1/F3.4 命名带尺寸
  assert.match(mod, /LM358_SOIC-8_3\.9x4\.9mm_P1\.27mm/);

  const dip = generateFootprint({ mpn: 'LM358', pkg: { name: 'PDIP-8', family: 'dip', pinCount: 8, pitch: 2.54, bodyLength: 9.81, bodyWidth: 6.35, rowSpan: 7.62, height: 5.08 } });
  // DIP 命名 W 孔距
  assert.match(dip, /LM358_PDIP-8_W7\.62mm_P2\.54mm/);
  // F7.2 模型 offset 补偿锚点（x=+rowSpan/2, y=-(+3*pitch/2*?)）：x 应为 3.81
  assert.match(dip, /\(model "[^"]+" \(offset \(xyz 3\.81 -?[\d.]+ 0\)\)/);
});

test('KLC 符号：管脚长按位数（25 脚→200mil），低有效名转上划线，pin_names offset', async () => {
  const { generateKicadSym, generateLegacyLib } = await import('../lib/kicadgen/symbol.js');
  const pins2 = [
    { number: '1', name: 'EN#', type: 'input' }, { number: '2', name: 'OUT', type: 'output' },
    { number: '3', name: 'GND', type: 'power_in' }, { number: '4', name: 'VCC', type: 'power_in' }
  ];
  const sym2 = generateKicadSym({ mpn: 'X2', footprintName: 'X2', pins: pins2 });
  assert.match(sym2, /\(pin_names \(offset 0\.508\)\)/);           // S3.6
  assert.match(sym2, /\(length 2\.54\)/);                            // ≤2位编号 → 100mil
  assert.match(sym2, /"~\{EN\}"/);                                   // S4.7
  const leg2 = generateLegacyLib({ mpn: 'X2', pins: pins2 });
  assert.match(leg2, /^X ~EN 1 /m);
  const pins3 = Array.from({ length: 100 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const sym3 = generateKicadSym({ mpn: 'X3', footprintName: 'X3', pins: pins3 });
  assert.match(sym3, /\(length 5\.08\)/);                            // 3位编号 → 200mil
  assert.ok(!/\(length 2\.54\)/.test(sym3), '全符号等长');            // S4.1
});

test('中文数据手册：图 N-M 说明行与"典型应用"独立标题均可提取，中文曲线类被排除', async () => {
  const { filterFigures } = await import('../lib/figfilter.js');
  // filterFigures 双语
  const out = filterFigures([
    { kind: 'application', title: '图 9-1. 典型应用电路', page: 5, bbox: [0.1, 0.1, 0.9, 0.4] },
    { kind: 'application', title: '图 9-2. 增益与频率特性曲线', page: 6, bbox: [0.1, 0.1, 0.9, 0.4] },
    { kind: 'block_diagram', title: '图 7-1. 内部功能框图', page: 3, bbox: [0.1, 0.1, 0.9, 0.4] }
  ], { pkgCount: 1 });
  assert.equal(out.length, 2);
  assert.ok(!out.some((f) => /曲线/.test(f.title)));
});

test('findFigures：中文首页"典型应用"位于图下方（下半页）→ 区域取上方', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  const t = (x, y, s2, size = 10) => pg.drawText(s2, { x, y, size, font });
  t(60, 700, 'TMUXL27518 is a bidirectional 6-channel 1:2 multiplexer designed for operation from 1.08V to 1.95V supply rails.');
  // 说明行在下半页（y=180 < 0.55*792），图在其上方
  t(270, 180, 'Typical Application', 11); // 用英文占位验证方向启发（pdf-lib 内置字体不支持中文渲染，方向逻辑同一分支）
  const { pages } = await extractTextPages(Buffer.from(await doc.save()));
  // 手工替换标题文本模拟中文命中（提取管线对 text 只做正则，中英走同一路径）
  const line = pages[0].lines.find((l) => /Typical Application/.test(l.text));
  line.text = '典型应用';
  const figs = findFigures(pages);
  const ap = figs.find((f) => f.kind === 'application');
  assert.ok(ap, JSON.stringify(figs));
  // 区域应覆盖说明行上方（y0 < 说明行归一化位置）
  const capNormY = 1 - 180 / 792; // ≈0.77
  assert.ok(ap.bbox[1] < capNormY - 0.1, `bbox=${JSON.stringify(ap.bbox)}`);
  assert.ok(ap.bbox[3] >= capNormY - 0.05);
});

test('合并管脚行展开 + EP 别名归一化：ADL6346B 实测形态端到端', async () => {
  const { sanitizePins, guessFamily } = await import('../lib/validate.js');
  const { generateBundle } = await import('../lib/kicadgen/index.js');
  const raw = [
    { number: '1, 4, 9', name: 'GND', type: 'power_in' }, { number: '2', name: 'INP', type: 'input' },
    { number: '3', name: 'INN', type: 'input' }, { number: '5', name: 'VCC1', type: 'power_in' },
    { number: '6, 8', name: 'NIC', type: 'no_connect' }, { number: '7', name: 'VCC2', type: 'power_in' },
    { number: '10', name: 'OUT', type: 'output' }, { number: '11, 12', name: 'GND', type: 'power_in' },
    { number: '13', name: 'VCCBIAS', type: 'power_in' }, { number: '14', name: 'LIN2', type: 'input' },
    { number: '15', name: 'MAIN2', type: 'input' }, { number: '16', name: 'ENP', type: 'input' },
    { number: 'EPAD', name: 'EPAD', type: 'passive' }
  ];
  const pins = sanitizePins(raw);
  assert.equal(pins.length, 17);
  assert.deepEqual(pins.map((p) => p.number), Array.from({ length: 17 }, (_, i) => String(i + 1)));
  // LFCSP → qfn，全链路生成不再拒绝
  const pkg = { name: 'LFCSP-16', type: 'LFCSP', family: guessFamily('LFCSP'), pinCount: 16, pitch: 0.5, bodyLength: 3, bodyWidth: 3, leadLength: 0.4, height: 0.75, epLength: 1.6, epWidth: 1.6 };
  const r = generateBundle({ part: { mpn: 'ADL6346B' }, items: [{ pkg, pins }] });
  assert.ok(r.items[0].files.kicadMod && r.items[0].files.wrl, 'LFCSP 应生成封装与 3D');
  assert.equal((r.items[0].files.kicadMod.match(/\(pad "/g) || []).length, 17);
  // legacy 符号格式良构：每个 X 行第 3 字段为纯编号（无空格逗号），渲染器可解析
  const xLines = r.symbols[0].legacyLib.split('\n').filter((l) => l.startsWith('X '));
  assert.equal(xLines.length, 17);
  for (const l of xLines) assert.match(l, /^X \S+ \d+ -?\d/, l);
});
