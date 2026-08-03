// src/components/FigureGallery.jsx — 截取图集：框图/管脚排布/应用电路的裁剪图 + 标注展示
// 随 ④ 的框选与确认实时更新；缩略图由 pdf.js 本地渲染裁剪（1200px 宽）
import { useEffect, useState } from 'react';
import { loadPdf, renderPage, cropToDataUrl } from '../pdf.js';

const KIND_LABEL = { block_diagram: '内部功能框图', application: '应用参考电路', pin_configuration: '管脚排布图' };

export default function FigureGallery({ pdfUrl, figures }) {
  const [thumbs, setThumbs] = useState({}); // key(page|bbox) → dataURL
  const [status, setStatus] = useState('');
  const [diag, setDiag] = useState({});   // 诊断信息：页码/bbox/是否空白

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
          let canvas;
          try {
            ({ canvas } = await renderPage(doc, page, 1200));
          } catch (e) {
            setDiag((prev) => ({ ...prev, [key]: { page, bbox: f.bbox, error: `第 ${page} 页渲染失败：${e.message}` } }));
            continue;
          }
          const url = cropToDataUrl(canvas, f.bbox, 1);
          if (dead) return;
          // 诊断：检测裁剪结果是否近乎全白（bbox 落在空白区/页码错位的典型表现）
          let blank = false;
          try {
            const probe = document.createElement('canvas');
            probe.width = 32; probe.height = 32;
            const pctx = probe.getContext('2d', { willReadFrequently: true });
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
            pctx.drawImage(img, 0, 0, 32, 32);
            const data = pctx.getImageData(0, 0, 32, 32).data;
            let nonWhite = 0;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
            }
            blank = nonWhite < 8;
          } catch { /* 探测失败不影响展示 */ }
          setThumbs((prev) => ({ ...prev, [key]: url }));
          setDiag((prev) => ({ ...prev, [key]: { page, bbox: f.bbox, blank, pageCount: doc.numPages } }));
        }
        setStatus('');
      } catch (e) {
        if (dead) return;
        // 把失败原因落到每张卡片上，避免"整片空白但没有任何提示"
        const msg = /Unexpected server response \((\d+)\)/.test(e.message)
          ? `PDF 取回失败（HTTP ${RegExp.$1}）：${RegExp.$1 === '409' ? '该作业没有缓存 PDF 字节，请重新提取' : RegExp.$1 === '401' || RegExp.$1 === '403' ? '会话无权访问该作业' : e.message}`
          : `PDF 加载失败：${e.message}`;
        setStatus(msg);
        setDiag((prev) => {
          const next = { ...prev };
          for (const f of figures) next[`${f.page}|${f.bbox.join(',')}`] = { page: f.page, bbox: f.bbox, error: msg };
          return next;
        });
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
                {diag[key]?.error && (
                  <span className="src-badge src-fallback">⚠ {diag[key].error}</span>
                )}
                {diag[key]?.blank && (
                  <span className="src-badge src-fallback" title={`page=${diag[key].page}/${diag[key].pageCount} bbox=${JSON.stringify(diag[key].bbox)}`}>
                    ⚠ 裁剪区域为空白（p.{diag[key].page}，bbox {diag[key].bbox.map((n) => n.toFixed(2)).join(',')}）— 请在 ④ 重新框选
                  </span>
                )}
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
