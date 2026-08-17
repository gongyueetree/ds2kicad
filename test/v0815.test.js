// test/v0815.test.js — 针对 2026-08-05 测试报告缺陷的回归用例
// 覆盖 DSK-001 / DSK-002 / DSK-003 / DSK-005 / DSK-006 / DSK-010 / DSK-012
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePackage, sanitizePinsDetailed, parseRowSpanFromName, snapDipRowSpan } from '../lib/validate.js';
import { lintPinNames, fixOZero, looksLikeFootnote } from '../lib/pinlint.js';
import { generateBundle } from '../lib/kicadgen/index.js';
import { wrapLegacyLibrary } from '../lib/kicadgen/symbol.js';
import { assembleAssets } from '../lib/assets.js';
import { reclassifyByTitle, filterFiguresDetailed } from '../lib/figfilter.js';

/* ══════════ DSK-010：DIP 孔距（生产阻断项）══════════ */

test('DSK-010 封装名解析：400 mil → 10.16mm', () => {
  assert.equal(parseRowSpanFromName('DIP-6 (400 mil)'), 10.16);
  assert.equal(parseRowSpanFromName('CNY17F_DIP-6__400_mil__W7.62mm_P2.54mm'), 10.16, 'mil 标称优先于 KLC 的 W 后缀');
  assert.equal(parseRowSpanFromName('DIP-40 (600 mil)'), 15.24);
  assert.equal(parseRowSpanFromName('PDIP-16'), null);
  assert.equal(parseRowSpanFromName('SOIC-8'), null);
  assert.equal(snapDipRowSpan(10.2), 10.16, '手册常写 10.2，应吸附到标准 400 mil');
});

test('DSK-010 复现缺陷：400 mil DIP 不得再回落成 7.62', () => {
  // 现场输入：AI 给了 leadSpan=10.16，但没给 rowSpan
  const p = sanitizePackage({
    name: 'DIP-6 (400 mil)', type: 'DIP', pinCount: 6, pitch: 2.54,
    bodyLength: 9.5, bodyWidth: 6.4, height: 4.2, leadSpan: 10.16
  });
  assert.equal(p.family, 'dip');
  assert.equal(p.rowSpan, 10.16, `修复前这里会是默认值 7.62，实际 ${p.rowSpan}`);
  assert.notEqual(p.rowSpan, 7.62);
});

test('DSK-010 名称与几何矛盾时以手册标称为准并留痕', () => {
  const p = sanitizePackage({
    name: 'DIP-6 (400 mil)', type: 'DIP', pinCount: 6, pitch: 2.54,
    bodyLength: 9.5, bodyWidth: 6.4, height: 4.2, rowSpan: 7.62   // 显式给了矛盾值
  });
  assert.equal(p.rowSpan, 10.16, '“400 mil 却 7.62mm”是物理矛盾，名称胜出');
  assert.equal(p.fieldProvenance.rowSpan.source, 'corrected');
  assert.match(p.fieldProvenance.rowSpan.reason, /row_span_contradicts_package_name/);
});

