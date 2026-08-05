// lib/kicadgen/model3d.js — 参数化 3D 模型确定性生成引擎（VRML 2.0 / .wrl）
// KiCad WRL 约定：1 单位 = 0.1 英寸 = 2.54mm → 所有毫米坐标除以 2.54。
// 结构：环氧本体（倒角略）+ 引脚（鸥翼简化为 L 形两段盒 / QFN 侧壁焊盘 / DIP 直插柱）+ 1 脚标记点。
// three.js VRMLLoader 支持 Transform/Shape/Box/Cylinder，据此选用节点保证在线预览兼容。

const S = 1 / 2.54;
const f = (n) => Number((n * S).toFixed(4));
const fr = (n) => Number(n.toFixed(4));

const MAT_BODY = 'material Material { diffuseColor 0.16 0.16 0.18 shininess 0.25 }';
const MAT_LEAD = 'material Material { diffuseColor 0.78 0.78 0.80 specularColor 0.9 0.9 0.9 shininess 0.9 }';
const MAT_MARK = 'material Material { diffuseColor 0.85 0.83 0.80 }';

// VRML 坐标：Y 向上；KiCad 封装 XY → VRML X / -Z（使俯视 +Y(KiCad,向下) 对应 VRML -Z 方向一致）
function box(cx, cy, cz, sx, sy, sz, mat) {
  return `Transform { translation ${fr(cx)} ${fr(cy)} ${fr(cz)} children [ Shape { appearance Appearance { ${mat} } geometry Box { size ${fr(sx)} ${fr(sy)} ${fr(sz)} } } ] }`;
}
function cylinder(cx, cy, cz, r, h, mat) {
  return `Transform { translation ${fr(cx)} ${fr(cy)} ${fr(cz)} children [ Shape { appearance Appearance { ${mat} } geometry Cylinder { radius ${fr(r)} height ${fr(h)} } } ] }`;
}

