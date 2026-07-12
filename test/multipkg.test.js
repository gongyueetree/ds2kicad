// test/multipkg.test.js — 多封装/多 pinset：解析、归属、批量生成
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextPages } from '../lib/pdftext.js';
import { parsePinTable, assignPinsets } from '../lib/heuristics.js';
import { generateBundle } from '../lib/kicadgen/index.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

async function buildMultiColDatasheet() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  const t = (s, x, y, size = 10) => pg.drawText(s, { x, y, size, font });
  t('5 Pin Configuration and Functions', 60, 740, 12);
  // 列头：NAME | D, P, PW | DSBGA | I/O | DESCRIPTION（两个空格以上分列）
  t('NAME', 60, 715); t('D, P, PW', 140, 715); t('DSBGA', 240, 715); t('I/O', 320, 715); t('DESCRIPTION', 380, 715);
  const rows = [
    ['OUT1', '1', 'A1', 'O', 'Output, channel 1'],
    ['IN1-', '2', 'B1', 'I', 'Inverting input 1'],
    ['IN1+', '3', 'C1', 'I', 'Noninverting input 1'],
    ['GND', '4', 'C2', 'G', 'Ground'],
    ['IN2+', '5', 'C3', 'I', 'Noninverting input 2'],
    ['IN2-', '6', 'B3', 'I', 'Inverting input 2'],
    ['OUT2', '7', 'A3', 'O', 'Output, channel 2'],
    ['VCC', '8', 'A2', 'P', 'Positive supply']
  ];
  rows.forEach((r, i) => {
    const y = 690 - i * 18;
    t(r[0], 60, y); t(r[1], 140, y); t(r[2], 240, y); t(r[3], 320, y); t(r[4], 380, y);
  });
  t('6 Specifications', 60, 690 - rows.length * 18 - 10, 12);
  return Buffer.from(await doc.save());
}

test('多列管脚表：解析出 default + alt1 两个 pinset，列头作为 label', async () => {
  const buf = await buildMultiColDatasheet();
  const { pages } = await extractTextPages(buf);
  const r = parsePinTable(pages);
  assert.equal(r.multiColumn, true);
  assert.equal(r.pinsets.length, 2);
  const [d, a] = r.pinsets;
  assert.equal(d.pins.length, 8);
  assert.equal(a.pins.length, 8);
  assert.match(d.label, /D, ?P, ?PW/);
  assert.match(a.label, /DSBGA/);
  assert.equal(r.confidence, 'high');
  // 数字集与球号集内容一致但编号不同
  assert.equal(d.pins.find((p) => p.name === 'OUT1').number, '1');
  assert.equal(a.pins.find((p) => p.name === 'OUT1').number, 'A1');
  assert.equal(d.pins.find((p) => p.name === 'GND').type, 'power_in');
});

test('assignPinsets：按列头 token 匹配 tiCode/type，未命中回退 default', async () => {
  const buf = await buildMultiColDatasheet();
  const { pages } = await extractTextPages(buf);
  const { pinsets } = parsePinTable(pages);
  const pkgs = assignPinsets([
    { name: 'SOIC-8', tiCode: 'D', type: 'SOIC' },
    { name: 'PDIP-8', tiCode: 'P', type: 'PDIP' },
    { name: 'TSSOP-8', tiCode: 'PW', type: 'TSSOP' },
    { name: 'DSBGA-8', tiCode: 'YPB', type: 'DSBGA' },
    { name: '未知', tiCode: 'ZZZ', type: 'MYSTERY' }
  ], pinsets);
  assert.equal(pkgs[0].pinsetId, 'default');
  assert.equal(pkgs[1].pinsetId, 'default');
  assert.equal(pkgs[2].pinsetId, 'default');
  assert.equal(pkgs[3].pinsetId, 'alt1');   // DSBGA 命中 alt1 label
  assert.equal(pkgs[4].pinsetId, 'default'); // 未命中回退
});