test('DSK-010 焊盘坐标断言：.kicad_mod 与 WRL 的引脚行距必须一致且等于 10.16', () => {
  const pkg = sanitizePackage({
    name: 'DIP-6 (400 mil)', type: 'DIP', pinCount: 6, pitch: 2.54,
    bodyLength: 9.5, bodyWidth: 6.4, height: 4.2, leadSpan: 10.16
  });
  const pins = Array.from({ length: 6 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const b = generateBundle({ part: { mpn: 'CNY17F' }, items: [{ pkg, pins }] });
  const mod = b.items[0].files.kicadMod;
  assert.ok(mod, '应生成封装');

  // 逐个焊盘读取 X 坐标，左右两列中心距即孔距
  const xs = [...mod.matchAll(/\(pad "(\d+)" thru_hole [^\n]*?\(at (-?[\d.]+) (-?[\d.]+)\)/g)]
    .map((m) => Number(m[2]));
  assert.ok(xs.length >= 6, `应有 6 个焊盘，实际 ${xs.length}`);
  const span = Math.max(...xs) - Math.min(...xs);
  assert.ok(Math.abs(span - 10.16) < 0.01, `焊盘行距应为 10.16mm，实际 ${span.toFixed(3)}mm`);

  // 文件名后缀必须与几何一致，不能名字写 400 mil 而几何是 300 mil
  assert.match(b.items[0].names.kicadMod, /W10\.16mm/, `文件名与几何必须同源：${b.items[0].names.kicadMod}`);

  // WRL 两排引脚中心距同样为 10.16（KiCad 比例 1 unit = 2.54mm）
  const wrl = b.items[0].files.wrl;
  assert.ok(wrl, '应生成 WRL');
  const tx = [...wrl.matchAll(/translation\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const halfUnits = Math.max(...tx.map(Math.abs));
  assert.ok(Math.abs(halfUnits * 2 * 2.54 - 10.16) < 0.05,
    `WRL 引脚行距应为 10.16mm，实际 ${(halfUnits * 2 * 2.54).toFixed(3)}mm`);
});

test('DSK-010 不得误伤：未标 mil 的普通 DIP 仍走既有默认', () => {
  const p = sanitizePackage({ name: 'PDIP-8', type: 'DIP', pinCount: 8, pitch: 2.54, bodyLength: 9.8, bodyWidth: 6.4, height: 4 });
  assert.equal(p.rowSpan, 7.62, '无任何线索时保持 300 mil 默认');
});

/* ══════════ DSK-001：符号变体重名导致 422 哈希不一致 ══════════ */

test('DSK-001 复现缺陷：两个 pinset 的封装类型相同会撞出同名符号', () => {
  const mk = (type, names) => ({
    pkg: sanitizePackage({ name: type, type, pinCount: names.length, pitch: 0.95, bodyLength: 2.9, bodyWidth: 1.6, height: 1.1, leadSpan: 2.8 }),
    pins: names.map((n, i) => ({ number: String(i + 1), name: n, type: 'passive' }))
  });
  // AP2112 有 4 个 pinset，封装类型同为 SOT-25。旧实现 symbolVariantName 只对
  // 「第一个」特殊处理：g1='AP2112'，g2/g3/g4 全叫 'AP2112_SOT25' → 三者撞名。
  // 因此必须用 3 个以上分组才能复现；两个分组是撞不出来的。
  const b = generateBundle({
    part: { mpn: 'AP2112' },
    items: [
      mk('SOT-25', ['VIN', 'GND', 'EN', 'NC', 'VOUT']),
      mk('SOT-25', ['VIN', 'GND', 'EN', 'ADJ', 'VOUT']),
      mk('SOT-25', ['VIN', 'GND', 'EN', 'BYP', 'VOUT']),
      mk('SOT-25', ['VIN', 'GND', 'SHDN', 'BYP', 'VOUT'])
    ]
  });
  const names = b.symbols.map((s) => s.name);
  assert.equal(names.length, 4, '四个不同 pinset 应产出四个符号变体');
  assert.equal(new Set(names).size, 4, `符号名必须唯一，实际 ${JSON.stringify(names)}`);

  // 端到端：装配不得抛「资产路径冲突」，且 .lib 路径互不重复
  const out = assembleAssets({ ir: { packages: [], figures: [] }, bundle: b, job: { jobId: 'j', revision: 1 } });
  const libs = out.files.filter((f) => f.path.endsWith('.lib')).map((f) => f.path);
  assert.equal(new Set(libs).size, libs.length, `.lib 路径必须唯一，实际 ${JSON.stringify(libs)}`);
});

test('DSK-001 资产装配：同名不同内容必须报出精确冲突，而非语焉不详的哈希不一致', () => {
  const bundle = {
    files: { kicadSym: '(kicad_symbol_lib)' }, names: { kicadSym: 'X.kicad_sym' },
    symbols: [
      { name: 'DUP', legacyLib: 'DEF DUP U 0 40 Y Y 1 F N\nDRAW\nENDDRAW\nENDDEF', packages: [], packageIds: [], pinsetIds: [] },
      { name: 'DUP', legacyLib: 'DEF DUP U 0 40 Y Y 1 F N\nDRAW\nS 0 0 1 1 0 1 10 f\nENDDRAW\nENDDEF', packages: [], packageIds: [], pinsetIds: [] }
    ],
    items: [], warnings: [], mock: false
  };
  assert.throws(
    () => assembleAssets({ ir: { packages: [], figures: [] }, bundle, job: { jobId: 'j', revision: 1 } }),
    /资产路径冲突/,
    '必须指出是路径冲突（符号重名），而不是让它烂到 verifyConsistency 变成哈希不一致'
  );
});

/* ══════════ DSK-002：旧版 .lib 不是完整库 ══════════ */

test('DSK-002 旧版 .lib 必须带库头与库尾', () => {
  const def = 'DEF TMUXL27518 U 0 40 Y Y 1 F N\nDRAW\nS -100 -100 100 100 0 1 10 f\nENDDRAW\nENDDEF';
  const lib = wrapLegacyLibrary(def, { name: 'TMUXL27518' });
  const lines = lib.split('\n');
  assert.equal(lines[0], 'EESchema-LIBRARY Version 2.4', 'KiCad CLI 靠首行识别库文件');
  assert.equal(lines[1], '#encoding utf-8');
  assert.ok(lib.includes('#End Library'), '缺库尾会导致 Unable to convert library');
  assert.ok(lib.indexOf('DEF TMUXL27518') > 0 && lib.includes('ENDDEF'));
  // DRAW…ENDDRAW 区段必须原样保留，否则在线 Viewer 渲染会坏
  assert.ok(/DRAW\nS -100 -100 100 100 0 1 10 f\nENDDRAW/.test(lib));
});

test('DSK-002 装配出的 .lib 是完整库而非裸 DEF 片段', () => {
  const bundle = {
    files: { kicadSym: '(kicad_symbol_lib)' }, names: { kicadSym: 'X.kicad_sym' },
    symbols: [{ name: 'X', legacyLib: 'DEF X U 0 40 Y Y 1 F N\nDRAW\nENDDRAW\nENDDEF', packages: [], packageIds: [], pinsetIds: [] }],
    items: [], warnings: [], mock: false
  };
  const out = assembleAssets({ ir: { packages: [], figures: [] }, bundle, job: { jobId: 'j', revision: 1 } });
  const lib = out.files.find((f) => f.path.endsWith('.lib'));
  assert.ok(lib, '应产出 .lib');
  assert.ok(lib.content.startsWith('EESchema-LIBRARY Version 2.4'), `实际开头：${lib.content.slice(0, 40)}`);
  assert.ok(lib.content.includes('#End Library'));
  // 哈希必须对应包装后的内容
  assert.equal(lib.bytes, Buffer.byteLength(lib.content, 'utf8'));
});

/* ══════════ DSK-005 / DSK-006：管脚名规则校验 ══════════ */

test('DSK-005 OCR 字母 O 被读成数字 0 的确定性修正', () => {
  assert.equal(fixOZero('GPI046'), 'GPIO46');
  assert.equal(fixOZero('GPI046/XTAL_32K_P'), 'GPIO46/XTAL_32K_P');
  assert.equal(fixOZero('V0UT'), 'VOUT');
});

test('DSK-005 修正必须真正接入提取链路（而不只是个孤立的纯函数）', () => {
  const r = sanitizePinsDetailed([{ number: '16', name: 'GPI046', type: 'bidirectional' }]);
  assert.equal(r.pins[0].name, 'GPIO46', '提取结果里就必须已经是 GPIO46');
  const fix = r.pinIssues.find((i) => i.op === 'pin_name_ocr_corrected');
  assert.ok(fix, '自动修正必须留痕');
  assert.equal(fix.from, 'GPI046');
  assert.equal(fix.to, 'GPIO46');
  assert.equal(r.reviewRequired, true, '自动修正过的管脚必须进入人工复核');
});

test('DSK-005 不得误伤合法名：VDD0 / P0 / IO0 必须原样保留', () => {
  for (const n of ['VDD0', 'P0', 'IO0', 'GPIO46', 'VOUT', 'D0', 'CH0']) {
    assert.equal(fixOZero(n), n, `${n} 被错误改写`);
  }
});

test('DSK-006 重名管脚（低有效标记丢失）必须被标记且不被改写', () => {
  const r = sanitizePinsDetailed([
    { number: '11', name: 'SUSPEND', type: 'output' },
    { number: '12', name: 'SUSPEND', type: 'output' }
  ]);
  const dup = r.pinIssues.find((i) => i.op === 'duplicate_pin_name');
  assert.ok(dup, '必须报出重名');
  assert.deepEqual(dup.numbers, ['11', '12']);
  assert.equal(dup.reason, 'possible_lost_active_low_marker');
  assert.equal(r.reviewRequired, true, '必须要求人工复核');
  // 不猜哪一个该带低有效标记
  assert.deepEqual(r.pins.map((p) => p.name), ['SUSPEND', 'SUSPEND']);
});

test('DSK-006 电源/地/NC 重名属正常，不得误报', () => {
  const r = sanitizePinsDetailed([
    { number: '1', name: 'GND', type: 'power_in' }, { number: '2', name: 'GND', type: 'power_in' },
    { number: '3', name: 'VDD', type: 'power_in' }, { number: '4', name: 'VDD', type: 'power_in' },
    { number: '5', name: 'NC', type: 'no_connect' }, { number: '6', name: 'NC', type: 'no_connect' }
  ]);
  assert.equal(r.pinIssues.filter((i) => i.op === 'duplicate_pin_name').length, 0);
});

test('DSK-006 脚注上标混入名称：只标记不改写', () => {
  assert.equal(looksLikeFootnote('NC1/Vpp2'), true);
  assert.equal(looksLikeFootnote('VDD/VDDIO'), false, '正常复用名不得误报');
  assert.equal(looksLikeFootnote('SCL'), false);
  const r = sanitizePinsDetailed([{ number: '18', name: 'NC1/Vpp2', type: 'passive' }]);
  assert.ok(r.pinIssues.some((i) => i.op === 'possible_footnote_in_pin_name'));
  assert.equal(r.pins[0].name, 'NC1/Vpp2', '不得擅自删数字');
});

test('DSK-005 曝光焊盘命名语义需人工确认', () => {
  const { issues } = lintPinNames([{ number: '41', name: 'EPAD', type: 'passive' }]);
  assert.ok(issues.some((i) => i.op === 'exposed_pad_name_unverified'));
});

/* ══════════ DSK-012：图区类型误分 ══════════ */

test('DSK-012 激光标记图不得因命中 "top view" 被判为引脚排布图', () => {
  const out = reclassifyByTitle([
    { kind: 'pin_configuration', title: 'Figure 13 Top view of the SHT3x-DIS illustrating the laser marking.', page: 16, bbox: [0, 0, 1, 1] }
  ]);
  assert.equal(out[0].kind, 'package_outline');
  assert.equal(out[0].kindReclassified.from, 'pin_configuration');
  assert.equal(out[0].kindReclassified.rule, 'title_marking');
});

test('DSK-012 真正的引脚排布图不得被误改', () => {
  const out = reclassifyByTitle([
    { kind: 'pin_configuration', title: 'Figure 4-1. RTW Package 24-Pin WQFN Top View', page: 3, bbox: [0, 0, 1, 1] }
  ]);
  assert.equal(out[0].kind, 'pin_configuration');
  assert.equal(out[0].kindReclassified, undefined);
});

test('DSK-012 重分类接入过滤主链路', () => {
  const { figures } = filterFiguresDetailed([
    { kind: 'pin_configuration', title: 'Top view of the device illustrating the laser marking', page: 16, bbox: [0, 0, 1, 1] }
  ], { pkgCount: 1 });
  const f = figures.find((x) => x.page === 16);
  if (f) assert.equal(f.kind, 'package_outline', '进入图集时类型必须已被纠正');
});

/* ══════════ DSK-003：不支持的封装家族必须可在生成前识别 ══════════ */

test('DSK-003 不支持家族在提取阶段即带出 familySupported=false 与原因', () => {
  for (const [type, name] of [['LGA', 'LGA-8'], ['Module', 'ESP32-S3-WROOM-1'], ['PLCC', 'PLCC-44']]) {
    const p = sanitizePackage({ name, type, pinCount: 8, pitch: 0.8, bodyLength: 2.5, bodyWidth: 2.5, height: 0.9 });
    assert.equal(p.familySupported, false, `${type} 应标为不支持，实际 family=${p.family}`);
    assert.ok(p.familyProvenance, '必须带家族判定来源，供界面解释');
  }
});

test('DSK-003 受支持家族不得被误判', () => {
  for (const [type, name] of [['SOIC', 'SOIC-8'], ['QFN', 'WQFN-24'], ['DIP', 'PDIP-8'], ['TSSOP', 'TSSOP-14']]) {
    const p = sanitizePackage({ name, type, pinCount: 8, pitch: 0.65, bodyLength: 5, bodyWidth: 4.4, height: 1.2, leadSpan: 6.4 });
    assert.equal(p.familySupported, true, `${type} 应受支持，实际 family=${p.family}`);
  }
});

/* ══════════ DSK-013：图区候选合并（稳定性）══════════ */

test('DSK-013 解析器结果永远保留，AI 只补充；同页同类型以解析器为准', async () => {
  const { mergeFigureCandidates } = await import('../lib/figfilter.js');
  const parser = [{ page: 1, kind: 'pin_configuration', title: 'P-pin', bbox: [0, 0, 1, 1] }];
  const ai = [
    { page: 1, kind: 'pin_configuration', title: 'AI 版本（应被丢弃）', bbox: [0.1, 0.1, 0.9, 0.9] },
    { page: 7, kind: 'package_outline', title: 'AI 补充的封装图', bbox: [0, 0, 1, 1] }
  ];
  const out = mergeFigureCandidates(parser, ai);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'P-pin', '同页同类型必须保留解析器那一份');
  assert.equal(out[0].candidateSource, 'parser');
  assert.equal(out[1].candidateSource, 'gemini', 'AI 只补充解析器没找到的');
});

test('DSK-013 复现缺陷：AI 时有时无，但解析器结果不得随之消失', async () => {
  const { mergeFigureCandidates } = await import('../lib/figfilter.js');
  const parser = [
    { page: 1, kind: 'pin_configuration', title: 'CNY17F pin config', bbox: [0, 0, 1, 1] },
    { page: 7, kind: 'package_outline', title: 'CNY17F package outline', bbox: [0, 0, 1, 1] }
  ];
  // 第一次 AI 返回两张，第二次一张都没返回（现场：2 张 vs 0 张）
  const run1 = mergeFigureCandidates(parser, [{ page: 3, kind: 'application', title: 'AI app', bbox: [0, 0, 1, 1] }]);
  const run2 = mergeFigureCandidates(parser, []);
  const stable = (list) => list.filter((f) => f.candidateSource === 'parser').map((f) => `${f.page}|${f.kind}`);
  assert.deepEqual(stable(run1), stable(run2), '确定性部分必须两次完全一致');
  assert.equal(stable(run2).length, 2, '旧实现在 AI 有结果时会整体丢掉解析器的两张');
});

test('DSK-013 输出顺序稳定：与上游数组顺序无关', async () => {
  const { mergeFigureCandidates } = await import('../lib/figfilter.js');
  const a = [{ page: 7, kind: 'package_outline', title: 'B', bbox: [0, 0, 1, 1] }, { page: 1, kind: 'block_diagram', title: 'A', bbox: [0, 0, 1, 1] }];
  const b = [...a].reverse();
  const k = (l) => mergeFigureCandidates(l, []).map((f) => `${f.page}|${f.kind}`).join(',');
  assert.equal(k(a), k(b));
  assert.equal(k(a), '1|block_diagram,7|package_outline', '按页码 + 类型稳定排序');
});

/* ══════════ DSK-014：QFN 3D 端子被本体吞没（看起来"连在一起"）══════════ */

/** 从 WRL 里解析所有 Box 节点（毫米） */
function wrlBoxes(wrl) {
  return [...wrl.matchAll(/translation (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) children.*?Box \{ size ([\d.]+) ([\d.]+) ([\d.]+)/g)]
    .map((m) => ({
      x: +m[1] * 2.54, y: +m[2] * 2.54, z: +m[3] * 2.54,
      sx: +m[4] * 2.54, sy: +m[5] * 2.54, sz: +m[6] * 2.54
    }));
}
const qfnPkg = () => sanitizePackage({
  name: 'WQFN-24', type: 'WQFN', pinCount: 24, pitch: 0.5,
  bodyLength: 4, bodyWidth: 4, height: 0.8, leadLength: 0.4, epLength: 2.45, epWidth: 2.45
});

test('DSK-014 复现缺陷：QFN 端子不得与本体竖直互穿', async () => {
  const { generateWrl } = await import('../lib/kicadgen/model3d.js');
  const boxes = wrlBoxes(generateWrl({ pkg: qfnPkg() }));
  const body = boxes.reduce((a, c) => (c.sx * c.sz > a.sx * a.sz ? c : a));
  const terms = boxes.filter((b) => b !== body);
  const bodyBottom = body.y - body.sy / 2;
  const termTop = Math.max(...terms.map((t) => t.y + t.sy / 2));
  assert.ok(termTop <= bodyBottom + 0.01,
    `端子顶(${termTop.toFixed(3)}mm) 高于本体底(${bodyBottom.toFixed(3)}mm) → 端子被埋进环氧，只剩边缘可见`);
});

test('DSK-014 端子必须离散：相邻端子之间有正缝隙', async () => {
  const { generateWrl } = await import('../lib/kicadgen/model3d.js');
  const boxes = wrlBoxes(generateWrl({ pkg: qfnPkg() }));
  const body = boxes.reduce((a, c) => (c.sx * c.sz > a.sx * a.sz ? c : a));
  // 左列端子的 x 恒为 -(bodyLength/2 - leadLength/2) = -1.8；
  // 不能只按 "x < -1" 过滤 —— 上下两排最外侧的端子 x 也到 -1.25，会被误收进来。
  const left = boxes.filter((b) => b !== body && Math.abs(b.x + 1.8) < 0.02).sort((a, c) => a.z - c.z);
  assert.equal(left.length, 6, `WQFN-24 每边应 6 个端子，实际 ${left.length}`);
  for (let i = 1; i < left.length; i++) {
    const gap = (left[i].z - left[i].sz / 2) - (left[i - 1].z + left[i - 1].sz / 2);
    assert.ok(gap > 0.05, `第 ${i} 与第 ${i + 1} 个端子缝隙仅 ${gap.toFixed(3)}mm，会看成连在一起`);
  }
});

test('DSK-014 EP 必须可见（与端子同层），不得埋进本体', async () => {
  const { generateWrl } = await import('../lib/kicadgen/model3d.js');
  const boxes = wrlBoxes(generateWrl({ pkg: qfnPkg() }));
  const body = boxes.reduce((a, c) => (c.sx * c.sz > a.sx * a.sz ? c : a));
  const ep = boxes.find((b) => b !== body && Math.abs(b.x) < 0.01 && Math.abs(b.z) < 0.01);
  assert.ok(ep, '应存在 EP 节点');
  assert.ok(ep.y + ep.sy / 2 <= body.y - body.sy / 2 + 0.01, 'EP 不得埋在本体内部');
  assert.ok(Math.abs(ep.sx - 2.45) < 0.01 && Math.abs(ep.sz - 2.45) < 0.01, 'EP 尺寸应取手册值');
});

test('DSK-014 总高仍等于手册标称（端子层 + 本体，不得溢出）', async () => {
  const { generateWrl } = await import('../lib/kicadgen/model3d.js');
  const boxes = wrlBoxes(generateWrl({ pkg: qfnPkg() }));
  const top = Math.max(...boxes.map((b) => b.y + b.sy / 2));
  const bottom = Math.min(...boxes.map((b) => b.y - b.sy / 2));
  assert.ok(Math.abs(top - 0.8) < 0.02, `总高应为 0.8mm，实际 ${top.toFixed(3)}`);
  assert.ok(Math.abs(bottom) < 0.01, `底面应落在 y=0，实际 ${bottom.toFixed(4)}mm`);   // WRL 按 1/2.54 缩放并 toFixed(4)，存在 ~1e-4 量级舍入
});

test('DSK-014 不得误伤其它封装族：dual / dip 的引脚本就在本体之外', async () => {
  const { generateWrl } = await import('../lib/kicadgen/model3d.js');
  const cases = [
    sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, height: 1.75, leadSpan: 6.0, leadLength: 1.0 }),
    sanitizePackage({ name: 'PDIP-8', type: 'DIP', pinCount: 8, pitch: 2.54, bodyLength: 9.8, bodyWidth: 6.4, height: 4.0 })
  ];
  for (const pkg of cases) {
    const boxes = wrlBoxes(generateWrl({ pkg }));
    const body = boxes.reduce((a, c) => (c.sx * c.sz > a.sx * a.sz ? c : a));
    const leads = boxes.filter((b) => b !== body);
    assert.ok(leads.length > 0, `${pkg.name} 应有引脚节点`);
    // 引脚必须至少在某个方向探出本体（否则同样是"被吞没"）
    const outside = leads.filter((l) =>
      Math.abs(l.x) + l.sx / 2 > body.x + body.sx / 2 + 0.01 ||
      l.y - l.sy / 2 < body.y - body.sy / 2 - 0.01);
    assert.ok(outside.length >= leads.length / 2, `${pkg.name}: 多数引脚未探出本体`);
  }
});

/* ══════════ DSK-015：几何守卫容差过松导致比例失真 ══════════ */

test('DSK-015 复现缺陷：SOT23-5 的 bodyLength=4.9mm 必须被 JEDEC 先验拦下', async () => {
  const { normalizeGeometryDetailed } = await import('../lib/kicadgen/geometry.js');
  // 现场输入：AI 把 SOT23-5 的本体长读成 4.9mm（SOIC-8 的长度），误差 +69%
  const sane = sanitizePackage({
    name: 'SOT23-5', type: 'SOT-23-5', pinCount: 5, pitch: 0.95,
    bodyLength: 4.9, bodyWidth: 1.6, height: 1.1, leadSpan: 2.8, leadLength: 0.4
  });
  const { normalizedPackage: g, transformations } = normalizeGeometryDetailed(sane);
  assert.equal(g.bodyLength, 2.9, `修复前 4.9 恰好卡在 prior*1.7=4.93 之下溜过，实际 ${g.bodyLength}`);
  const sub = transformations.find((t) => t.op === 'jedec_prior_substitution' && t.field === 'bodyLength');
  assert.ok(sub, '必须留下先验替换记录');
  assert.equal(sub.from, 4.9);
  assert.equal(sub.to, 2.9);
});

test('DSK-015 端到端：封装文件名 / 焊盘跨度 / 3D 长宽比三者与标称一致', async () => {
  const pkg = sanitizePackage({
    name: 'SOT23-5', type: 'SOT-23-5', pinCount: 5, pitch: 0.95,
    bodyLength: 4.9, bodyWidth: 1.6, height: 1.1, leadSpan: 2.8, leadLength: 0.4
  });
  const pins = ['+In', '-Vs', '-In', 'Out', '+Vs'].map((n, i) => ({ number: String(i + 1), name: n, type: 'passive' }));
  const b = generateBundle({ part: { mpn: 'LMV331X' }, items: [{ pkg, pins }] });
  const it = b.items[0];

  assert.match(it.names.kicadMod, /1\.6x2\.9mm/, `文件名应含标称尺寸，实际 ${it.names.kicadMod}`);

  // 焊盘沿引脚方向的跨度 = (每边3脚 - 1) × 0.95 = 1.90mm
  const pads = [...it.files.kicadMod.matchAll(/\(pad "(\d+)" smd [^\n]*?\(at (-?[\d.]+) (-?[\d.]+)\)/g)]
    .map((m) => ({ x: +m[2], y: +m[3] }));
  assert.equal(pads.length, 5);
  const ySpan = Math.max(...pads.map((p) => p.y)) - Math.min(...pads.map((p) => p.y));
  assert.ok(Math.abs(ySpan - 1.9) < 0.01, `焊盘跨度应为 1.90mm，实际 ${ySpan.toFixed(2)}`);

  // 3D 本体长宽比应为 2.9/1.6 ≈ 1.81，而非 4.9/1.6 ≈ 3.06
  const boxes = [...it.files.wrl.matchAll(/Box \{ size ([\d.]+) ([\d.]+) ([\d.]+)/g)]
    .map((m) => [+m[1] * 2.54, +m[2] * 2.54, +m[3] * 2.54]);
  const body = boxes.reduce((a, c) => (c[0] * c[2] > a[0] * a[2] ? c : a));
  const ratio = Math.max(body[0], body[2]) / Math.min(body[0], body[2]);
  assert.ok(Math.abs(ratio - 1.81) < 0.15, `3D 长宽比应约 1.81，实际 ${ratio.toFixed(2)}（4.9mm 时会是 3.06）`);
});

test('DSK-015 长度上限不再使用绝对裕量（小封装曾形同虚设）', async () => {
  const { normalizeGeometryDetailed } = await import('../lib/kicadgen/geometry.js');
  // 用 TSSOP：它有 pitch/bodyWidth/leadSpan 先验但**没有 bodyLength 先验**
  // （bodyLength 与引脚数相关，按设计不设先验），因此只能靠关系校验兜底。
  // 6 脚 × 0.65mm → rowLen = 2×0.65 = 1.3mm；
  // 旧上限 1.3 + max(4, 1.95) = 5.3mm 会放行 5.2mm 这种明显过长的值。
  const sane = sanitizePackage({
    name: 'TSSOP-6', type: 'TSSOP', pinCount: 6, pitch: 0.65,
    bodyLength: 5.2, bodyWidth: 4.4, height: 1.2, leadSpan: 6.4, leadLength: 0.5
  });
  const { normalizedPackage: g } = normalizeGeometryDetailed(sane);
  assert.ok(g.bodyLength < 5.0, `本体长 5.2mm 对每边 3 脚×0.65mm 明显不合理，应被派生，实际 ${g.bodyLength}`);
  assert.equal(g.pitch, 0.65, 'pitch 是合法值，不得被先验改动（否则上限计算会跟着放宽）');
});

test('DSK-015 不得误伤：合法的同族变体与大封装不应被替换', async () => {
  const { normalizeGeometryDetailed } = await import('../lib/kicadgen/geometry.js');
  const cases = [
    // 真实 SOT23-5 标称值
    { in: { name: 'SOT23-5', type: 'SOT-23-5', pinCount: 5, pitch: 0.95, bodyLength: 2.9, bodyWidth: 1.6, height: 1.45, leadSpan: 2.8, leadLength: 0.4 }, expect: 2.9 },
    // TSOT-23-5 薄型变体：height 差异大，但不应因此改动 bodyLength
    { in: { name: 'TSOT-23-5', type: 'TSOT-23-5', pinCount: 5, pitch: 0.95, bodyLength: 2.9, bodyWidth: 1.6, height: 0.9, leadSpan: 2.8, leadLength: 0.4 }, expect: 2.9 },
    // SC70-5
    { in: { name: 'SOT353', type: 'SC70-5', pinCount: 5, pitch: 0.65, bodyLength: 2.0, bodyWidth: 1.25, height: 1.0, leadSpan: 2.1, leadLength: 0.3 }, expect: 2.0 },
    // SOIC-8：无长度先验，靠关系校验，4.9mm 是合法值
    { in: { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, height: 1.75, leadSpan: 6.0, leadLength: 1.0 }, expect: 4.9 },
    // TSSOP-14：8.65mm 长，同样不得被误改
    { in: { name: 'TSSOP-14', type: 'TSSOP', pinCount: 14, pitch: 0.65, bodyLength: 5.0, bodyWidth: 4.4, height: 1.1, leadSpan: 6.4, leadLength: 0.6 }, expect: 5.0 }
  ];
  for (const c of cases) {
    const { normalizedPackage: g } = normalizeGeometryDetailed(sanitizePackage(c.in));
    assert.ok(Math.abs(g.bodyLength - c.expect) < 0.01,
      `${c.in.name}: bodyLength 应保持 ${c.expect}，实际 ${g.bodyLength}`);
  }
});
