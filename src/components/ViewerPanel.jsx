// src/components/ViewerPanel.jsx — KiCad 在线预览（内核移植自 eehubio/kicad_part_viewer）
// bundle 模型：封装选择器切换各封装的符号变体 / 封装 / 3D 预览
import { useEffect, useRef, useState } from 'react';
import { renderLegacySymbol } from '../viewer/symbolRender.js';
import { renderFootprint, createSvgViewport } from '../viewer/footprintRender.js';
import Model3DView from '../viewer/Model3DView.jsx';

function SvgStage({ text, render }) {
  const svgRef = useRef(null);
  const vpRef = useRef(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !text) return;
    render(text, svg);
    if (!vpRef.current) vpRef.current = createSvgViewport(svg);
    else vpRef.current.reset();
  }, [text, render]);
  return (
    <div className="svg-stage">
      <svg ref={svgRef} viewBox="0 0 800 520" />
      <div className="stage-help">滚轮缩放 · 拖拽平移 · 双击复位</div>
    </div>
  );
}

export default function ViewerPanel({ bundle }) {
  const [tab, setTab] = useState('symbol');
  const [itemIdx, setItemIdx] = useState(0);
  if (!bundle?.items?.length) return null;
  const items = bundle.items;
  const item = items[Math.min(itemIdx, items.length - 1)];
  const symbol = bundle.symbols?.find((s) => s.name === item.symbolName) || bundle.symbols?.[0];

  return (
    <div className="viewer-panel">
      {items.length > 1 && (
        <div className="viewer-tabs">
          <span className="hint" style={{ marginRight: 4 }}>封装：</span>
          {items.map((it, i) => (
            <button key={i} className={`fig-tab ${i === itemIdx ? 'active' : ''}`} onClick={() => setItemIdx(i)}>
              {it.pkgName}
            </button>
          ))}
        </div>
      )}
      <div className="viewer-tabs">
        {[['symbol', `原理图符号（${item.symbolName}）`], ['footprint', 'PCB 封装'], ['model', '3D 模型'], ['source', '源文件']].map(([k, label]) => (
          <button key={k} className={`fig-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'symbol' && <SvgStage text={symbol?.legacyLib} render={renderLegacySymbol} />}
      {tab === 'footprint' && (item.files.kicadMod
        ? <SvgStage text={item.files.kicadMod} render={renderFootprint} />
        : <div className="stage-empty">{item.family === 'bga' ? 'BGA/DSBGA 封装暂不支持自动生成（仅符号变体）' : '该封装无封装文件'}</div>)}
      {tab === 'model' && (item.files.wrl
        ? <Model3DView wrlText={item.files.wrl} />
        : <div className="stage-empty">该封装无 3D 模型</div>)}
      {tab === 'source' && (
        <div className="source-grid">
          <div><h4>{bundle.names.kicadSym}（含 {bundle.symbols.length} 个符号）</h4><pre>{bundle.files.kicadSym}</pre></div>
          <div><h4>{item.names.kicadMod || '—'}</h4><pre>{item.files.kicadMod || '（无）'}</pre></div>
          <div><h4>{item.names.wrl || '—'}</h4><pre>{item.files.wrl || '（无）'}</pre></div>
        </div>
      )}
    </div>
  );
}
