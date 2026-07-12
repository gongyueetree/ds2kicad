// src/App.jsx — 主流程：贴 URL → 提取 → 确认（多封装/多 pinset）→ 批量生成 → 预览 → 导出
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
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [extract, setExtract] = useState(null);
  const [pkgs, setPkgs] = useState([]);        // 每项含 include 标志与 pinsetId
  const [pkgIndex, setPkgIndex] = useState(0);
  const [pinsets, setPinsets] = useState([]);  // [{id,label,pins}]
  const [figures, setFigures] = useState([]);
  const [part, setPart] = useState(null);
  const [genResult, setGenResult] = useState(null);
  const [confirmTab, setConfirmTab] = useState('pins');

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
      // pinsets 兼容：老响应无 pinsets 时由 pins 合成单一集
      const sets = Array.isArray(data.pinsets) && data.pinsets.length
        ? data.pinsets
        : [{ id: 'default', label: '', pins: data.pins || [] }];
      const validIds = new Set(sets.map((s) => s.id));
      const packages = (data.packages || []).map((p) => ({
        ...p,
        pinsetId: validIds.has(p.pinsetId) ? p.pinsetId : sets[0].id,
        include: true
      }));
      setExtract({ ...data, pdfUrl: u });
      setPart(data.part);
      setPinsets(sets);
      setPkgs(packages);
      setFigures(data.figures);
      setPkgIndex(Math.min(data.recommendedPackageIndex || 0, packages.length - 1));
      setPhase('confirm');
      setConfirmTab('pins');
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
  };

  const pkg = pkgs[pkgIndex] || null;
  const pinsOf = (p) => pinsets.find((s) => s.id === p?.pinsetId)?.pins || pinsets[0]?.pins || [];
  const setPinsOf = (p, pins) =>
    setPinsets(pinsets.map((s) => (s.id === (p?.pinsetId || pinsets[0]?.id) ? { ...s, pins } : s)));
  const updatePkg = (next) => setPkgs(pkgs.map((p, i) => (i === pkgIndex ? next : p)));
  const sharedWith = pkg ? pkgs.filter((p) => p.pinsetId === pkg.pinsetId).map((p) => p.name) : [];

  const doGenerate = async () => {
    const items = pkgs.filter((p) => p.include !== false).map((p) => ({ pkg: p, pins: pinsOf(p) }));
    if (!items.length) { setError('至少勾选一个封装'); return; }
    setPhase('generating');
    setError('');
    try {
      const result = await apiGenerate({ part, items });
      setGenResult(result);
      setPhase('confirm');
      setTimeout(() => document.getElementById('preview-anchor')?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (e) {
      setError(e.message);
      setPhase('confirm');
    }
  };

  const confirmed = { part, packages: pkgs, pinsets, figures };
  const includeCount = pkgs.filter((p) => p.include !== false).length;

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
          <p className="hint">
            已提取 {part?.mpn}
            {extract.meta?.mode === 'degraded'
              ? ` — ${extract.meta.warning}`
              : `（${extract.meta?.model} · PDF ${Math.round((extract.meta?.pdfBytes || 0) / 1024)} KB）`}
          </p>
        )}
        {extract?.sources && (
          <p className="source-line">
            来源：
            {[['管脚表', 'pins'], ['封装尺寸', 'packages'], ['图区定位', 'figures'], ['器件信息', 'part']].map(([label, k]) => (
              <span key={k} className={`src-badge src-${extract.sources[k]}`}>
                {label} · {{ parser: '程序解析', gemini: 'AI 提取', fallback: '默认值' }[extract.sources[k]] || extract.sources[k]}
              </span>
            ))}
          </p>
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
              {[['pins', `② 管脚表（${pinsOf(pkg).length}）`], ['pkg', `③ 封装（${includeCount}/${pkgs.length} 参与生成）`], ['figs', `④ 图区截取（${figures.length}）`]].map(([k, label]) => (
                <button key={k} className={`fig-tab ${confirmTab === k ? 'active' : ''}`} onClick={() => setConfirmTab(k)}>{label}</button>
              ))}
            </div>
            {confirmTab === 'pins' && pkg && (
              <>
                {pinsets.length > 1 && (
                  <p className="hint">
                    当前编辑封装 <b>{pkg.name}</b> 的管脚定义集「{pkg.pinsetId}」
                    {sharedWith.length > 1 && <>（与 {sharedWith.join(' / ')} 共享，修改同步生效）</>}
                    ；切换封装请到 ③。
                  </p>
                )}
                <PinTable pins={pinsOf(pkg)} onChange={(p) => setPinsOf(pkg, p)} />
              </>
            )}
            {confirmTab === 'pkg' && pkg && (
              <PackageForm
                packages={pkgs}
                selectedIndex={pkgIndex}
                pkg={pkg}
                pinsets={pinsets}
                onSelect={setPkgIndex}
                onChange={updatePkg}
              />
            )}
            {confirmTab === 'figs' && (
              <FigureEditor pdfUrl={extract.pdfUrl} figures={figures} aiFigures={extract.figures} onChange={setFigures} mock={extract.mock} />
            )}
          </section>

          <section className="card generate-card">
            <button className="btn-primary btn-big" disabled={phase === 'generating'} onClick={doGenerate}>
              {phase === 'generating' ? '生成中…' : `✓ 确认无误，生成 ${includeCount} 个封装的 KiCad 符号 / 封装 / 3D`}
            </button>
          </section>

          <div id="preview-anchor" />
          {genResult && (
            <>
              <section className="card">
                <h2>⑤ 在线预览（KiCad Part Viewer 内核）</h2>
                <ViewerPanel bundle={genResult} />
              </section>
              <section className="card">
                <h2>⑥ 导出</h2>
                <ExportPanel bundle={genResult} confirmed={confirmed} pdfUrl={extract.pdfUrl} embedded={embedded} />
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
