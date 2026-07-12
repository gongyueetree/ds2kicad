// lib/kicadgen/symbol.js — 原理图符号确定性生成引擎
// 输入：清洗后的管脚列表（number/name/type/description）+ 器件元信息
// 输出：KiCad 6+ .kicad_sym（下载用）与旧版 .lib DEF 块（在线 Viewer 渲染用）
// 布局规则（确定性）：
//   左侧：input / tri_state / open_collector（控制/输入）
//   右侧：output / bidirectional / passive / unspecified（信号）
//   顶部：power_in 且名称含 V/VCC/VDD（正电源）
//   底部：GND/VSS/EP 等地与热焊盘；no_connect 挂右下

const GRID = 2.54; // KiCad 6 单位 mm
const MIL = 100;   // legacy 单位 mil

function classifyPins(pins) {
  const left = [], right = [], top = [], bottom = [];
  for (const p of pins) {
    const nm = p.name.toUpperCase();
    if (p.type === 'power_in' || p.type === 'power_out') {
      if (/^(GND|VSS|VEE|AGND|DGND|PGND|EP|PAD|EPAD|GNDA|GNDD)/.test(nm)) bottom.push(p);
      else top.push(p);
    } else if (nm === 'EP' || nm === 'EPAD' || /EXPOSED/.test(nm)) {
      bottom.push(p);
    } else if (p.type === 'input' || p.type === 'tri_state' || p.type === 'open_collector') {
      left.push(p);
    } else if (p.type === 'no_connect') {
      right.push(p); // 末尾，画短脚
    } else {
      right.push(p);
    }
  }
  // 稳定排序：按管脚编号数值
  const byNum = (a, b) => {
    const na = Number(a.number), nb = Number(b.number);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.number).localeCompare(String(b.number));
  };
  left.sort(byNum); right.sort(byNum); top.sort(byNum); bottom.sort(byNum);
  return { left, right, top, bottom };
}

/** 计算符号几何：矩形半宽/半高 + 每个管脚的 (x, y, 朝向)，单位为格数 */
function layout(pins) {
  const { left, right, top, bottom } = classifyPins(pins);
  const rows = Math.max(left.length, right.length, 1);
  // KLC S4.1：管脚长度由编号位数决定且全符号等长；取 100mil/200mil 保证原点仍在 100mil 网格上
  const maxNumChars = Math.max(1, ...pins.map((p) => String(p.number).length));
  const lenCells = maxNumChars <= 2 ? 1 : 2;
  const maxNameLen = Math.max(4, ...pins.map((p) => p.name.length));
  const halfWcells = Math.max(4, Math.ceil(maxNameLen * 0.62) + 1); // 名字放得下
  const halfHcells = Math.ceil((rows + 1) / 2) + 1;
  const topCols = Math.max(top.length, bottom.length);
  const halfW = Math.max(halfWcells, Math.ceil((topCols + 1) / 2) + 1);

  const items = [];
  const yTopStart = halfHcells - 1;
  left.forEach((p, i) => items.push({ pin: p, x: -(halfW + lenCells), y: yTopStart - i, orient: 'R' }));
  right.forEach((p, i) => items.push({ pin: p, x: halfW + lenCells, y: yTopStart - i, orient: 'L' }));
  const spread = (arr) => arr.map((_, i) => (i - (arr.length - 1) / 2) * 2).map(Math.round);
  const tx = spread(top), bx = spread(bottom);
  top.forEach((p, i) => items.push({ pin: p, x: tx[i], y: halfHcells + lenCells, orient: 'D' }));
  bottom.forEach((p, i) => items.push({ pin: p, x: bx[i], y: -(halfHcells + lenCells), orient: 'U' }));
  return { halfW, halfH: halfHcells, items, lenCells };
}