test('generateBundle：pinset 相同共享符号，不同出变体；每封装各出封装+3D；BGA 仅符号', () => {
  const pinsNum = [
    { number: '1', name: 'OUT1', type: 'output' }, { number: '2', name: 'IN1-', type: 'input' },
    { number: '3', name: 'IN1+', type: 'input' }, { number: '4', name: 'GND', type: 'power_in' },
    { number: '5', name: 'IN2+', type: 'input' }, { number: '6', name: 'IN2-', type: 'input' },
    { number: '7', name: 'OUT2', type: 'output' }, { number: '8', name: 'VCC', type: 'power_in' }
  ];
  const pinsBall = pinsNum.map((p, i) => ({ ...p, number: ['A1','B1','C1','C2','C3','B3','A3','A2'][i] }));
  const mk = (name, tiCode, type, family, extra = {}) =>
    ({ name, tiCode, type, family, pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, height: 1.5, leadSpan: 6, leadLength: 1, rowSpan: 7.62, ...extra });
  const r = generateBundle({
    part: { mpn: 'LM358', title: 'Dual operational amplifier' },
    items: [
      { pkg: mk('SOIC-8', 'D', 'SOIC', 'dual'), pins: pinsNum },
      { pkg: mk('PDIP-8', 'P', 'PDIP', 'dip'), pins: pinsNum },
      { pkg: mk('DSBGA-8', 'YPB', 'DSBGA', 'bga'), pins: pinsBall }
    ]
  });
  // 符号：数字集共享 LM358，球号集变体 LM358_YPB
  assert.equal(r.symbols.length, 2);
  assert.equal(r.symbols[0].name, 'LM358');
  assert.deepEqual(r.symbols[0].packages, ['SOIC-8', 'PDIP-8']);
  assert.equal(r.symbols[1].name, 'LM358_YPB');
  // 合并库含两个符号定义
  assert.equal((r.files.kicadSym.match(/\(symbol "LM358(_YPB)?" /g) || []).length, 2);
  assert.ok(r.files.kicadSym.includes('(number "A1"'), '变体符号应含球号管脚');
  // 每封装文件
  assert.equal(r.items.length, 3);
  assert.ok(r.items[0].files.kicadMod.includes('smd'), 'SOIC 为贴片');
  assert.ok(r.items[1].files.kicadMod.includes('thru_hole'), 'PDIP 为通孔');
  assert.equal(r.items[2].files.kicadMod, undefined, 'BGA 无封装文件');
  assert.ok(r.warnings.some((w) => /BGA/.test(w)));
  // 文件名互不冲突
  assert.notEqual(r.items[0].names.kicadMod, r.items[1].names.kicadMod);
});

test('generateBundle：mock 双封装（WQFN 含 EP / TSSOP 无 EP）→ 两个符号变体', () => {
  const m = MOCK_TMUXL27518;
  const sets = Object.fromEntries(m.pinsets.map((s) => [s.id, s.pins]));
  const r = generateBundle({
    part: m.part,
    items: m.packages.map((p) => ({ pkg: { ...p, family: p.tiCode === 'PW' ? 'dual' : 'qfn' }, pins: sets[p.pinsetId] }))
  });
  assert.equal(r.symbols.length, 2, 'EP 差异应产生两个符号');
  assert.equal(r.items.length, 2);
  assert.ok(r.items.every((it) => it.files.kicadMod && it.files.wrl));
});

test('联动高亮前提：符号 legacy 与封装 mod 均含可对应的管脚标识；bundle.symbols 携带 pins', () => {
  const m = MOCK_TMUXL27518;
  const sets = Object.fromEntries(m.pinsets.map((s) => [s.id, s.pins]));
  const r = generateBundle({
    part: m.part,
    items: m.packages.map((p) => ({ pkg: { ...p, family: p.tiCode === 'PW' ? 'dual' : 'qfn' }, pins: sets[p.pinsetId] }))
  });
  // symbols 携带 pins（供联动信息条显示名称/类型）
  assert.ok(r.symbols[0].pins?.length === 25);
  // 同一管脚编号在 legacy 符号与 .kicad_mod 中都存在 → data-pin 可一一对应
  for (const num of ['1', '13', '25']) {
    assert.match(r.symbols[0].legacyLib, new RegExp(`^X \\S+ ${num} `, 'm'));
    assert.ok(r.items[0].files.kicadMod.includes(`(pad "${num}"`));
  }
});
