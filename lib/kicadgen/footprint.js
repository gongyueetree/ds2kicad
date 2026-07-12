// lib/kicadgen/footprint.js — PCB 封装确定性生成引擎（KiCad 6+ .kicad_mod）
// 支持家族：
//   dual  : SOIC / TSSOP / SSOP / MSOP / SOP / SOT-23-5/6（双列鸥翼贴片）
//   qfn   : QFN / WQFN / UQFN / VQFN / DFN / SON（含裸露焊盘 EP）
//   dip   : PDIP / DIP（通孔）
//   sot23 : SOT-23（3 脚）
// 坐标系：KiCad 俯视，+Y 向下；1 脚位于左上，双列逆时针编号。

const f2 = (n) => Number(n.toFixed(3));

function padSmd(num, x, y, w, h, opts = {}) {
  const shape = opts.shape || 'roundrect';
  const rr = shape === 'roundrect' ? ' (roundrect_rratio 0.25)' : '';
  const rot = opts.rot ? ` ${opts.rot}` : '';
  return `  (pad "${num}" smd ${shape} (at ${f2(x)} ${f2(y)}${rot}) (size ${f2(w)} ${f2(h)}) (layers "F.Cu" "F.Paste" "F.Mask")${rr})`;
}
function padTht(num, x, y, dia, drill, first) {
  const shape = first ? 'rect' : 'circle';
  return `  (pad "${num}" thru_hole ${shape} (at ${f2(x)} ${f2(y)}) (size ${f2(dia)} ${f2(dia)}) (drill ${f2(drill)}) (layers "*.Cu" "*.Mask"))`;
}
function line(x1, y1, x2, y2, layer, width) {
  return `  (fp_line (start ${f2(x1)} ${f2(y1)}) (end ${f2(x2)} ${f2(y2)}) (stroke (width ${width}) (type solid)) (layer "${layer}"))`;
}
function rect(x1, y1, x2, y2, layer, width) {
  return [
    line(x1, y1, x2, y1, layer, width),
    line(x2, y1, x2, y2, layer, width),
    line(x2, y2, x1, y2, layer, width),
    line(x1, y2, x1, y1, layer, width)
  ];
}
function circle(cx, cy, r, layer, width, fill = false) {
  return `  (fp_circle (center ${f2(cx)} ${f2(cy)}) (end ${f2(cx + r)} ${f2(cy)}) (stroke (width ${width}) (type solid)) (fill ${fill ? 'solid' : 'none'}) (layer "${layer}"))`;
}

/** 双列鸥翼（SOIC/TSSOP/...）：引脚沿 Y 方向排布，两列在 X = ±padCX */
function dualPads(pkg, pinNumbers) {
  const n = pkg.pinCount, half = Math.ceil(n / 2);
  const pitch = pkg.pitch;
  const leadW = pkg.leadWidth || Math.min(0.6, pitch * 0.5);
  const padW = Math.min(pitch - 0.2, leadW + 0.15);           // 沿排布方向
  const outer = pkg.leadSpan / 2 + 0.4;                        // 趾部外延 0.4
  const inner = Math.max(pkg.bodyWidth / 2 - 0.25, outer - 1.8); // 跟部内缩
  const padL = outer - inner;
  const cx = (outer + inner) / 2;
  const y0 = -((half - 1) / 2) * pitch;
  const pads = [];
  for (let i = 0; i < half; i++) {
    const y = y0 + i * pitch;
    pads.push(padSmd(pinNumbers[i], -cx, y, padL, padW, { shape: i === 0 ? 'rect' : 'roundrect' }));
    const rIdx = n - 1 - i;
    if (rIdx >= half) pads.push(padSmd(pinNumbers[rIdx], cx, y, padL, padW));
  }
  return { pads, extentX: outer, extentY: Math.abs(y0) + padW / 2, bodyX: pkg.bodyWidth / 2, bodyY: pkg.bodyLength / 2 };
}

