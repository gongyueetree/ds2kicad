// test/kicadgen.test.js — 生成引擎与防御性解析单元测试（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAll } from '../lib/kicadgen/index.js';
import { generateFootprint } from '../lib/kicadgen/footprint.js';
import { repairJSON } from '../lib/gemini.js';
import { sanitizePins, sanitizePackage, sanitizeFigures, validatePdfUrl, guessFamily } from '../lib/validate.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

const mockInput = () => ({
  part: MOCK_TMUXL27518.part,
  pkg: { ...MOCK_TMUXL27518.packages[0], family: guessFamily(MOCK_TMUXL27518.packages[0].type) },
  pins: MOCK_TMUXL27518.pins
});

test('generateAll 产出全部四种文件且非空', () => {
  const r = generateAll(mockInput());
  for (const k of ['kicadSym', 'legacyLib', 'kicadMod', 'wrl']) {
    assert.ok(r.files[k]?.length > 100, `${k} 应非空`);
  }
  assert.equal(r.names.kicadSym, 'TMUXL27518.kicad_sym');
});

test('符号：所有 25 个管脚（含 EP）都出现在 kicad_sym 与 legacy lib', () => {
  const r = generateAll(mockInput());
  for (const p of MOCK_TMUXL27518.pins) {
    assert.ok(r.files.kicadSym.includes(`(number "${p.number}"`), `kicad_sym 缺管脚 ${p.number}`);
    assert.match(r.files.legacyLib, new RegExp(`^X \\S+ ${p.number} `, 'm'), `legacy lib 缺管脚 ${p.number}`);
  }
});

test('符号：电源在顶、地在底、控制在左（legacy 坐标方向验证）', () => {
  const r = generateAll(mockInput());
  const rows = r.files.legacyLib.split('\n').filter((l) => l.startsWith('X '));
  const get = (name) => rows.find((l) => l.startsWith(`X ${name} `)).split(/\s+/);
  assert.equal(get('VCC')[6], 'D', 'VCC 应从顶部向下(D)');
  assert.equal(get('GND')[6], 'U', 'GND 应从底部向上(U)');
  assert.equal(get('EN')[6], 'R', 'EN 应在左侧向右(R)');
  assert.equal(get('COM1')[6], 'L', 'COM1 应在右侧向左(L)');
});

