// src/components/ViewerPanel.jsx — KiCad 在线预览（内核移植自 eehubio/kicad_part_viewer）
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

export default function ViewerPanel({ files }) {
  const [tab, setTab] = useState('symbol');
  if (!files) return null;
  return (
    <div className="viewer-panel">
      <div className="viewer-tabs">
        {[['symbol', '原理图符号'], ['footprint', 'PCB 封装'], ['model', '3D 模型'], ['source', '源文件']].map(([k, label]) => (
          <button key={k} className={`fig-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'symbol' && <SvgStage text={files.legacyLib} render={renderLegacySymbol} />}
      {tab === 'footprint' && <SvgStage text={files.kicadMod} render={renderFootprint} />}
      {tab === 'model' && <Model3DView wrlText={files.wrl} />}
      {tab === 'source' && (
        <div className="source-grid">
          <div><h4>.kicad_sym</h4><pre>{files.kicadSym}</pre></div>
          <div><h4>.kicad_mod</h4><pre>{files.kicadMod}</pre></div>
          <div><h4>.wrl</h4><pre>{files.wrl.length > 6000 ? files.wrl.slice(0, 6000) + '\n…（截断显示）' : files.wrl}</pre></div>
        </div>
      )}
    </div>
  );
}