/** QFN 四边扁平无引脚：逆时针 1 脚起左上，左列向下 → 底行向右 → 右列向上 → 顶行向左 */
function qfnPads(pkg, pinNumbers) {
  const n = pkg.pinCount, perSide = n / 4;
  if (!Number.isInteger(perSide)) throw new Error(`QFN 管脚数 ${n} 不能被 4 整除，请确认封装参数`);
  const pitch = pkg.pitch;
  const leadW = pkg.leadWidth || Math.min(0.35, pitch * 0.5);
  const padW = Math.min(pitch - 0.15, leadW + 0.05);
  const outer = pkg.bodyLength / 2 + 0.3;
  const inner = pkg.bodyLength / 2 - pkg.leadLength - 0.05;
  const padL = outer - inner, c = (outer + inner) / 2;
  const q0 = -((perSide - 1) / 2) * pitch;
  const pads = [];
  for (let i = 0; i < perSide; i++) {
    const q = q0 + i * pitch;
    pads.push(padSmd(pinNumbers[i], -c, q, padL, padW, { shape: i === 0 ? 'rect' : 'roundrect' }));          // 左列 ↓
    pads.push(padSmd(pinNumbers[perSide + i], q, c, padW, padL));                                             // 底行 →
    pads.push(padSmd(pinNumbers[2 * perSide + i], c, -q, padL, padW));                                        // 右列 ↑
    pads.push(padSmd(pinNumbers[3 * perSide + i], -q, -c, padW, padL));                                       // 顶行 ←
  }
  if (pkg.epLength && pkg.epWidth) {
    const epNum = pinNumbers[n] ?? String(n + 1);
    pads.push(padSmd(epNum, 0, 0, pkg.epWidth, pkg.epLength, { shape: 'rect' }));
  }
  return { pads, extentX: outer, extentY: outer, bodyX: pkg.bodyLength / 2, bodyY: pkg.bodyWidth / 2 };
}

/** DIP 通孔：两列，孔距 rowSpan */
function dipPads(pkg, pinNumbers) {
  const n = pkg.pinCount, half = Math.ceil(n / 2);
  const pitch = pkg.pitch || 2.54;
  const cx = pkg.rowSpan / 2;
  const y0 = -((half - 1) / 2) * pitch;
  const pads = [];
  for (let i = 0; i < half; i++) {
    const y = y0 + i * pitch;
    pads.push(padTht(pinNumbers[i], -cx, y, 1.6, 0.8, i === 0));
    const rIdx = n - 1 - i;
    if (rIdx >= half) pads.push(padTht(pinNumbers[rIdx], cx, y, 1.6, 0.8, false));
  }
  return { pads, extentX: cx + 0.8, extentY: Math.abs(y0) + 0.8, bodyX: pkg.bodyWidth / 2, bodyY: pkg.bodyLength / 2 };
}

/** SOT-23（3 脚）：1、2 在左列（±0.95），3 在右侧居中 */
function sot23Pads(pkg, pinNumbers) {
  const cx = (pkg.leadSpan || 2.3) / 2 + 0.35;
  const pads = [
    padSmd(pinNumbers[0], -cx, -0.95, 1.1, 0.7, { shape: 'rect' }),
    padSmd(pinNumbers[1], -cx, 0.95, 1.1, 0.7),
    padSmd(pinNumbers[2], cx, 0, 1.1, 0.7)
  ];
  return { pads, extentX: cx + 0.6, extentY: 1.35, bodyX: (pkg.bodyWidth || 1.3) / 2, bodyY: (pkg.bodyLength || 2.9) / 2 };
}

/**
 * 生成 .kicad_mod 文本。
 * @param pkg     sanitizePackage 的输出
 * @param pinMap  可选：物理位置 i(0 起) → 管脚编号字符串。缺省为 1..N（含 EP=N+1）
 */
