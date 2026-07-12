// src/components/FigureEditor.jsx — 图区确认与截取编辑器
// AI 给出候选页码 + 包围盒 → pdf.js 渲染页面 → 用户拖拽微调裁剪框 → 生成 PNG
import { useEffect, useRef, useState, useCallback } from 'react';
import { loadPdf, renderPage, cropToDataUrl } from '../pdf.js';

const KIND_LABEL = { block_diagram: '内部功能框图', application: '应用示例' };

function CropStage({ pageCanvas, bbox, onBbox }) {
  const wrapRef = useRef(null);
  const [drag, setDrag] = useState(null); // {startX,startY,curX,curY} 归一化

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !pageCanvas) return;
    wrap.innerHTML = '';
    pageCanvas.style.width = '100%';
    pageCanvas.style.height = 'auto';
    pageCanvas.style.display = 'block';
    wrap.appendChild(pageCanvas);
  }, [pageCanvas]);

  const norm = useCallback((e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    };
  }, []);

  const onDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = norm(e);
    setDrag({ startX: p.x, startY: p.y, curX: p.x, curY: p.y });
  };
  const onMove = (e) => {
    if (!drag) return;
    const p = norm(e);
    setDrag({ ...drag, curX: p.x, curY: p.y });
  };
  const onUp = () => {
    if (!drag) return;
    const x0 = Math.min(drag.startX, drag.curX), x1 = Math.max(drag.startX, drag.curX);
    const y0 = Math.min(drag.startY, drag.curY), y1 = Math.max(drag.startY, drag.curY);
    if (x1 - x0 > 0.02 && y1 - y0 > 0.02) onBbox([x0, y0, x1, y1]);
    setDrag(null);
  };

  const box = drag
    ? [Math.min(drag.startX, drag.curX), Math.min(drag.startY, drag.curY), Math.max(drag.startX, drag.curX), Math.max(drag.startY, drag.curY)]
    : bbox;

  return (
    <div
      className="crop-outer"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
    >
      <div ref={wrapRef} className="crop-page" />
      {box && (
        <div
          className={`crop-box ${drag ? 'dragging' : ''}`}
          style={{
            left: `${box[0] * 100}%`, top: `${box[1] * 100}%`,
            width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%`
          }}
        />
      )}
    </div>
  );
}

export default function FigureEditor({ pdfUrl, figures, aiFigures, onChange, mock }) {
  const [doc, setDoc] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [active, setActive] = useState(0);
  const [pageCanvas, setPageCanvas] = useState(null);
  const [previews, setPreviews] = useState({});   // index → dataURL
  const [status, setStatus] = useState('');
  const aiBboxRef = useRef((aiFigures || figures).map((f) => ({ page: f.page, bbox: [...f.bbox] })));

  // 加载 PDF
  useEffect(() => {
    if (!pdfUrl) return;
    let dead = false;
    setStatus('正在加载 PDF…');
    loadPdf(pdfUrl)
      .then((d) => { if (!dead) { setDoc(d); setPageCount(d.numPages); setStatus(''); } })
      .catch((e) => !dead && setStatus(`PDF 加载失败：${e.message}`));
    return () => { dead = true; };
  }, [pdfUrl]);

  const fig = figures[active];

  // 渲染当前图对应页
  useEffect(() => {
    if (!doc || !fig) return;
    let dead = false;
    const page = Math.min(Math.max(1, fig.page), doc.numPages);
    setStatus(`正在渲染第 ${page} 页…`);
    renderPage(doc, page)
      .then(({ canvas }) => { if (!dead) { setPageCanvas(canvas); setStatus(''); } })
      .catch((e) => !dead && setStatus(`页面渲染失败：${e.message}`));
    return () => { dead = true; };
  }, [doc, fig?.page, active]);

  // 生成当前裁剪预览
  useEffect(() => {
    if (!pageCanvas || !fig) return;
    try {
      const url = cropToDataUrl(pageCanvas, fig.bbox, 1);
      setPreviews((prev) => ({ ...prev, [active]: url }));
    } catch { /* 忽略瞬时错误 */ }
  }, [pageCanvas, fig?.bbox, active]);

  if (!figures.length) {
    return (
      <div className="figure-editor">
        <p className="hint">未提取到图区。可手动添加：</p>
        <button className="btn-secondary" onClick={() => onChange([{ kind: 'block_diagram', title: 'Functional Block Diagram', page: 1, bbox: [0.1, 0.1, 0.9, 0.6] }])}>＋ 添加图区</button>
      </div>
    );
  }

  const updFig = (patch) => {
    const next = figures.slice();
    next[active] = { ...next[active], ...patch };
    onChange(next);
  };

  return (
    <div className="figure-editor">
      <div className="figure-tabs">
        {figures.map((f, i) => (
          <button key={i} className={`fig-tab ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}>
            {KIND_LABEL[f.kind]} {figures.filter((x) => x.kind === f.kind).length > 1 ? `#${figures.slice(0, i + 1).filter((x) => x.kind === f.kind).length}` : ''}
          </button>
        ))}
        <button className="btn-ghost" onClick={() => { onChange([...figures, { kind: 'application', title: 'Application Example', page: fig.page, bbox: [0.1, 0.1, 0.9, 0.5] }]); setActive(figures.length); }}>＋</button>
        {figures.length > 1 && <button className="btn-ghost" onClick={() => { const next = figures.filter((_, i) => i !== active); onChange(next); setActive(Math.max(0, active - 1)); }}>删除当前</button>}
      </div>

      <div className="figure-meta">
        <label>标题<input value={fig.title} onChange={(e) => updFig({ title: e.target.value })} /></label>
        <label>类型
          <select value={fig.kind} onChange={(e) => updFig({ kind: e.target.value })}>
            <option value="block_diagram">内部功能框图</option>
            <option value="application">应用示例</option>
          </select>
        </label>
        <label>页码
          <span className="page-nav">
            <button className="btn-ghost" onClick={() => updFig({ page: Math.max(1, fig.page - 1) })}>◀</button>
            <input type="number" min="1" max={pageCount || 999} value={fig.page}
              onChange={(e) => updFig({ page: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
            <button className="btn-ghost" onClick={() => updFig({ page: Math.min(pageCount || fig.page + 1, fig.page + 1) })}>▶</button>
            <span className="hint">/ {pageCount || '?'}</span>
          </span>
        </label>
        <button className="btn-ghost" onClick={() => {
          const ai = aiBboxRef.current[active];
          if (ai) updFig({ page: ai.page, bbox: [...ai.bbox] });
        }}>重置为 AI 建议框</button>
      </div>

      {status && <p className="status-line">{status}</p>}
      <div className="figure-work">
        <div className="figure-stage">
          <p className="hint">在页面上按住左键拖拽，重新框选图区{mock ? '（演示模式：AI 建议框为占位值，请自行框选）' : ''}：</p>
          {pageCanvas
            ? <CropStage pageCanvas={pageCanvas} bbox={fig.bbox} onBbox={(bbox) => updFig({ bbox })} />
            : <div className="stage-empty">等待页面渲染…</div>}
        </div>
        <div className="figure-preview">
          <p className="hint">截取结果预览：</p>
          {previews[active]
            ? <img src={previews[active]} alt={fig.title} />
            : <div className="stage-empty">—</div>}
        </div>
      </div>
    </div>
  );
}

/** 供导出面板使用：按图定义批量生成高清 PNG（2x） */
export async function exportFigures(pdfUrl, figures) {
  const doc = await loadPdf(pdfUrl);
  const out = [];
  for (const f of figures) {
    const page = Math.min(Math.max(1, f.page), doc.numPages);
    const { canvas } = await renderPage(doc, page, 2000);
    out.push({ ...f, dataUrl: cropToDataUrl(canvas, f.bbox, 1) });
  }
  return out;
}
