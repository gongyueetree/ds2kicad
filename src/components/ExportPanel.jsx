// src/components/ExportPanel.jsx — 导出：单文件 / ZIP 全量打包 / Part Bundle JSON v2 / ezPLM postMessage
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

export default function ExportPanel({ bundle, confirmed, pdfUrl, embedded }) {
  const [busy, setBusy] = useState('');
  if (!bundle) return null;
  const okFigs = confirmed.figures.filter((f) => f.confirmed);

  const buildBundleJson = (figuresWithImages) => JSON.stringify({
    schema: 'ds2kicad.part-bundle.v2',
    generatedAt: new Date().toISOString(),
    source: { datasheetUrl: pdfUrl },
    part: confirmed.part,
    pinsets: confirmed.pinsets,
    packages: confirmed.packages.map((p) => ({ ...p })),
    symbols: bundle.symbols.map((s) => ({ name: s.name, packages: s.packages })),
    items: bundle.items.map((it) => ({ pkgName: it.pkgName, symbolName: it.symbolName, files: it.names })),
    figures: (figuresWithImages || okFigs).map((f) => ({
      kind: f.kind, title: f.title, page: f.page, bbox: f.bbox,
      ...(f.dataUrl ? { pngDataUrl: f.dataUrl } : {})
    })),
    files: { kicadSym: bundle.names.kicadSym },
    warnings: bundle.warnings || []
  }, null, 2);

  const exportZip = async () => {
    setBusy('正在打包…');
    try {
      const zip = new JSZip();
      zip.file(bundle.names.kicadSym, bundle.files.kicadSym);
      for (const s of bundle.symbols) zip.file(`${s.name}.lib`, s.legacyLib);
      for (const it of bundle.items) {
        if (it.files.kicadMod) zip.file(it.names.kicadMod, it.files.kicadMod);
        if (it.files.wrl) zip.file(it.names.wrl, it.files.wrl);
      }
      try {
        const figs = await exportFigures(pdfUrl, okFigs);
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
      let figs = okFigs;
      try { figs = await exportFigures(pdfUrl, okFigs); } catch { /* 无图也发送 */ }
      const payload = {
        type: 'ezplm:ds2kicad:result',
        version: 2,
        bundle: JSON.parse(buildBundleJson(figs)),
        files: {
          kicadSym: bundle.files.kicadSym,
          items: bundle.items.map((it) => ({ pkgName: it.pkgName, ...it.files, ...it.names }))
        }
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
        <button className="btn-secondary" onClick={() => download(bundle.names.kicadSym, bundle.files.kicadSym)}>
          ⬇ {bundle.names.kicadSym}（{bundle.symbols.length} 符号）
        </button>
        {bundle.items.map((it, i) => it.files.kicadMod && (
          <span key={i} style={{ display: 'inline-flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => download(it.names.kicadMod, it.files.kicadMod)}>⬇ {it.names.kicadMod}</button>
            <button className="btn-secondary" onClick={() => download(it.names.wrl, it.files.wrl)}>⬇ {it.names.wrl}</button>
          </span>
        ))}
        <button className="btn-secondary" onClick={() => download('part-bundle.json', buildBundleJson(null), 'application/json')}>⬇ part-bundle.json</button>
      </div>
      <div className="export-row">
        <button className="btn-primary" onClick={exportZip}>📦 打包下载 ZIP（全部封装 + 截图 PNG）</button>
        {embedded && <button className="btn-primary" onClick={sendToEzplm}>↗ 发送到 ezPLM（postMessage）</button>}
      </div>
      <p className="hint">图区：已确认 {okFigs.length} / {confirmed.figures.length} 张将随导出打包{okFigs.length < confirmed.figures.length ? '（未确认的不导出，请回 ④ 确认）' : ''}</p>
      {busy && <p className="status-line">{busy}</p>}
      {bundle.warnings?.length > 0 && (
        <div className="warn-box">
          {bundle.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
        </div>
      )}
    </div>
  );
}
