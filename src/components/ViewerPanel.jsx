// src/components/ViewerPanel.jsx — 三栏并排预览（符号 | 封装 | 3D）+ 符号↔封装管脚联动高亮
// 渲染内核移植自 eehubio/kicad_part_viewer
import { useEffect, useRef, useState } from 'react';
import { renderLegacySymbol } from '../viewer/symbolRender.js';
import { renderFootprint, createSvgViewport } from '../viewer/footprintRender.js';
import Model3DView from '../viewer/Model3DView.jsx';

/** 通用 SVG 面板：渲染 + 视口交互 + data-pin 点击委托 + 高亮同步 */
function SvgStage({ text, render, selectedPin, onPinClick, viewBox = '0 0 800 560' }) {
  const svgRef = useRef(null);
  const vpRef = useRef(null);

  const clickRef = useRef(onPinClick);
  clickRef.current = onPinClick;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !text) return;
    render(text, svg);
    if (!vpRef.current) {
      vpRef.current = createSvgViewport(svg);
      let down = null;
      svg.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, target: e.target }; });
      svg.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        const hit = moved < 6 && down.target?.closest?.('[data-pin]');
        down = null;
        if (hit && clickRef.current) clickRef.current(hit.getAttribute('data-pin'));
      });
    } else {
      vpRef.current.reset();
    }
  }, [text, render]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll('[data-pin]').forEach((el) => {
      el.classList.toggle('pin-active', el.getAttribute('data-pin') === selectedPin);
    });
  }, [selectedPin, text]);

  return (
    <div className="svg-stage">
      <svg ref={svgRef} viewBox={viewBox} />
      <div className="stage-help">滚轮缩放 · 拖拽平移 · 双击复位 · 点击管脚联动</div>
    </div>
  );
}

function GenerationBlocked({ item, kind }) {
  const warnings = Array.isArray(item?.warnings) ? item.warnings : [];
  const reason = warnings.find((w) => /blocked_missing_geometry|unsupported_package|无法确定性|不受支持/i.test(w));
  const missing = Array.isArray(item?.missingFields) ? item.missingFields.filter(Boolean) : [];
  const title = kind === '3d' ? '未生成 3D 模型' : '未生成 PCB 封装';
  const fallback = item?.family === 'bga'
    ? 'BGA/DSBGA 暂不支持自动生成（仅符号变体）'
    : '当前封装的确定性生成条件尚未满足。';
  return (
    <div className="stage-empty" style={{ padding: '18px', lineHeight: 1.55 }}>
      <b>{title}</b>
      <div style={{ marginTop: 8 }}>{reason || fallback}</div>
      {missing.length > 0 && <div style={{ marginTop: 8 }}>缺少/未确认参数：<code>{missing.join(', ')}</code></div>}
      <div className="hint" style={{ marginTop: 8 }}>封装图只是证据；必须先提取出可计算的焊盘/本体几何参数，系统才会生成 KiCad 文件。</div>
    </div>
  );
}

export default function ViewerPanel({ bundle }) {
  const [itemIdx, setItemIdx] = useState(0);
  const [selectedPin, setSelectedPin] = useState(null);
  if (!bundle?.items?.length) return null;
  const items = bundle.items;
  const item = items[Math.min(itemIdx, items.length - 1)];
  const symbol = bundle.symbols?.find((s) => s.name === item.symbolName) || bundle.symbols?.[0];
  const pinInfo = symbol?.pins?.find((p) => p.number === selectedPin);

  const pickItem = (i) => { setItemIdx(i); setSelectedPin(null); };
  const togglePin = (num) => setSelectedPin((cur) => (cur === num ? null : num));

  return (
    <div className="viewer-panel">
      {items.length > 1 && (
        <div className="viewer-tabs">
          <span className="hint" style={{ marginRight: 4 }}>封装：</span>
          {items.map((it, i) => (
            <button key={i} className={`fig-tab ${i === itemIdx ? 'active' : ''}`} onClick={() => pickItem(i)}>
              {it.pkgName}
            </button>
          ))}
        </div>
      )}
      <p className="hint pin-info-line">
        {pinInfo
          ? <>选中管脚 <b>{pinInfo.number}</b> · {pinInfo.name} · {pinInfo.type}{pinInfo.description ? ` — ${pinInfo.description}` : ''}（再次点击取消）</>
          : '点击符号管脚或封装焊盘，两侧对应位置联动高亮'}
      </p>
      <div className="viewer-grid">
        <div className="viewer-cell">
          <h4>原理图符号（{item.symbolName}）</h4>
          <SvgStage text={symbol?.legacyLib} render={renderLegacySymbol} selectedPin={selectedPin} onPinClick={togglePin} />
        </div>
        <div className="viewer-cell">
          <h4>PCB 封装</h4>
          {item.files.kicadMod
            ? <SvgStage text={item.files.kicadMod} render={renderFootprint} selectedPin={selectedPin} onPinClick={togglePin} />
            : <GenerationBlocked item={item} kind="footprint" />}
        </div>
        <div className="viewer-cell">
          <h4>3D 模型</h4>
          {item.files.wrl
            ? <Model3DView wrlText={item.files.wrl} />
            : <GenerationBlocked item={item} kind="3d" />}
        </div>
      </div>
      <details className="source-details">
        <summary className="hint">源文件（{bundle.names.kicadSym} · {item.names.kicadMod || '—'} · {item.names.wrl || '—'}）</summary>
        <div className="source-grid">
          <div><h4>{bundle.names.kicadSym}（含 {bundle.symbols.length} 个符号）</h4><pre>{bundle.files.kicadSym}</pre></div>
          <div><h4>{item.names.kicadMod || '—'}</h4><pre>{item.files.kicadMod || '（无）'}</pre></div>
          <div><h4>{item.names.wrl || '—'}</h4><pre>{item.files.wrl || '（无）'}</pre></div>
        </div>
      </details>
    </div>
  );
}