/** 生成 WRL 文本 */
export function generateWrl({ pkg }) {
  const parts = [];
  // QFN 是无引线封装：端子是**本体底面**的裸露金属块，本体应叠在端子层之上。
  // 此前本体从 standoff=0.02 起、端子占 0~0.2，两者竖直互穿 —— 端子 90% 埋进环氧里，
  // 每个只剩 0.04mm 边缘露出，24 个碎片挤在一条边上就看成了"引脚连在一起"，
  // 还伴随 z-fighting。EP 同理，整块被本体吞掉、完全不可见。
  const termH = pkg.family === 'qfn' ? Math.min(0.25, Math.max(0.08, pkg.height * 0.25)) : 0;
  const bodyH = pkg.family === 'qfn'
    ? Math.max(0.2, pkg.height - termH)                      // 端子层 + 本体 = 手册总高
    : pkg.height * (pkg.family === 'dip' ? 0.85 : 0.8);
  const standoff = pkg.family === 'qfn' ? termH : pkg.family === 'dip' ? 0.4 : 0.1;
  const bx = pkg.family === 'qfn' ? pkg.bodyLength : pkg.bodyWidth;  // X 尺寸（跨引脚方向）
  const bz = pkg.family === 'qfn' ? pkg.bodyWidth : pkg.bodyLength;  // Z 尺寸（沿引脚排布方向）

  // 本体
  parts.push(box(0, f(standoff + bodyH / 2), 0, f(bx * 0.98), f(bodyH), f(bz * 0.98), MAT_BODY));
  // 1 脚标记（顶面左上：KiCad 左上 = VRML x<0, z<0）
  parts.push(cylinder(f(-bx / 2 + 0.5), f(standoff + bodyH + 0.01), f(-bz / 2 + 0.5), f(0.18), f(0.04), MAT_MARK));

  const n = pkg.pinCount;
  if (pkg.family === 'qfn') {
    const perSide = Math.floor(n / 4);
    const pitch = pkg.pitch;
    const lw = pkg.leadWidth || Math.min(0.35, pitch * 0.5);
    const ll = pkg.leadLength, lt = termH;                  // 端子层厚 = 本体离板高度
    const q0 = -((perSide - 1) / 2) * pitch;
    for (let i = 0; i < perSide; i++) {
      const q = q0 + i * pitch;
      const e = bx / 2 - ll / 2;                            // 外沿与本体标称边齐平
      parts.push(box(f(-e), f(lt / 2), f(q), f(ll), f(lt), f(lw), MAT_LEAD));   // 左
      parts.push(box(f(e), f(lt / 2), f(-q), f(ll), f(lt), f(lw), MAT_LEAD));   // 右
      parts.push(box(f(q), f(lt / 2), f(bz / 2 - ll / 2), f(lw), f(lt), f(ll), MAT_LEAD));  // 底(+Z)
      parts.push(box(f(-q), f(lt / 2), f(-(bz / 2 - ll / 2)), f(lw), f(lt), f(ll), MAT_LEAD)); // 顶(-Z)
    }
    if (pkg.epLength && pkg.epWidth) {
      // EP 与端子同层，露在本体下方而不是埋在里面
      parts.push(box(0, f(lt / 2), 0, f(pkg.epWidth), f(lt), f(pkg.epLength), MAT_LEAD));
    }
  } else if (pkg.family === 'dip') {
    const half = Math.ceil(n / 2);
    const pitch = pkg.pitch || 2.54;
    const y0 = -((half - 1) / 2) * pitch;
    for (let i = 0; i < half; i++) {
      const pz = y0 + i * pitch;
      parts.push(box(f(-pkg.rowSpan / 2), f(-1.5), f(pz), f(0.5), f(3.4), f(0.25), MAT_LEAD));
      if (n - 1 - i >= half) parts.push(box(f(pkg.rowSpan / 2), f(-1.5), f(pz), f(0.5), f(3.4), f(0.25), MAT_LEAD));
    }
  } else if (pkg.family === 'sot23') {
    const cxo = (pkg.leadSpan || 2.3) / 2;
    const mk = (x, z) => {
      parts.push(box(f(x * 0.75), f(0.08), f(z), f(Math.abs(x) * 0.55), f(0.16), f(0.4), MAT_LEAD));
    };
    mk(-cxo, -0.95); mk(-cxo, 0.95); mk(cxo, 0);
  } else {
    // dual 鸥翼：水平脚尖 + 斜/竖段（简化为两段盒）
    const half = Math.ceil(n / 2);
    const pitch = pkg.pitch;
    const lw = pkg.leadWidth || Math.min(0.6, pitch * 0.5);
    const y0 = -((half - 1) / 2) * pitch;
    const tip = pkg.leadSpan / 2;                     // 脚尖外沿
    const shoulder = pkg.bodyWidth / 2;               // 本体边
    const footLen = Math.max(0.4, (tip - shoulder) * 0.55);
    const midH = standoff + bodyH * 0.55;
    const rightHas = (row) => (n === 5 && half === 3) ? (row === 0 || row === half - 1) : (n - 1 - row >= half);
    for (let i = 0; i < half; i++) {
      const pz = y0 + i * pitch;
      for (const side of [-1, 1]) {
        if (side === 1 && !rightHas(i)) continue;
        const footCX = side * (tip - footLen / 2);
        parts.push(box(f(footCX), f(0.08), f(pz), f(footLen), f(0.16), f(lw), MAT_LEAD));            // 脚尖水平段
        const riseCX = side * (tip - footLen);
        parts.push(box(f(riseCX), f(midH / 2 + 0.08), f(pz), f(0.16), f(midH), f(lw), MAT_LEAD));    // 竖直段
        const shCX = side * ((tip - footLen + shoulder) / 2);
        parts.push(box(f(shCX), f(midH), f(pz), f(Math.abs(tip - footLen - shoulder)), f(0.16), f(lw), MAT_LEAD)); // 肩部段
      }
    }
  }

  return `#VRML V2.0 utf8
# Generated by DS2KiCad — parametric ${pkg.name || pkg.type} model (KiCad scale: 1 unit = 2.54 mm)
${parts.join('\n')}
`;
}
