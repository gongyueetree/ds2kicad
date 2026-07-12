// src/components/ExportPanel.jsx — 导出：单文件 / ZIP 打包 / Part Bundle JSON / ezPLM postMessage
import { useState } from 'react';
import JSZip from 'jszip';
import { exportFigures } from './FigureEditor.jsx';

function download(name, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then((r) => r.blob());

export default function ExportPanel({ result, confirmed, pdfUrl, embedded }) {
  const [busy, setBusy] = useState('');
  if (!result) return null;
  const { files, names } = result;

  const buildBundleJson = (figuresWithImages) => JSON.stringify({
    schema: 'ds2kicad.part-bundle.v1',
    generatedAt: new Date().toISOString(),
    source: { datasheetUrl: pdfUrl },
    part: confirmed.part,
    package: confirmed.pkg,
    pins: confirmed.pins,
    figures: (figuresWithImages || confirmed.figures).map((f) => ({
      kind: f.kind, title: f.title, page: f.page, bbox: f.bbox,
      ...(f.dataUrl ? { pngDataUrl: f.dataUrl } : {})
    })),
    files: { ...names },
    warnings: result.warnings || []
  }, null, 2);

  const exportZip = async () => {
    setBusy('正在打包…');
    try {
      const zip = new JSZip();
      zip.file(names.kicadSym, files.kicadSym);
      zip.file(names.kicadMod, files.kicadMod);
      zip.file(names.wrl, files.wrl);
      zip.file(names.legacyLib, files.legacyLib);
      let figs = confirmed.figures;
      try {
        figs = await exportFigures(pdfUrl, confirmed.figures);
        for (let i = 0; i < figs.length; i++) {
          const f = figs[i];
          const blob = await dataUrlToBlob(f.dataUrl);
          const kind = f.kind === 'block_diagram' ? 'block-diagram' : 'application';
          zip.file(`figures/${String(i + 1).padStart(2, '0')}-${kind}.png`, blob);
        }
      } catch (e) {
        console.warn('图片导出失败，ZIP 中省略图片', e);
      }
      zip.file('part-bundle.json', buildBundleJson(null));
      const blob = await zip.generateAsync({ type: 'blob' });
      download(`${confirmed.part.mpn || 'part'}_kicad_bundle.zip`, blob, 'application/zip');
    } finally {
      setBusy('');
    }
  };

  const sendToEzplm = async () => {
    setBusy('正在生成 Part Bundle…');
    try {
      let figs = confirmed.figures;
      try { figs = await exportFigures(pdfUrl, confirmed.figures); } catch { /* 无图也发送 */ }
      const payload = {
        type: 'ezplm:ds2kicad:result',
        version: 1,
        bundle: JSON.parse(buildBundleJson(figs)),
        files
      };
      window.parent.postMessage(payload, '*'); // ezPLM 侧按来源域校验；正式集成时收敛 targetOrigin
      setBusy('已通过 postMessage 发送给宿主页面 ✓');
      setTimeout(() => setBusy(''), 2500);
    } catch (e) {
      setBusy(`发送失败：${e.message}`);
    }
  };

  return (
    <div className="export-panel">
      <div className="export-row">
        <button className="btn-secondary" onClick={() => download(names.kicadSym, files.kicadSym)}>⬇ {names.kicadSym}</button>
        <button className="btn-secondary" onClick={() => download(names.kicadMod, files.kicadMod)}>⬇ {names.kicadMod}</button>
        <button className="btn-secondary" onClick={() => download(names.wrl, files.wrl)}>⬇ {names.wrl}</button>
        <button className="btn-secondary" onClick={() => download('part-bundle.json', buildBundleJson(null), 'application/json')}>⬇ part-bundle.json</button>
      </div>
      <div className="export-row">
        <button className="btn-primary" onClick={exportZip}>📦 打包下载 ZIP（含截图 PNG）</button>
        {embedded && <button className="btn-primary" onClick={sendToEzplm}>↗ 发送到 ezPLM（postMessage）</button>}
      </div>
      {busy && <p className="status-line">{busy}</p>}
      {result.warnings?.length > 0 && (
        <div className="warn-box">
          {result.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
        </div>
      )}
    </div>
  );
}
