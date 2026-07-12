// src/viewer/symbolRender.js — 原理图符号 SVG 渲染
// 移植自 eehubio/kicad_part_viewer（src/app.js renderLegacySymbol），渲染旧版 .lib DEF 块。
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, a = {}) => {
  const e = document.createElementNS(NS, tag);
  Object.entries(a).forEach(([k, v]) => v !== undefined && e.setAttribute(k, v));
  return e;
};

export function renderLegacySymbol(txt, svg, selectedUnit = 1) {
  svg.innerHTML = '';
  const vb = svg.viewBox?.baseVal;
  const w = vb?.width || 800, h = vb?.height || 520;

  // 预扫描边界以自适应缩放
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  const scan = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const rows = txt.split(/\r?\n/);
  let inDraw = false;
  for (const l of rows) {
    const t = l.trim();
    if (t === 'DRAW') { inDraw = true; continue; }
    if (t === 'ENDDRAW') break;
    if (!inDraw) continue;
    const p = t.split(/\s+/);
    if (p[0] === 'S') { scan(+p[1], +p[2]); scan(+p[3], +p[4]); }
    else if (p[0] === 'X') {
      const x = +p[3], y = +p[4], len = +p[5], o = p[6];
      scan(x, y);
      scan(x + (o === 'R' ? len : o === 'L' ? -len : 0), y + (o === 'U' ? len : o === 'D' ? -len : 0));
    }
  }
  const spanX = Math.max(maxX - minX, 100), spanY = Math.max(maxY - minY, 100);
  const scale = Math.min((w - 140) / spanX, (h - 110) / spanY, 0.9);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  const g = el('g', { transform: `translate(${w / 2 - cx * scale} ${h / 2 + cy * scale}) scale(${scale} ${-scale})` });
  const textLayer = el('g');
  svg.appendChild(g); svg.appendChild(textLayer);
  const toScreen = (x, y) => ({ x: w / 2 + (x - cx) * scale, y: h / 2 - (y - cy) * scale });

  inDraw = false;
  for (const l of rows) {
    if (l.trim() === 'DRAW') { inDraw = true; continue; }
    if (l.trim() === 'ENDDRAW') break;
    if (!inDraw) continue;
    const p = l.trim().split(/\s+/);
    if (!p.length) continue;
    const unitIndex = { S: 5, P: 2, C: 4, A: 6, X: 9 }[p[0]];
    const itemUnit = unitIndex == null ? 0 : (+p[unitIndex] || 0);
    if (itemUnit !== 0 && itemUnit !== selectedUnit) continue;

    if (p[0] === 'S') {
      const [x1, y1, x2, y2] = p.slice(1, 5).map(Number);
      g.appendChild(el('rect', {
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
        fill: p[p.length - 1]?.toLowerCase() === 'f' ? '#fffdb5' : 'none',
        stroke: '#8a0e0e', 'stroke-width': 2.4 / scale
      }));
    } else if (p[0] === 'X') {
      const name = p[1], num = p[2], x = +p[3], y = +p[4], len = +p[5], ori = p[6];
      let x2 = x, y2 = y;
      if (ori === 'R') x2 += len; if (ori === 'L') x2 -= len;
      if (ori === 'U') y2 += len; if (ori === 'D') y2 -= len;
      const pinG = el('g', { 'data-pin': num, class: 'hit-pin' });
      g.appendChild(pinG);
      // 加宽的透明命中区，便于点击细线
      pinG.appendChild(el('line', { x1: x, y1: y, x2, y2, stroke: 'transparent', 'stroke-width': 40 / scale }));
      pinG.appendChild(el('line', { x1: x, y1: y, x2, y2, stroke: '#8a0e0e', 'stroke-width': 1.8 / scale, class: 'pin-stroke' }));
      pinG.appendChild(el('circle', { cx: x, cy: y, r: 9, fill: 'none', stroke: '#8a0e0e', 'stroke-width': 1.3 / scale, class: 'pin-stroke' }));

      const outer = toScreen(x, y), inner = toScreen(x2, y2);
      const dx = inner.x - outer.x, dy = inner.y - outer.y, dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      // 屏幕上每 100mil 网格的像素数 → 文本取其 55%/45%（对应 KiCad 50mil 文本）
      const pxCell = 100 * scale;
      const nameSize = Math.max(9, Math.min(16, pxCell * 0.55));
      const numSize = Math.max(8, Math.min(13, pxCell * 0.45));
      const pinTextG = el('g', { 'data-pin': num, class: 'hit-pin' });
      textLayer.appendChild(pinTextG);
      const mkText = (text, pos, size, { anchor = 'middle', rotation = 0, color = '#006b68', weight = '500' } = {}) => {
        const t = el('text', {
          x: pos.x, y: pos.y,
          transform: rotation ? `rotate(${rotation} ${pos.x} ${pos.y})` : undefined,
          fill: color, 'font-size': size, 'font-family': 'Arial, sans-serif', 'font-weight': weight,
          'text-anchor': anchor, 'dominant-baseline': 'middle',
          'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': '1.8', 'stroke-linejoin': 'round'
        });
        t.textContent = text;
        pinTextG.appendChild(t);
      };
      const isVertical = ori === 'U' || ori === 'D';
      const nameGap = Math.max(6, nameSize * 0.55);
      const nameAt = { x: inner.x + ux * (isVertical ? nameSize * 2 : nameGap), y: inner.y + uy * (isVertical ? nameSize * 2 : nameGap) };
      let nameAnchor = 'middle', nameRotation = 0;
      if (ori === 'R') nameAnchor = 'start';
      else if (ori === 'L') nameAnchor = 'end';
      else nameRotation = -90;
      // KiCad 风格：编号位于管脚线中点上方（竖直管脚放左侧）
      const mid = { x: (outer.x + inner.x) / 2, y: (outer.y + inner.y) / 2 };
      let numAt, numAnchor = 'middle';
      if (Math.abs(dx) >= Math.abs(dy)) numAt = { x: mid.x, y: mid.y - Math.max(5, numSize * 0.5) };
      else { numAt = { x: mid.x - Math.max(5, numSize * 0.5), y: mid.y }; numAnchor = 'end'; }
      if (name && name !== '~') mkText(name, nameAt, nameSize, { anchor: nameAnchor, rotation: nameRotation, color: '#008080' });
      if (num && num !== '~') mkText(num, numAt, numSize, { anchor: numAnchor, color: '#8a0e0e' });
    }
  }
}
