// src/components/FigureGallery.jsx — v0.8.9：可审核的截取图集。
//
// 关键变更：裁剪坐标不再来自 AI。
//   AI 只提供「哪张图 / 第几页 / 什么类型 / 标题」；
//   具体 bbox 由 figfit 确定性引擎从「渲染墨迹 + PDF 文本层真实行坐标」推导，
//   并写回 figures，使图集所见 === 导出 / ezPLM 所得。
import { useEffect, useRef, useState } from 'react';
import { loadPdf, renderPage, analyzePage, cropToDataUrl } from '../pdf.js';
import { autoFitFigure, inkRatio, METHOD_LABEL } from '../figfit.js';

export const KIND_OPTIONS = [
  { value: 'block_diagram', label: '内部功能框图' },
  { value: 'pin_configuration', label: '管脚排布图' },
  { value: 'package_outline', label: '封装图' },
  { value: 'application', label: '应用参考电路' }
];

export default function FigureGallery({ pdfUrl, figures, onChange, onRecrop }) {
  const [thumbs, setThumbs] = useState({});
  const [diag, setDiag] = useState({});
  const [status, setStatus] = useState('');
  const [pads, setPads] = useState({});      // figureId → 额外留白比例
  const [zoom, setZoom] = useState(null);    // 放大查看的 dataURL
  const refitRef = useRef(new Set());        // 请求强制重算的 figureId

  const keyOf = (f) => `${f.figureId || f.page}|${f.bbox.join(',')}|${pads[f.figureId] || 0}`;

  useEffect(() => {
    if (!figures?.length) return;
    let dead = false;
    (async () => {
      try {
        const doc = await loadPdf(pdfUrl);
        const patches = new Map();           // figureId → 贴合结果

        for (const f of figures) {
          if (dead) return;
          // 已贴合且缩略图在手 → 无需重算（写回 fitMethod 会触发本 effect 二次运行）
          if (f.fitMethod && !refitRef.current.has(f.figureId) && thumbs[keyOf(f)]) continue;
          const page = Math.min(Math.max(1, f.page), doc.numPages);
          let an;
          try {
            an = await analyzePage(doc, page, 1200);
          } catch (e) {
            setDiag((p) => ({ ...p, [keyOf(f)]: { error: `第 ${page} 页渲染失败：${e.message}` } }));
            continue;
          }
          if (dead) return;

          // ── 几何贴合：未贴合过、或用户点了「重新贴合」才算 ──────────────
          const forced = refitRef.current.has(f.figureId);
          let bbox = f.bbox, method = f.fitMethod || 'ai', caption = f.fitCaption;
          if (!f.fitMethod || forced) {
            const seed = forced && f.aiBbox ? f.aiBbox : f.bbox;
            const fit = autoFitFigure(an, { ...f, bbox: seed });
            if (fit) { bbox = fit.bbox; method = fit.method; caption = fit.caption || null; }
            else { method = 'ai'; }
            patches.set(f.figureId, { bbox, fitMethod: method, fitCaption: caption, aiBbox: f.aiBbox || f.bbox });
            refitRef.current.delete(f.figureId);
          }

          const pad = pads[f.figureId] || 0;
          const url = cropToDataUrl(an.canvas, bbox, 1, pad);
          if (dead) return;

          // ── 空白探测：直接查墨迹图，比"解码 PNG 再采样"准确且快 ──────────
          const g = an.grid;
          const r0 = Math.round((bbox[1] * an.canvas.height) / g.cell);
          const r1 = Math.round((bbox[3] * an.canvas.height) / g.cell);
          const c0 = Math.round((bbox[0] * an.canvas.width) / g.cell);
          const c1 = Math.round((bbox[2] * an.canvas.width) / g.cell);
          const ratio = inkRatio(g, r0, r1, c0, c1);

          const key = `${f.figureId || f.page}|${bbox.join(',')}|${pad}`;
          setThumbs((p) => ({ ...p, [key]: url }));
          setDiag((p) => ({
            ...p,
            [key]: {
              page, blank: ratio < 0.003, ink: ratio, method, caption,
              cropW: Math.round((bbox[2] - bbox[0]) * an.canvas.width),
              cropH: Math.round((bbox[3] - bbox[1]) * an.canvas.height),
              pageCount: doc.numPages
            }
          }));
        }

        if (!dead && patches.size) {
          onChange?.(figures.map((f) => (patches.has(f.figureId) ? { ...f, ...patches.get(f.figureId) } : f)));
        }
        if (!dead) setStatus('');
      } catch (e) {
        if (dead) return;
        const m = /Unexpected server response \((\d+)\)/.exec(e.message);
        const code = m?.[1];
        const msg = code
          ? `PDF 取回失败（HTTP ${code}）：${code === '409' ? '该作业未缓存 PDF，请重新提取' : code === '401' || code === '403' ? '会话无权访问该作业' : e.message}`
          : `PDF 加载失败：${e.message}`;
        setStatus(msg);
        setDiag((prev) => {
          const next = { ...prev };
          for (const f of figures) next[keyOf(f)] = { error: msg };
          return next;
        });
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, JSON.stringify(figures?.map((f) => [f.figureId, f.page, f.bbox, f.fitMethod])), JSON.stringify(pads)]);

  if (!figures?.length) return null;

  // figureId 是主键：缺 ID 时 `f.figureId === undefined` 会一次命中所有无 ID 的图，必须显式挡掉
  const upd = (figureId, patch) => figureId && onChange?.(figures.map((f) => (f.figureId === figureId ? { ...f, ...patch } : f)));
  const remove = (figureId) => figureId && onChange?.(figures.filter((f) => f.figureId !== figureId));
  const bump = (figureId, delta) => figureId && setPads((p) => ({ ...p, [figureId]: Math.max(0, Math.min(0.12, +(((p[figureId] || 0) + delta).toFixed(3)))) }));
  const refit = (figureId) => { refitRef.current.add(figureId); upd(figureId, { fitMethod: null }); };

  const confirmedCount = figures.filter((f) => f.confirmed).length;

  return (
    <div className="fig-gallery">
      {status && <p className="error-line">{status}</p>}
      <p className="hint">
        已保留 <b>{confirmedCount}</b> / {figures.length} 张。裁剪框由<b>确定性引擎</b>按图注文字与页面墨迹自动贴合
        （AI 只负责判定图的类型与页码）。逐张核对：类型是否正确、图形与标注是否完整；
        仍不理想则「重新贴合」或「重新框选」。只有<b>已确认</b>的图会进入导出与 ezPLM。
      </p>
      <div className="fig-gallery-grid">
        {figures.map((f) => {
          const pad = pads[f.figureId] || 0;
          const key = `${f.figureId || f.page}|${f.bbox.join(',')}|${pad}`;
          const d = diag[key];
          return (
            <figure key={f.figureId || key} className={`fig-card ${f.confirmed ? 'confirmed' : ''}`}>
              {d?.error
                ? <div className="stage-empty">⚠ {d.error}</div>
                : thumbs[key]
                  ? <img src={thumbs[key]} alt={f.title} loading="lazy" onClick={() => setZoom(thumbs[key])} style={{ cursor: 'zoom-in' }} />
                  : <div className="stage-empty">正在分析页面…</div>}
              <figcaption>
                {d?.blank && (
                  <p className="src-badge src-fallback" style={{ width: '100%' }}>
                    ⚠ 该区域几乎空白（第 {d.page}/{d.pageCount} 页，{d.cropW}×{d.cropH}px）
                    —— 请点「整页预览」核对页码，或「重新框选」
                  </p>
                )}
                <div className="fig-kind-row">
                  <select value={f.kind} onChange={(e) => upd(f.figureId, { kind: e.target.value })} title="图类型标注">
                    {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <span className="src-badge src-parser">p.{f.page}</span>
                  {f.fitMethod && f.fitMethod !== 'ai' && (
                    <span className="src-badge src-parser" title={d?.caption ? `锚定图注：${d.caption}` : '确定性引擎推导'}>
                      ⌗ {METHOD_LABEL[f.fitMethod] || f.fitMethod}
                    </span>
                  )}
                  {f.fitMethod === 'ai' && <span className="src-badge src-fallback" title="确定性贴合未成功，回退到 AI 建议框，坐标可能不准">⚠ AI 原框</span>}
                  {pad > 0 && <span className="src-badge src-fallback">留白 +{Math.round(pad * 100)}%</span>}
                </div>
                <div className="fig-title">{f.title}</div>
                <div className="fig-actions">
                  <button className="btn-ghost" onClick={() => refit(f.figureId)} title="按图注与墨迹重新计算裁剪框">重新贴合</button>
                  <button className="btn-ghost" onClick={() => bump(f.figureId, 0.02)} title="裁剪不全时扩大边界">＋留白</button>
                  <button className="btn-ghost" onClick={() => bump(f.figureId, -0.02)} disabled={pad <= 0}>－留白</button>
                  <button className="btn-ghost" onClick={() => onRecrop?.(f.figureId)}>重新框选</button>
                  <button className="btn-ghost" onClick={async () => {
                    // 整页预览：定位问题到底是"页码错"还是"坐标错"
                    try {
                      const doc = await loadPdf(pdfUrl);
                      const { canvas } = await renderPage(doc, Math.min(Math.max(1, f.page), doc.numPages), 1400);
                      setZoom(cropToDataUrl(canvas, [0, 0, 1, 1], 1));
                    } catch (e) { setStatus(`整页预览失败：${e.message}`); }
                  }}>整页预览</button>
                  {f.confirmed
                    ? <button className="btn-secondary" onClick={() => upd(f.figureId, { confirmed: false })}>✓ 已保留（点击撤销）</button>
                    : <button className="btn-primary" onClick={() => upd(f.figureId, { confirmed: true })}>确认保留</button>}
                  <button className="btn-ghost danger" onClick={() => remove(f.figureId)} title="从图集中删除">丢弃</button>
                </div>
              </figcaption>
            </figure>
          );
        })}
      </div>
      {zoom && (
        <div className="fig-zoom" onClick={() => setZoom(null)}>
          <img src={zoom} alt="放大查看" />
          <p className="hint">点击任意处关闭</p>
        </div>
      )}
    </div>
  );
}