const KTYPE = {
  input: 'input', output: 'output', bidirectional: 'bidirectional',
  power_in: 'power_in', power_out: 'power_out', passive: 'passive',
  tri_state: 'tri_state', open_collector: 'open_collector',
  no_connect: 'no_connect', unspecified: 'unspecified'
};
const LTYPE = {
  input: 'I', output: 'O', bidirectional: 'B', power_in: 'W', power_out: 'w',
  passive: 'P', tri_state: 'T', open_collector: 'C', no_connect: 'N', unspecified: 'U'
};
const ANGLE = { R: 0, L: 180, U: 90, D: 270 };

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** KLC S4.7：低有效管脚 → 上划线表示。识别尾缀 '#'、前缀 '/'、前缀 '~'，去除原标记避免双重取反 */
function klcName(name) {
  const n = String(name);
  let base = null;
  if (/^[^#]+#$/.test(n)) base = n.slice(0, -1);
  else if (/^[/~].+/.test(n)) base = n.slice(1);
  if (base) return { sym: `~{${base}}`, legacy: `~${base}` };
  return { sym: n, legacy: n };
}

/** 单个 (symbol ...) 块（可多块合并进一个库文件） */
export function kicadSymBlock({ name, footprintName, pins, description }) {
  const mpn = name;
  const { halfW, halfH, items, lenCells } = layout(pins);
  const W = halfW * GRID, H = halfH * GRID, LEN = lenCells * GRID;
  const lines = [];
  lines.push(`  (symbol "${esc(mpn)}" (pin_names (offset 0.508)) (in_bom yes) (on_board yes)`);
  lines.push(`    (property "Reference" "U" (at 0 ${(H + 2 * GRID + 1.27).toFixed(2)} 0) (effects (font (size 1.27 1.27))))`);
  lines.push(`    (property "Value" "${esc(mpn)}" (at 0 ${(-H - 2 * GRID - 1.27).toFixed(2)} 0) (effects (font (size 1.27 1.27))))`);
  lines.push(`    (property "Footprint" "ds2kicad:${esc(footprintName || mpn)}" (at 0 ${(-H - 2 * GRID - 3.81).toFixed(2)} 0) (effects (font (size 1.27 1.27)) hide))`);
  lines.push(`    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`);
  if (description) {
    lines.push(`    (property "ki_description" "${esc(description)}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`);
  }
  lines.push(`    (symbol "${esc(mpn)}_0_1"`);
  lines.push(`      (rectangle (start ${(-W).toFixed(2)} ${H.toFixed(2)}) (end ${W.toFixed(2)} ${(-H).toFixed(2)})`);
  lines.push(`        (stroke (width 0.254) (type default)) (fill (type background)))`);
  lines.push(`    )`);
  lines.push(`    (symbol "${esc(mpn)}_1_1"`);
  for (const it of items) {
    const x = (it.x * GRID).toFixed(2), y = (it.y * GRID).toFixed(2);
    lines.push(`      (pin ${KTYPE[it.pin.type] || 'unspecified'} line (at ${x} ${y} ${ANGLE[it.orient]}) (length ${LEN.toFixed(2)})`);
    lines.push(`        (name "${esc(klcName(it.pin.name).sym)}" (effects (font (size 1.27 1.27))))`);
    lines.push(`        (number "${esc(it.pin.number)}" (effects (font (size 1.27 1.27)))))`);
  }
  lines.push(`    )`);
  lines.push(`  )`);
  return lines.join('\n');
}

/** 多符号合并为一个 .kicad_sym 库文件 */
export function generateKicadSymLib(blocks) {
  return [`(kicad_symbol_lib (version 20211014) (generator ds2kicad)`, ...blocks, `)`].join('\n');
}

/** 生成单符号 .kicad_sym（兼容旧调用） */
export function generateKicadSym({ mpn, footprintName, pins, description }) {
  return generateKicadSymLib([kicadSymBlock({ name: mpn, footprintName, pins, description })]);
}

/** 生成旧版 .lib DEF 块（供 kicad_part_viewer 内核渲染） */
export function generateLegacyLib({ mpn, pins }) {
  const { halfW, halfH, items, lenCells } = layout(pins);
  const W = halfW * MIL, H = halfH * MIL, LEN = lenCells * MIL;
  const out = [];
  out.push(`DEF ${mpn} U 0 40 Y Y 1 F N`);
  out.push(`F0 "U" 0 ${H + 150} 50 H V C CNN`);
  out.push(`F1 "${mpn}" 0 ${-(H + 150)} 50 H V C CNN`);
  out.push(`DRAW`);
  out.push(`S ${-W} ${-H} ${W} ${H} 0 1 10 f`);
  for (const it of items) {
    const x = it.x * MIL, y = it.y * MIL;
    out.push(`X ${klcName(it.pin.name).legacy.replace(/\s+/g, '_')} ${it.pin.number} ${x} ${y} ${LEN} ${it.orient} 50 50 1 1 ${LTYPE[it.pin.type] || 'U'}`);
  }
  out.push(`ENDDRAW`);
  out.push(`ENDDEF`);
  return out.join('\n');
}