test('QFN-24 封装：24 个信号焊盘 + 1 个 EP，1 脚在左上且逆时针编号', () => {
  const r = generateAll(mockInput());
  const pads = [...r.files.kicadMod.matchAll(/\(pad "([^"]+)" smd \S+ \(at ([-\d.]+) ([-\d.]+)/g)]
    .map((m) => ({ num: m[1], x: +m[2], y: +m[3] }));
  assert.equal(pads.length, 25, '应有 24 信号 + 1 EP');
  const p1 = pads.find((p) => p.num === '1');
  assert.ok(p1.x < 0 && p1.y < 0, '1 脚应在左上象限');
  const p7 = pads.find((p) => p.num === '7');   // 底行第一个
  assert.ok(p7.y > 0 && p7.x < 0, '7 脚应在底行左端');
  const p13 = pads.find((p) => p.num === '13'); // 右列最下
  assert.ok(p13.x > 0 && p13.y > 0, '13 脚应在右列下端');
  const p19 = pads.find((p) => p.num === '19'); // 顶行右端
  assert.ok(p19.y < 0 && p19.x > 0, '19 脚应在顶行右端');
  const ep = pads.find((p) => p.num === '25');
  assert.ok(ep && ep.x === 0 && ep.y === 0, 'EP(25) 应居中');
});

test('dual 封装（TSSOP-24）：左列 1-12 自上而下，右列 24-13', () => {
  const r = generateAll({ ...mockInput(), pkg: { ...MOCK_TMUXL27518.packages[1], family: 'dual' }, pins: MOCK_TMUXL27518.pins.slice(0, 24) });
  const pads = [...r.files.kicadMod.matchAll(/\(pad "([^"]+)" smd \S+ \(at ([-\d.]+) ([-\d.]+)/g)]
    .map((m) => ({ num: m[1], x: +m[2], y: +m[3] }));
  assert.equal(pads.length, 24);
  const p1 = pads.find((p) => p.num === '1');
  const p12 = pads.find((p) => p.num === '12');
  const p13 = pads.find((p) => p.num === '13');
  const p24 = pads.find((p) => p.num === '24');
  assert.ok(p1.x < 0 && p1.y < 0, '1 脚左上');
  assert.ok(p12.x < 0 && p12.y > 0, '12 脚左下');
  assert.ok(p13.x > 0 && Math.abs(p13.y - p12.y) < 1e-6, '13 与 12 同一行（逆时针）');
  assert.ok(p24.x > 0 && Math.abs(p24.y - p1.y) < 1e-6, '24 与 1 同一行');
  // 焊盘不与邻位重叠：padW < pitch
  const padW = +r.files.kicadMod.match(/\(pad "2" smd \S+ \(at [-\d. ]+\) \(size [\d.]+ ([\d.]+)\)/)[1];
  assert.ok(padW < 0.65, `焊盘宽 ${padW} 应小于 pitch 0.65`);
});

test('WRL：VRML 头 + 至少 body/引脚节点，KiCad 缩放（本体 X≈4mm/2.54）', () => {
  const r = generateAll(mockInput());
  assert.ok(r.files.wrl.startsWith('#VRML V2.0 utf8'));
  const boxes = r.files.wrl.match(/geometry Box/g) || [];
  assert.ok(boxes.length >= 25, `QFN-24 应有本体+24 引脚+EP ≥ 26 个盒，实际 ${boxes.length}`);
  const bodyBox = r.files.wrl.match(/Box \{ size ([\d.]+) [\d.]+ ([\d.]+) \}/);
  assert.ok(Math.abs(+bodyBox[1] - (4.0 * 0.98) / 2.54) < 0.01, '本体 X 应按 1/2.54 缩放');
});

test('generateAll：管脚数不一致给出 warning 而非抛错', () => {
  const inp = mockInput();
  inp.pins = inp.pins.slice(0, 20);
  const r = generateAll(inp);
  assert.ok(r.warnings.some((w) => w.includes('不一致')));
});

test('QFN 引脚数非 4 倍数 → 阻断生成且不可晋升（v0.8.1：不再以 dual 近似冒充）', () => {
  const inp = mockInput();
  inp.pkg = { ...inp.pkg, pinCount: 22 };
  inp.pins = inp.pins.slice(0, 22);
  const r = generateAll(inp);
  assert.ok(r.warnings.some((w) => /4 的倍数/.test(w) && /blocked_missing_geometry/.test(w)));
  assert.equal(r.files.kicadMod, undefined, '不得产出封装文件');
  assert.equal(r.nonPromotable, true);
});

test('DIP 封装生成通孔焊盘', () => {
  const pins = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive', description: '' }));
  const r = generateAll({ part: { mpn: 'NE555' }, pkg: { name: 'DIP-8', type: 'PDIP', family: 'dip', pinCount: 8, pitch: 2.54, bodyLength: 9.8, bodyWidth: 6.35, height: 3.3, rowSpan: 7.62 }, pins });
  assert.ok(r.files.kicadMod.includes('thru_hole'));
  assert.equal((r.files.kicadMod.match(/\(pad "/g) || []).length, 8);
});

test('repairJSON：修复围栏、截断的括号与字符串', () => {
  assert.deepEqual(repairJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(repairJSON('{"a":[1,2,{"b":"x'), { a: [1, 2, { b: 'x' }] });
  assert.deepEqual(repairJSON('前言 {"pins":[{"n":"1"},{"n":"2"'), { pins: [{ n: '1' }, { n: '2' }] });
  assert.throws(() => repairJSON('no json here'));
});

test('validatePdfUrl：拒绝内网与非 http', () => {
  assert.ok(validatePdfUrl('https://www.ti.com/lit/ds/symlink/x.pdf').ok);
  assert.ok(!validatePdfUrl('http://127.0.0.1/a.pdf').ok);
  assert.ok(!validatePdfUrl('http://192.168.1.5/a.pdf').ok);
  assert.ok(!validatePdfUrl('ftp://x.com/a.pdf').ok);
  assert.ok(!validatePdfUrl('not a url').ok);
});

test('sanitizePins：排序、类型回退、编号字符串化', () => {
  const pins = sanitizePins([
    { number: 10, name: 'B', type: 'weird' },
    { number: 2, name: 'A', type: 'input' }
  ]);
  assert.equal(pins[0].number, '2');
  assert.equal(pins[1].type, 'unspecified');
});

test('sanitizePackage / guessFamily / sanitizeFigures 边界', () => {
  assert.equal(guessFamily('WQFN'), 'qfn');
  assert.equal(guessFamily('TSSOP'), 'dual');
  assert.equal(guessFamily('PDIP'), 'dip');
  const p = sanitizePackage({ type: 'WQFN', pinCount: 24, pitch: 0.5 });
  assert.equal(p.family, 'qfn');
  const figs = sanitizeFigures([{ kind: 'block_diagram', page: 0, bbox: [0.9, 0.5, 0.2, 0.4] }]);
  assert.equal(figs[0].page, 1);
  assert.ok(figs[0].bbox[2] > figs[0].bbox[0] && figs[0].bbox[3] > figs[0].bbox[1]);
});