export function generateFootprint({ mpn, pkg, pinMap }) {
  const n = pkg.pinCount;
  const nums = pinMap && pinMap.length >= n
    ? pinMap.map(String)
    : Array.from({ length: n + 1 }, (_, i) => String(i + 1));

  let geo;
  switch (pkg.family) {
    case 'qfn': geo = qfnPads(pkg, nums); break;
    case 'dip': geo = dipPads(pkg, nums); break;
    case 'sot23': geo = sot23Pads(pkg, nums); break;
    default: geo = dualPads(pkg, nums);
  }

  const name = footprintName(mpn, pkg);
  const bx = geo.bodyX, by = geo.bodyY;
  const crtX = Math.max(geo.extentX, bx) + 0.25;
  const crtY = Math.max(geo.extentY, by) + 0.25;

  const out = [];
  out.push(`(footprint "${name}" (version 20221018) (generator ds2kicad) (layer "F.Cu")`);
  out.push(`  (descr "${pkg.name} ${pkg.pinCount}-pin, body ${pkg.bodyLength}x${pkg.bodyWidth}mm, pitch ${pkg.pitch}mm — generated by DS2KiCad, verify against datasheet")`);
  out.push(`  (attr ${pkg.family === 'dip' ? 'through_hole' : 'smd'})`);
  out.push(`  (fp_text reference "REF**" (at 0 ${f2(-crtY - 1.2)}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`);
  out.push(`  (fp_text value "${name}" (at 0 ${f2(crtY + 1.2)}) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`);
  // Fab 本体轮廓 + 1 脚斜角
  const ch = Math.min(1, bx / 2, by / 2);
  out.push(line(-bx + ch, -by, bx, -by, 'F.Fab', 0.1));
  out.push(line(bx, -by, bx, by, 'F.Fab', 0.1));
  out.push(line(bx, by, -bx, by, 'F.Fab', 0.1));
  out.push(line(-bx, by, -bx, -by + ch, 'F.Fab', 0.1));
  out.push(line(-bx, -by + ch, -bx + ch, -by, 'F.Fab', 0.1));
  // 丝印：QFN 画四角，dual/dip 画上下边 + 1 脚圆点
  if (pkg.family === 'qfn') {
    const s = bx + 0.15;
    // 角标长度自适应：止于最外侧焊盘边缘前 0.2mm，避免丝印压焊盘（DRC）
    const perSide = pkg.pinCount / 4;
    const leadW = pkg.leadWidth || Math.min(0.35, pkg.pitch * 0.5);
    const padW = Math.min(pkg.pitch - 0.15, leadW + 0.05);
    const firstPadEdge = ((perSide - 1) / 2) * pkg.pitch + padW / 2;
    const k = Math.min(1, Math.max(0.25, s - firstPadEdge - 0.2));
    out.push(line(-s + k, -s, -s, -s, 'F.SilkS', 0.12)); // 左上角折线由圆点替代方向
    out.push(line(-s, -s, -s, -s + k, 'F.SilkS', 0.12));
    out.push(line(s - k, -s, s, -s, 'F.SilkS', 0.12));
    out.push(line(s, -s, s, -s + k, 'F.SilkS', 0.12));
    out.push(line(s - k, s, s, s, 'F.SilkS', 0.12));
    out.push(line(s, s, s, s - k, 'F.SilkS', 0.12));
    out.push(line(-s + k, s, -s, s, 'F.SilkS', 0.12));
    out.push(line(-s, s, -s, s - k, 'F.SilkS', 0.12));
    out.push(circle(-geo.extentX - 0.4, -geo.extentY + 0.2, 0.1, 'F.SilkS', 0.2, true));
  } else {
    const sy = by + 0.12;
    out.push(line(-bx, -sy, bx, -sy, 'F.SilkS', 0.12));
    out.push(line(-bx, sy, bx, sy, 'F.SilkS', 0.12));
    out.push(circle(-geo.extentX - 0.5, -geo.extentY, 0.1, 'F.SilkS', 0.2, true));
  }
  // Courtyard
  out.push(...rect(-crtX, -crtY, crtX, crtY, 'F.CrtYd', 0.05));
  out.push(...geo.pads);
  out.push(`  (model "\${KIPRJMOD}/${name}.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`);
  out.push(`)`);
  return out.join('\n');
}

export function footprintName(mpn, pkg) {
  const clean = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${clean(mpn)}_${clean(pkg.name || pkg.type || 'PKG')}`;
}
