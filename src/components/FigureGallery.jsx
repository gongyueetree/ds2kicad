// src/components/FigureGallery.jsx — 截取图集：框图/管脚排布/应用电路的裁剪图 + 标注展示
// 随 ④ 的框选与确认实时更新；缩略图由 pdf.js 本地渲染裁剪（1200px 宽）
import { useEffect, useState } from 'react';
import { loadPdf, renderPage, cropToDataUrl } from '../pdf.js';

const KIND_LABEL = { block_diagram: '内部功能框图', application: '应用参考电路', pin_configuration: '管脚排布图' };

export default function FigureGallery({ pdfUrl, figures }) {
  const [thumbs, setThumbs] = useState({}); // key(page|bbox) → dataURL
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!figures?.length) return;
    let dead = false;
    (async () => {
      try {
        const doc = await loadPdf(pdfUrl);
        for (const f of figures) {
          const key = `${f.page}|${f.bbox.join(',')}`;
          if (thumbs[key]) continue;
          const page = Math.min(Math.max(1, f.page), doc.numPages);
          const { canvas } = await renderPage(doc, page, 1200);
          const url = cropToDataUrl(canvas, f.bbox, 1);
          if (dead) return;
          setThumbs((prev) => ({ ...prev, [key]: url }));
        }
        setStatus('');
      } catch (e) {
        if (!dead) setStatus(`图集渲染失败：${e.message}`);
      }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, JSON.stringify(figures?.map((f) => [f.page, f.bbox]))]);

  if (!figures?.length) return null;
  return (
    <div className="fig-gallery">
      {status && <p className="error-line">{status}</p>}
      <div className="fig-gallery-grid">
        {figures.map((f, i) => {
          const key = `${f.page}|${f.bbox.join(',')}`;
          return (
            <figure key={i} className={`fig-card ${f.confirmed ? 'confirmed' : ''}`}>
              {thumbs[key]
                ? <img src={thumbs[key]} alt={f.title} loading="lazy" />
                : <div className="stage-empty">渲染中…</div>}
              <figcaption>
                <span className={`src-badge ${f.confirmed ? 'src-parser' : 'src-fallback'}`}>
                  {f.confirmed ? '✓ 已确认' : '待确认'}
                </span>
                <span className="src-badge src-gemini">{KIND_LABEL[f.kind] || f.kind}</span>
                <span className="src-badge src-parser">p.{f.page}</span>
                <div className="fig-title">{f.title}</div>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
