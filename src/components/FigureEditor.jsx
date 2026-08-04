// src/components/FigureEditor.jsx — 图区确认与截取编辑器
// AI 给出候选页码 + 包围盒 → pdf.js 渲染页面 → 用户拖拽微调裁剪框 → 生成 PNG
import { useEffect, useRef, useState, useCallback } from 'react';
import { loadPdf, renderPage, analyzePage, cropToDataUrl } from '../pdf.js';
import { autoFitFigure, METHOD_LABEL } from '../figfit.js';
import { newFigureTempId, resolveActiveIndex, shouldConsumeFocus, nextActiveAfterRemoval } from '../figstate.js';
import { apiFigureUpload } from '../api.js';

const KIND_LABEL = { block_diagram: '内部功能框图', application: '应用参考电路', pin_configuration: '管脚排布图', package_outline: '封装图' };

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

export default function FigureEditor({ pdfUrl, figures, aiFigures, onChange, mock, jobId, revision, focusRequest, onFocusHandled, onRevision }) {
  const [doc, setDoc] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  // v0.8.10：当前图用 figureId 追踪，不再用数组下标 ——
  // 下标会在图集「丢弃」/ 服务端回写导致数组重排后指向另一张图。
  const [activeId, setActiveId] = useState(null);
  const [pageCanvas, setPageCanvas] = useState(null);
  const [previews, setPreviews] = useState({});   // figureId → dataURL
  const [status, setStatus] = useState('');
  const rootRef = useRef(null);
  const handledSeqRef = useRef(null);

  const activeIndex = Math.max(0, resolveActiveIndex(figures, activeId));
  const fig = figures[activeIndex];
  const setActiveById = (id) => setActiveId(id);

  // 首次挂载 / 当前图被删除后，回落到第一张
  useEffect(() => {
    if (!figures.length) return;
    if (!figures.some((f) => f.figureId === activeId)) setActiveId(figures[0].figureId);
  }, [figures, activeId]);

  // 图集「重新框选」跳转。
  // v0.8.10：focusRequest 是**一次性请求令牌** {figureId, seq}，不是常驻值。
  //   旧实现用常驻的 focusFigureId + 依赖 figures，导致两个缺陷：
  //   (a) 对同一张图再次点「重新框选」时 props 不变 → effect 不触发 → 停在上次的图（表现为"跳到某个固定页面"）；
  //   (b) 任何 figures 变更（自动贴合写回、确认、改标题）都会把用户强行拽回上次的跳转目标。
  useEffect(() => {
    if (!shouldConsumeFocus(focusRequest, handledSeqRef.current, figures)) return;
    handledSeqRef.current = focusRequest.seq;
    setActiveId(focusRequest.figureId);
    // 等编辑器完成挂载/渲染后再滚动 —— 由本组件自己滚，调用方在挂载前 querySelector 必然落空
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    onFocusHandled?.();
  }, [focusRequest, figures, onFocusHandled]);

  const aiBboxRef = useRef(new Map(
    (aiFigures || figures).map((f) => [f.figureId, { page: f.page, bbox: [...f.bbox] }])
  ));

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
  }, [doc, fig?.page, activeId]);

  // 生成当前裁剪预览
  useEffect(() => {
    if (!pageCanvas || !fig) return;
    try {
      const url = cropToDataUrl(pageCanvas, fig.bbox, 1);
      setPreviews((prev) => ({ ...prev, [fig.figureId]: url }));
    } catch { /* 忽略瞬时错误 */ }
  }, [pageCanvas, fig?.bbox, activeId]);

  if (!figures.length) {
    return (
      <div className="figure-editor">
        <p className="hint">未提取到图区。可手动添加：</p>
        <button className="btn-secondary" onClick={() => onChange([{ figureId: newFigureTempId(), kind: 'block_diagram', title: 'Functional Block Diagram', page: 1, bbox: [0.1, 0.1, 0.9, 0.6] }])}>＋ 添加图区</button>
      </div>
    );
  }

  const updFig = (patch) => onChange(figures.map((f) => (f.figureId === fig.figureId ? { ...f, ...patch } : f)));

  const confirmedCount = figures.filter((f) => f.confirmed).length;

  return (
    <div className="figure-editor" ref={rootRef}>
      <p className="hint">
        已确认 <b>{confirmedCount}</b> / {figures.length} 张 — 只有「已确认」的图会进入 ZIP / part-bundle / ezPLM 发送。
        {confirmedCount < figures.length && (
          <button className="btn-ghost" style={{ marginLeft: 8 }}
            onClick={() => onChange(figures.map((f) => ({ ...f, confirmed: true })))}>全部确认</button>
        )}
      </p>
      <div className="figure-tabs">
        {figures.map((f, i) => (
          <button key={f.figureId || i} className={`fig-tab ${i === activeIndex ? 'active' : ''} ${f.confirmed ? 'confirmed' : ''}`} onClick={() => setActiveById(f.figureId)}>
            {f.confirmed ? '✓ ' : ''}{KIND_LABEL[f.kind]} {figures.filter((x) => x.kind === f.kind).length > 1 ? `#${figures.slice(0, i + 1).filter((x) => x.kind === f.kind).length}` : ''}
          </button>
        ))}
        <button className="btn-ghost" onClick={() => {
          const added = { figureId: newFigureTempId(), kind: 'application', title: 'Application Example', page: fig.page, bbox: [0.1, 0.1, 0.9, 0.5] };
          onChange([...figures, added]); setActiveById(added.figureId);
        }}>＋</button>
        {figures.length > 1 && <button className="btn-ghost" onClick={() => {
          const next = figures.filter((f) => f.figureId !== fig.figureId);
          onChange(next);
          setActiveById(nextActiveAfterRemoval(next, activeIndex));
        }}>删除当前</button>}
      </div>

      <div className="figure-meta">
        <label>标题<input value={fig.title} onChange={(e) => updFig({ title: e.target.value })} /></label>
        <label>类型
          <select value={fig.kind} onChange={(e) => updFig({ kind: e.target.value })}>
            <option value="block_diagram">内部功能框图</option>
            <option value="pin_configuration">管脚排布图</option>
            <option value="package_outline">封装图</option>
            <option value="application">应用参考电路</option>
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
          const ai = aiBboxRef.current.get(fig.figureId);
          if (ai) updFig({ page: ai.page, bbox: [...ai.bbox], fitMethod: 'ai' });
        }}>重置为 AI 建议框</button>
        <button className="btn-ghost" title="按图注文字与页面墨迹重新计算裁剪框（确定性引擎）" onClick={async () => {
          try {
            setStatus('正在按图注与墨迹贴合…');
            const d = doc || (await loadPdf(pdfUrl));
            const an = await analyzePage(d, Math.min(Math.max(1, fig.page), d.numPages), 1200);
            const seed = fig.aiBbox || fig.bbox;
            const fit = autoFitFigure(an, { ...fig, bbox: seed });
            if (fit) { updFig({ bbox: fit.bbox, fitMethod: fit.method, fitCaption: fit.caption || null, aiBbox: fig.aiBbox || fig.bbox, confirmed: false }); setStatus(`已自动贴合（${METHOD_LABEL[fit.method] || fit.method}）`); }
            else setStatus('未能自动贴合：该页未找到可用图块，请手动框选');
          } catch (e) { setStatus(`自动贴合失败：${e.message}`); }
        }}>自动贴合</button>
      </div>

      {fig.fitMethod && (
        <p className="hint">
          当前裁剪框来源：<b>{METHOD_LABEL[fig.fitMethod] || fig.fitMethod}</b>
          {fig.fitCaption ? `（锚定图注：${fig.fitCaption}）` : ''}
          {fig.fitMethod === 'ai' ? ' —— AI 给出的坐标不可靠，建议点「自动贴合」或手动框选' : ''}
        </p>
      )}
      {status && <p className="status-line">{status}</p>}
      <div className="figure-work">
        <div className="figure-stage">
          <p className="hint">在页面上按住左键拖拽，重新框选图区{mock ? '（演示模式：AI 建议框为占位值，请自行框选）' : ''}：</p>
          {pageCanvas
            ? <CropStage pageCanvas={pageCanvas} bbox={fig.bbox} onBbox={(bbox) => updFig({ bbox, confirmed: false, fitMethod: 'manual' })} />
            : <div className="stage-empty">等待页面渲染…</div>}
        </div>
        <div className="figure-preview">
          <p className="hint">截取结果预览：</p>
          {previews[fig.figureId]
            ? <img src={previews[fig.figureId]} alt={fig.title} />
            : <div className="stage-empty">—</div>}
          <div style={{ marginTop: 10 }}>
            {fig.confirmed
              ? <button className="btn-secondary" onClick={() => updFig({ confirmed: false })}>✓ 已确认（点击取消）</button>
              : <button className="btn-primary" onClick={async () => {
                  // v0.8.7 item 7：确认即把裁剪 PNG 真实上传到服务端（对象存储），再标记 confirmed
                  updFig({ confirmed: true });
                  try {
                    const dataUrl = previews[fig.figureId];
                    if (dataUrl && jobId && fig.figureId) {
                      const r = await apiFigureUpload({
                        jobId, figureId: fig.figureId,
                        pngBase64: dataUrl.split(',')[1],
                        expectedRevision: revision,
                        page: fig.page, bbox: fig.bbox
                      });
                      // v0.8.11：上传会递增作业 revision。此前丢弃了返回值，导致
                      // 上传过一次后 extract.revision 永久落后，后续生成一律 409 版本冲突。
                      onRevision?.(r.revision);
                      setStatus(`图片已上传到服务端 ✓（revision → ${r.revision}）`);
                    }
                  } catch (e) {
                    if (e.code === 'revision_conflict' && Number.isInteger(e.currentRevision)) {
                      onRevision?.(e.currentRevision);
                      setStatus(`版本已过期，已同步到 revision ${e.currentRevision}，请再次点击「确认此图」`);
                    } else {
                      setStatus(`图片上传失败：${e.message}`);
                    }
                    updFig({ confirmed: false });   // 上传失败不得留下"已确认"的假象
                  }
                }}>确认此图（截取并上传）</button>}
          </div>
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
