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
        stroke: '#a40000', 'stroke-width': 10 / scale * 0.9
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
      pinG.appendChild(el('line', { x1: x, y1: y, x2, y2, stroke: '#a40000', 'stroke-width': 8 / scale * 0.9, class: 'pin-stroke' }));
      pinG.appendChild(el('circle', { cx: x, cy: y, r: 11, fill: 'none', stroke: '#a40000', 'stroke-width': 3 / scale * 0.9, class: 'pin-stroke' }));

      const outer = toScreen(x, y), inner = toScreen(x2, y2);
      const dx = inner.x - outer.x, dy = inner.y - outer.y, dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist, uy = dy / dist;
      const pinTextG = el('g', { 'data-pin': num, class: 'hit-pin' });
      textLayer.appendChild(pinTextG);
      const mkText = (text, pos, size, { anchor = 'middle', rotation = 0, color = '#006b68', weight = '500' } = {}) => {
        const t = el('text', {
          x: pos.x, y: pos.y,
          transform: rotation ? `rotate(${rotation} ${pos.x} ${pos.y})` : undefined,
          fill: color, 'font-size': size, 'font-family': 'Arial, sans-serif', 'font-weight': weight,
          'text-anchor': anchor, 'dominant-baseline': 'middle',
          'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': '2.5', 'stroke-linejoin': 'round'
        });
        t.textContent = text;
        pinTextG.appendChild(t);
      };
      const isVertical = ori === 'U' || ori === 'D';
      const nameAt = { x: inner.x + ux * (isVertical ? 42 : 14), y: inner.y + uy * (isVertical ? 42 : 14) };
      let nameAnchor = 'middle', nameRotation = 0;
      if (ori === 'R') nameAnchor = 'start';
      else if (ori === 'L') nameAnchor = 'end';
      else nameRotation = -90;
      const base = { x: outer.x + ux * 16, y: outer.y + uy * 16 };
      let numAt, numAnchor = 'middle';
      if (Math.abs(dx) >= Math.abs(dy)) numAt = { x: base.x, y: base.y - 14 };
      else { numAt = { x: base.x - 13, y: base.y }; numAnchor = 'end'; }
      if (name && name !== '~') mkText(name, nameAt, 15, { anchor: nameAnchor, rotation: nameRotation });
      if (num && num !== '~') mkText(num, numAt, 13, { anchor: numAnchor, color: '#a40000' });
    }
  }
}
