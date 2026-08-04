// src/components/FigureGallery.jsx — v0.8.8：可审核的截取图集。
// 每张图提供：类型标注（内部功能框图 / 管脚排布图 / 封装图 / 应用参考电路）、
// 留白微调（解决裁剪不完整）、放大查看、确认保留 / 丢弃、去 ④ 重新框选。
import { useEffect, useState } from 'react';
import { loadPdf, renderPage, cropToDataUrl } from '../pdf.js';

export const KIND_OPTIONS = [
  { value: 'block_diagram', label: '内部功能框图' },
  { value: 'pin_configuration', label: '管脚排布图' },
  { value: 'package_outline', label: '封装图' },
  { value: 'application', label: '应用参考电路' }
];
const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label]));

export default function FigureGallery({ pdfUrl, figures, onChange, onRecrop }) {
  const [thumbs, setThumbs] = useState({});
  const [diag, setDiag] = useState({});
  const [status, setStatus] = useState('');
  const [pads, setPads] = useState({});      // figureId → 额外留白比例
  const [zoom, setZoom] = useState(null);    // 放大查看的 dataURL

  const keyOf = (f) => `${f.figureId || f.page}|${f.bbox.join(',')}|${pads[f.figureId] || 0}`;

  useEffect(() => {
    if (!figures?.length) return;
    let dead = false;
    (async () => {
      try {
        const doc = await loadPdf(pdfUrl);
        for (const f of figures) {
          const key = keyOf(f);
          if (thumbs[key]) continue;
          const page = Math.min(Math.max(1, f.page), doc.numPages);
          let canvas;
          try {
            ({ canvas } = await renderPage(doc, page, 1400));
          } catch (e) {
            setDiag((p) => ({ ...p, [key]: { error: `第 ${page} 页渲染失败：${e.message}` } }));
            continue;
          }
          const url = cropToDataUrl(canvas, f.bbox, 1, pads[f.figureId] || 0);
          if (dead) return;
          setThumbs((p) => ({ ...p, [key]: url }));
        }
        setStatus('');
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
  }, [pdfUrl, JSON.stringify(figures?.map((f) => [f.figureId, f.page, f.bbox])), JSON.stringify(pads)]);

  if (!figures?.length) return null;

  const upd = (figureId, patch) => onChange?.(figures.map((f) => (f.figureId === figureId ? { ...f, ...patch } : f)));
  const remove = (figureId) => onChange?.(figures.filter((f) => f.figureId !== figureId));
  const bump = (figureId, delta) => setPads((p) => ({ ...p, [figureId]: Math.max(0, Math.min(0.12, +(((p[figureId] || 0) + delta).toFixed(3)))) }));

  const confirmedCount = figures.filter((f) => f.confirmed).length;

  return (
    <div className="fig-gallery">
      {status && <p className="error-line">{status}</p>}
      <p className="hint">
        已保留 <b>{confirmedCount}</b> / {figures.length} 张。逐张核对：类型是否正确、图形与标注是否完整；
        裁剪不全时点「＋留白」扩大边界，仍不理想则「重新框选」。只有<b>已确认</b>的图会进入导出与 ezPLM。
      </p>
      <div className="fig-gallery-grid">
        {figures.map((f) => {
          const key = keyOf(f);
          const pad = pads[f.figureId] || 0;
          return (
            <figure key={f.figureId || key} className={`fig-card ${f.confirmed ? 'confirmed' : ''}`}>
              {diag[key]?.error
                ? <div className="stage-empty">⚠ {diag[key].error}</div>
                : thumbs[key]
                  ? <img src={thumbs[key]} alt={f.title} loading="lazy" onClick={() => setZoom(thumbs[key])} style={{ cursor: 'zoom-in' }} />
                  : <div className="stage-empty">渲染中…</div>}
              <figcaption>
                <div className="fig-kind-row">
                  <select value={f.kind} onChange={(e) => upd(f.figureId, { kind: e.target.value })} title="图类型标注">
                    {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <span className="src-badge src-parser">p.{f.page}</span>
                  {pad > 0 && <span className="src-badge src-fallback">留白 +{Math.round(pad * 100)}%</span>}
                </div>
                <div className="fig-title">{f.title}</div>
                <div className="fig-actions">
                  <button className="btn-ghost" onClick={() => bump(f.figureId, 0.02)} title="裁剪不全时扩大边界">＋留白</button>
                  <button className="btn-ghost" onClick={() => bump(f.figureId, -0.02)} disabled={pad <= 0}>－留白</button>
                  <button className="btn-ghost" onClick={() => onRecrop?.(f.figureId)}>重新框选</button>
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
