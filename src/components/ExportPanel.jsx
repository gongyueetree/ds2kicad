// src/components/ExportPanel.jsx — 导出：单文件 / ZIP 全量打包 / Part Bundle JSON v2 / ezPLM postMessage
import { useState } from 'react';
import JSZip from 'jszip';
import { exportFigures } from './FigureEditor.jsx';

/** item 8：前端二次防线 —— 拒绝路径穿越/分隔符/控制字符 */
function safePath(p) {
  return String(p ?? 'file')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '_') || 'file';
}

function download(name, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const dataUrlToBlob = (dataUrl) => fetch(dataUrl).then((r) => r.blob());

export default function ExportPanel({ bundle, confirmed, pdfUrl, embedded, session }) {
  const [busy, setBusy] = useState('');
  if (!bundle) return null;
  const okFigs = confirmed.figures.filter((f) => f.confirmed);

  // v0.8.3 item 4：正式 Part Bundle 由服务端基于 reviewed IR 生成；
  // 前端只负责下载与图片附加，不再用本地 confirmed 状态拼装权威内容。
  const serverBundleJson = () => JSON.stringify(bundle.partBundle ?? { error: 'server_bundle_missing' }, null, 2);
  const buildBundleJson = (figuresWithImages) => JSON.stringify({
    schema: 'ds2kicad.part-bundle.v2',
    mock: !!bundle.mock,                          // 演示数据标志随 bundle 落到 part-bundle
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
    nonPromotable: !!bundle.nonPromotable,        // 唯一闸门结论：ezPLM 发布接口必须拒绝
    promotionBlockReasons: bundle.reasons || [],  // 机器可读阻断原因
    warnings: bundle.warnings || []
  }, null, 2);

  const exportZip = async () => {
    setBusy('正在打包…');
    try {
      const zip = new JSZip();
      // item 8：ZIP 条目路径与内容一律取服务端 manifest/assetFiles（已做路径穿越与注入清洗），
      // 前端不再用 bundle.names.* 直接拼路径
      const serverFiles = bundle.assetFiles || [];
      const contentByPath = new Map();
      contentByPath.set(safePath(bundle.names.kicadSym), bundle.files.kicadSym);
      for (const s of bundle.symbols) contentByPath.set(safePath(`${s.name}.lib`), s.legacyLib);
      for (const it of bundle.items) {
        if (it.files.kicadMod) contentByPath.set(safePath(it.names.kicadMod), it.files.kicadMod);
        if (it.files.wrl) contentByPath.set(safePath(it.names.wrl), it.files.wrl);
      }
      for (const f of serverFiles) {
        const content = contentByPath.get(f.path);
        if (content !== undefined) zip.file(f.path, content);   // 只写服务端确认过的路径
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
      zip.file('part-bundle.json', serverBundleJson());
      if (bundle.manifest) zip.file('manifest.json', JSON.stringify(bundle.manifest, null, 2));
      const blob = await zip.generateAsync({ type: 'blob' });
      download(safePath(`${confirmed.part?.mpn || 'part'}_kicad_bundle.zip`), blob, 'application/zip');
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
        version: 3,                       // item 7：协议 v3
        jobId: bundle.jobId,
        revision: bundle.revision,
        state: bundle.state,
        assetToken: bundle.assetToken,    // 绑定 tenant/job/revision，15 分钟
        manifest: bundle.manifest,
        mock: !!bundle.mock,
        nonPromotable: !!bundle.nonPromotable,
        promotionBlockReasons: bundle.reasons || [],
        bundle: bundle.partBundle ?? null,
        // item 8：postMessage 只传服务端确认的文件清单（路径已清洗）+ 内容
        // item 7：发送真实文件内容（content + encoding），宿主可完整还原字节
        files: {
          entries: (bundle.assetFiles || []).map((f) => ({
            path: f.path, sha256: f.sha256, bytes: f.bytes,
            encoding: f.encoding || 'utf8',
            content: f.content
          }))
        }
      };
      // 出站必须精确 targetOrigin，且必须回带握手 nonce/jobId；无会话则拒发（绝不使用 '*'）
      const allowed = (import.meta.env.VITE_EZPLM_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
      const target = session?.origin && allowed.includes(session.origin) ? session.origin : null;
      if (!target) {
        setBusy('未完成 ezPLM 握手（缺少 origin/nonce/jobId），拒绝发送');
        return;
      }
      // item 7：等待宿主 ACK（3 秒超时），确保投递成功而非"发出即忘"
      const ackPromise = new Promise((resolve) => {
        const onAck = (e) => {
          if (e.origin !== target) return;
          const d = e.data;
          if (d?.type === 'ezplm:ds2kicad:ack' && d.jobId === bundle.jobId && d.nonce === session.nonce) {
            window.removeEventListener('message', onAck);
            resolve({ ok: true, receivedFiles: d.receivedFiles });
          }
        };
        window.addEventListener('message', onAck);
        setTimeout(() => { window.removeEventListener('message', onAck); resolve({ ok: false }); }, 3000);
      });
      window.parent.postMessage({ ...payload, nonce: session.nonce, hostJobId: session.jobId }, target);
      const ack = await ackPromise;
      setBusy(ack.ok
        ? `已发送并收到宿主 ACK（${ack.receivedFiles ?? payload.files.entries.length} 个文件）✓`
        : '已发送，但未在 3 秒内收到宿主 ACK —— 请确认 ezPLM 侧已实现 ezplm:ds2kicad:ack 回执');
      setTimeout(() => setBusy(''), 4000);
      return;
      setBusy('已通过 postMessage 发送给宿主页面 ✓');
      setTimeout(() => setBusy(''), 2500);
    } catch (e) {
      setBusy(`发送失败：${e.message}`);
    }
  };

  return (
    <div className="export-panel">
      <div className="export-row">
        <button className="btn-secondary" onClick={() => download(safePath(bundle.names.kicadSym), bundle.files.kicadSym)}>
          ⬇ {bundle.names.kicadSym}（{bundle.symbols.length} 符号）
        </button>
        {bundle.items.map((it, i) => it.files.kicadMod && (
          <span key={i} style={{ display: 'inline-flex', gap: 8 }}>
            <button className="btn-secondary" onClick={() => download(safePath(it.names.kicadMod), it.files.kicadMod)}>⬇ {it.names.kicadMod}</button>
            <button className="btn-secondary" onClick={() => download(safePath(it.names.wrl), it.files.wrl)}>⬇ {it.names.wrl}</button>
          </span>
        ))}
        <button className="btn-secondary" onClick={() => download('part-bundle.json', serverBundleJson(), 'application/json')}>⬇ part-bundle.json（服务端权威）</button>
        {bundle.manifest && <button className="btn-secondary" onClick={() => download('manifest.json', JSON.stringify(bundle.manifest, null, 2), 'application/json')}>⬇ manifest.json</button>}
      </div>
      <div className="export-row">
        <button className="btn-primary" onClick={exportZip}>📦 打包下载 ZIP（全部封装 + 截图 PNG）</button>
        {embedded && <button className="btn-primary" onClick={sendToEzplm}>↗ 发送到 ezPLM（postMessage）</button>}
      </div>
      <p className="hint">图区：已确认 {okFigs.length} / {confirmed.figures.length} 张将随导出打包{okFigs.length < confirmed.figures.length ? '（未确认的不导出，请回 ④ 确认）' : ''}</p>
      <div className={bundle.nonPromotable ? 'warn-box' : 'hint'} style={{ marginTop: 10 }}>
        {bundle.assetPromotion && (
          <p>
            资产级晋升：
            {Object.entries(bundle.assetPromotion).map(([k, v]) => (
              <span key={k} className={`src-badge ${v ? 'src-parser' : 'src-fallback'}`}>
                {k} {v ? '可晋升' : '待复核'}{bundle.canPublish?.[k] ? ' · 可发布' : ''}
              </span>
            ))}
          </p>
        )}
        <p>
          <b>整体状态：{bundle.nonPromotable ? '存在待复核资产' : '全部可晋升'}</b>
          {bundle.reviewer ? `　审核者：${bundle.reviewer.name}` : '　（无已认证会话）'}
        </p>
        {(bundle.reasons || []).map((r, i) => <p key={i}>· {r}</p>)}
      </div>
      {busy && <p className="status-line">{busy}</p>}
      {bundle.warnings?.length > 0 && (
        <div className="warn-box">
          {bundle.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
        </div>
      )}
    </div>
  );
}
