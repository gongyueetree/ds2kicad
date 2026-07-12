// src/viewer/footprintRender.js — PCB 封装 SVG 渲染
// 移植自 eehubio/kicad_part_viewer（src/app.js renderFootprint），解析 .kicad_mod s-expression。
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, a = {}) => {
  const e = document.createElementNS(NS, tag);
  Object.entries(a).forEach(([k, v]) => v !== undefined && e.setAttribute(k, v));
  return e;
};

function sexprBlocks(txt, keyword) {
  const blocks = [];
  let pos = 0;
  while ((pos = txt.indexOf(`(${keyword}`, pos)) >= 0) {
    let depth = 0, end = pos, inStr = false, esc = false;
    for (let i = pos; i < txt.length; i++) {
      const c = txt[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
    }
    blocks.push(txt.slice(pos, end));
    pos = end;
  }
  return blocks;
}

export function renderFootprint(txt, svg) {
  svg.innerHTML = '';
  const vb = svg.viewBox?.baseVal;
  const w = vb?.width || 800, h = vb?.height || 520;
  const all = [];
  for (const b of sexprBlocks(txt, 'fp_line')) {
    const a = b.match(/\(start\s+([-\d.]+)\s+([-\d.]+)\)/), e = b.match(/\(end\s+([-\d.]+)\s+([-\d.]+)\)/), l = b.match(/\(layer\s+"?([^)"]+)"?\)/);
    if (a && e && l) all.push({ kind: 'line', x1: +a[1], y1: +a[2], x2: +e[1], y2: +e[2], layer: l[1] });
  }
  for (const b of sexprBlocks(txt, 'fp_circle')) {
    const c = b.match(/\(center\s+([-\d.]+)\s+([-\d.]+)\)/), e = b.match(/\(end\s+([-\d.]+)\s+([-\d.]+)\)/), l = b.match(/\(layer\s+"?([^)"]+)"?\)/);
    if (c && e && l) all.push({ kind: 'circle', cx: +c[1], cy: +c[2], ex: +e[1], ey: +e[2], layer: l[1] });
  }
  const pads = [];
  for (const b of sexprBlocks(txt, 'pad')) {
    const head = b.match(/^\(pad\s+"?([^\s"]+)"?\s+(\S+)\s+(\S+)/);
    const at = b.match(/\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/);
    const sz = b.match(/\(size\s+([-\d.]+)\s+([-\d.]+)\)/);
    if (head && at && sz) pads.push({ num: head[1], type: head[2], shape: head[3], x: +at[1], y: +at[2], rot: +(at[3] || 0), w: +sz[1], h: +sz[2] });
  }
  const pts = [];
  all.forEach((o) => { if (o.kind === 'line') pts.push([o.x1, o.y1], [o.x2, o.y2]); else pts.push([o.cx, o.cy], [o.ex, o.ey]); });
  pads.forEach((p) => { const r = Math.hypot(p.w, p.h) / 2; pts.push([p.x - r, p.y - r], [p.x + r, p.y + r]); });
  let minX = -5, maxX = 5, minY = -4, maxY = 4;
  if (pts.length) {
    minX = Math.min(...pts.map((p) => p[0])); maxX = Math.max(...pts.map((p) => p[0]));
    minY = Math.min(...pts.map((p) => p[1])); maxY = Math.max(...pts.map((p) => p[1]));
  }
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  const sc = Math.min((w - 90) / spanX, (h - 80) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const g = el('g', { transform: `translate(${w / 2} ${h / 2}) scale(${sc} ${sc}) translate(${-cx} ${-cy})` });
  svg.appendChild(g);
  const layerStyle = (layer) =>
    layer.includes('CrtYd') ? { stroke: '#db6a2b', dash: '0.18 0.12', width: 0.055 }
      : layer.includes('Silk') ? { stroke: '#d6b937', dash: '', width: 0.10 }
      : layer.includes('Fab') ? { stroke: '#6c7d93', dash: '', width: 0.055 }
      : { stroke: '#9aa8b8', dash: '', width: 0.045 };
  all.forEach((o) => {
    const st = layerStyle(o.layer);
    let e2;
    if (o.kind === 'line') e2 = el('line', { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
    else { const r = Math.hypot(o.ex - o.cx, o.ey - o.cy); e2 = el('circle', { cx: o.cx, cy: o.cy, r }); }
    e2.setAttribute('fill', 'none');
    e2.setAttribute('stroke', st.stroke);
    e2.setAttribute('stroke-width', st.width);
    if (st.dash) e2.setAttribute('stroke-dasharray', st.dash);
    g.appendChild(e2);
  });
  pads.forEach((p) => {
    const pg = el('g', { transform: `translate(${p.x} ${p.y}) rotate(${p.rot})` });
    g.appendChild(pg);
    const round = p.shape === 'circle' || p.shape === 'oval';
    const attrs = round
      ? { cx: 0, cy: 0, rx: p.w / 2, ry: p.h / 2 }
      : { x: -p.w / 2, y: -p.h / 2, width: p.w, height: p.h, rx: p.shape.includes('round') ? 0.08 : 0 };
    const r = el(round ? 'ellipse' : 'rect', attrs);
    r.setAttribute('fill', p.num === '1' ? '#d77b31' : '#d69f36');
    r.setAttribute('stroke', '#8c6419');
    r.setAttribute('stroke-width', '.04');
    pg.appendChild(r);
    const t = el('text', {
      x: 0, y: 0, transform: `rotate(${-p.rot})`, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': Math.max(0.22, Math.min(p.w, p.h) * 0.42), fill: '#fff', 'font-family': 'Arial', 'font-weight': '700'
    });
    t.textContent = p.num;
    pg.appendChild(t);
  });
  const legend = el('g', { transform: `translate(22 ${h - 22})` });
  [['#d6b937', 'F.SilkS'], ['#db6a2b', 'F.CrtYd'], ['#6c7d93', 'F.Fab'], ['#d77b31', 'Pin 1']].forEach((it, i) => {
    legend.appendChild(el('line', { x1: i * 100, y1: 0, x2: i * 100 + 20, y2: 0, stroke: it[0], 'stroke-width': 3 }));
    const t = el('text', { x: i * 100 + 25, y: 5, fill: '#54657c', 'font-size': 13 });
    t.textContent = it[1];
    legend.appendChild(t);
  });
  svg.appendChild(legend);
}

/** 通用 SVG 视口：滚轮缩放 + 拖拽平移（移植自 kicad_part_viewer createSvgViewport） */
export function createSvgViewport(svg) {
  const vb = svg.viewBox?.baseVal;
  const base = { x: 0, y: 0, w: vb?.width || 800, h: vb?.height || 520 };
  let view = { ...base }, dragging = false, pointerId = null, last = { x: 0, y: 0 };
  const apply = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const reset = () => { view = { ...base }; apply(); };
  const zoomAt = (factor, clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = clientX ?? rect.left + rect.width / 2;
    const py = clientY ?? rect.top + rect.height / 2;
    const ux = view.x + (px - rect.left) / rect.width * view.w;
    const uy = view.y + (py - rect.top) / rect.height * view.h;
    const newW = Math.min(base.w * 8, Math.max(base.w / 20, view.w * factor));
    const newH = newW * (base.h / base.w);
    const rx = (ux - view.x) / view.w, ry = (uy - view.y) / view.h;
    view = { x: ux - rx * newW, y: uy - ry * newH, w: newW, h: newH };
    apply();
  };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY > 0 ? 1.12 : 0.89, e.clientX, e.clientY); }, { passive: false });
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; pointerId = e.pointerId; last = { x: e.clientX, y: e.clientY };
    svg.setPointerCapture(pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const r = svg.getBoundingClientRect();
    view.x -= (e.clientX - last.x) / r.width * view.w;
    view.y -= (e.clientY - last.y) / r.height * view.h;
    last = { x: e.clientX, y: e.clientY };
    apply();
  });
  const stop = () => { if (!dragging) return; dragging = false; try { svg.releasePointerCapture(pointerId); } catch {} pointerId = null; };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', stop);
  svg.addEventListener('dblclick', reset);
  apply();
  return { reset, zoomIn: () => zoomAt(0.78), zoomOut: () => zoomAt(1.28) };
}
