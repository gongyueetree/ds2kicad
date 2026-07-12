// src/App.jsx — 主流程：贴 URL → AI 提取 → 用户确认 → 确定性生成 → 在线预览 → 导出/回传 ezPLM
import { useEffect, useMemo, useState } from 'react';
import { apiExtract, apiGenerate } from './api.js';
import PinTable from './components/PinTable.jsx';
import PackageForm from './components/PackageForm.jsx';
import FigureEditor from './components/FigureEditor.jsx';
import ViewerPanel from './components/ViewerPanel.jsx';
import ExportPanel from './components/ExportPanel.jsx';

const DEMO_URL = 'https://www.ti.com.cn/cn/lit/ds/symlink/tmuxl27518.pdf';

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const embedded = params.get('embed') === '1' || window.self !== window.top;

  const [url, setUrl] = useState(params.get('pdf') || DEMO_URL);
  const [phase, setPhase] = useState('idle'); // idle | extracting | confirm | generating
  const [error, setError] = useState('');
  const [extract, setExtract] = useState(null);   // API 原始返回
  const [pins, setPins] = useState([]);
  const [pkgIndex, setPkgIndex] = useState(0);
  const [pkg, setPkg] = useState(null);
  const [figures, setFigures] = useState([]);
  const [part, setPart] = useState(null);
  const [genResult, setGenResult] = useState(null);
  const [confirmTab, setConfirmTab] = useState('pins');

  // ezPLM 集成：宿主可 postMessage 注入 PDF URL
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data;
      if (d && d.type === 'ezplm:ds2kicad:load' && typeof d.pdfUrl === 'string') {
        setUrl(d.pdfUrl);
        doExtract(d.pdfUrl);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExtract = async (targetUrl) => {
    const u = (targetUrl || url).trim();
    if (!u) return;
    setPhase('extracting');
    setError('');
    setGenResult(null);
    try {
      const data = await apiExtract(u);
      setExtract({ ...data, pdfUrl: u });
      setPart(data.part);
      setPins(data.pins);
      setFigures(data.figures);
      const idx = data.recommendedPackageIndex || 0;
      setPkgIndex(idx);
      setPkg(data.packages[idx]);
      setPhase('confirm');
      setConfirmTab('pins');
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
  };

  const selectPackage = (i) => {
    setPkgIndex(i);
    setPkg(extract.packages[i]);
  };

  const doGenerate = async () => {
    setPhase('generating');
    setError('');
    try {
      const result = await apiGenerate({ part, pkg, pins });
      setGenResult(result);
      setPhase('confirm');
      setTimeout(() => document.getElementById('preview-anchor')?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (e) {
      setError(e.message);
      setPhase('confirm');
    }
  };

  const confirmed = { part, pkg, pins, figures };

  return (
    <div className={`app ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <header>
          <div>
            <h1>DS2KiCad <span className="sub">数据手册 → KiCad 符号 / 封装 / 3D / 图区提取</span></h1>
            <p>AI 负责语义提取 · 确定性规则引擎负责几何生成 · 全部结果经人工确认</p>
          </div>
          <span className="badge">eetree · ezPLM 插件预备版</span>
        </header>
      )}

      <section className="card url-card">
        <label className="url-label">元器件 PDF 数据手册 URL</label>
        <div className="url-row">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.ti.com/lit/ds/symlink/xxxx.pdf"
            onKeyDown={(e) => e.key === 'Enter' && phase !== 'extracting' && doExtract()}
          />
          <button className="btn-primary" disabled={phase === 'extracting'} onClick={() => doExtract()}>
            {phase === 'extracting' ? '提取中…（约 20–60 秒）' : '开始提取'}
          </button>
        </div>
        {error && <p className="error-line">✕ {error}</p>}
        {extract?.mock && (
          <p className="mock-badge">MOCK 演示数据 — {extract.meta?.reason}，管脚与尺寸为演示占位，配置 GEMINI_API_KEY 后为真实提取</p>
        )}
        {extract && !extract.mock && (
          <p className="hint">已提取 {part?.mpn}（{extract.meta?.model} · PDF {Math.round((extract.meta?.pdfBytes || 0) / 1024)} KB）</p>
        )}
      </section>

      {phase !== 'idle' && extract && (
        <>
          <section className="card">
            <h2>① 器件信息确认</h2>
            <div className="part-grid">
              <label>型号<input value={part.mpn} onChange={(e) => setPart({ ...part, mpn: e.target.value })} /></label>
              <label>厂商<input value={part.manufacturer} onChange={(e) => setPart({ ...part, manufacturer: e.target.value })} /></label>
              <label className="wide">标题<input value={part.title} onChange={(e) => setPart({ ...part, title: e.target.value })} /></label>
              <label className="wide">中文描述<input value={part.description_zh} onChange={(e) => setPart({ ...part, description_zh: e.target.value })} /></label>
            </div>
          </section>

          <section className="card">
            <div className="confirm-tabs">
              {[['pins', `② 管脚表（${pins.length}）`], ['pkg', '③ 封装参数'], ['figs', `④ 图区截取（${figures.length}）`]].map(([k, label]) => (
                <button key={k} className={`fig-tab ${confirmTab === k ? 'active' : ''}`} onClick={() => setConfirmTab(k)}>{label}</button>
              ))}
            </div>
            {confirmTab === 'pins' && <PinTable pins={pins} onChange={setPins} />}
            {confirmTab === 'pkg' && pkg && (
              <PackageForm packages={extract.packages} selectedIndex={pkgIndex} pkg={pkg} onSelect={selectPackage} onChange={setPkg} />
            )}
            {confirmTab === 'figs' && (
              <FigureEditor pdfUrl={extract.pdfUrl} figures={figures} aiFigures={extract.figures} onChange={setFigures} mock={extract.mock} />
            )}
          </section>

          <section className="card generate-card">
            <button className="btn-primary btn-big" disabled={phase === 'generating'} onClick={doGenerate}>
              {phase === 'generating' ? '生成中…' : '✓ 确认无误，生成 KiCad 符号 / 封装 / 3D'}
            </button>
          </section>

          <div id="preview-anchor" />
          {genResult && (
            <>
              <section className="card">
                <h2>⑤ 在线预览（KiCad Part Viewer 内核）</h2>
                <ViewerPanel files={genResult.files} />
              </section>
              <section className="card">
                <h2>⑥ 导出</h2>
                <ExportPanel result={genResult} confirmed={confirmed} pdfUrl={extract.pdfUrl} embedded={embedded} />
              </section>
            </>
          )}
        </>
      )}

      {!embedded && (
        <footer>
          <p>DS2KiCad · 在线预览内核移植自 <a href="https://github.com/eehubio/kicad_part_viewer" target="_blank" rel="noreferrer">eehubio/kicad_part_viewer</a> · 生成结果投产前请以数据手册为准复核</p>
        </footer>
      )}
    </div>
  );
}
