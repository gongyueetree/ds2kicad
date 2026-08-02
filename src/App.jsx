// src/App.jsx — 主流程：贴 URL → 提取 → 确认（多封装/多 pinset）→ 批量生成 → 预览 → 导出
import { useEffect, useMemo, useState } from 'react';
import { apiExtract, apiGenerate } from './api.js';
import { setLocalPdf, setPdfToken } from './pdf.js';
import { applyReviewerEdit } from '../lib/validate.js';
import PinTable from './components/PinTable.jsx';
import PackageForm from './components/PackageForm.jsx';
import FigureEditor from './components/FigureEditor.jsx';
import ViewerPanel from './components/ViewerPanel.jsx';
import ExportPanel from './components/ExportPanel.jsx';
import FigureGallery from './components/FigureGallery.jsx';

const DEMO_URL = 'https://www.ti.com.cn/cn/lit/ds/symlink/tmuxl27518.pdf';

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const embedded = params.get('embed') === '1' || window.self !== window.top;

  const [url, setUrl] = useState(params.get('pdf') || DEMO_URL);
  const [file, setFile] = useState(null); // 上传模式的本地 PDF File
  const [session, setSession] = useState(null); // ezPLM 会话：{origin, nonce, jobId}
  const [reviewer, setReviewer] = useState(localStorage.getItem('ds2kicad.reviewer') || '');
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
    // 入站消息四重校验：精确 origin 白名单 + event.source 必须是父窗口 + nonce + jobId。
    // 生产构建在 vite.config.js 已强制要求 VITE_EZPLM_ORIGINS 非空，此处不存在 '*' 回退。
    const allowedOrigins = (import.meta.env.VITE_EZPLM_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
    const onMsg = (e) => {
      if (!allowedOrigins.includes(e.origin)) return;          // 无白名单 → 一律拒绝
      if (e.source !== window.parent || e.source === window) return; // 必须来自宿主父窗口
      const d = e.data;
      if (!d || typeof d.nonce !== 'string' || !d.nonce || typeof d.jobId !== 'string' || !d.jobId) return;
      setSession({ origin: e.origin, nonce: d.nonce, jobId: d.jobId });
      if (d.type === 'ezplm:ds2kicad:load' && typeof d.pdfUrl === 'string') {
        setUrl(d.pdfUrl);
        doExtract(d.pdfUrl);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExtract = async (targetUrl, fileOverride) => {
    // 通道判定：仅当文件选择器显式传入 fileOverride 时走本地通道；
    // 「开始提取」按钮/回车/postMessage 一律以 URL 输入框为准（并清除残留的文件芯片）
    const theFile = fileOverride || null;
    const useFile = !!theFile;
    const u = useFile ? `local:${theFile.name}` : (targetUrl || url).trim();
    if (!u) return;
    if (!useFile && file) setFile(null); // URL 提取开始即清除文件芯片，避免来源混淆
    setPhase('extracting');
    setError('');
    setGenResult(null);
    setExtract(null); // 清空上次结果，避免报错时残留误导
    setPkgs([]);
    setPinsets([]);
    setFigures([]);
    try {
      let payload;
      if (useFile) {
        if (theFile.size > 3 * 1024 * 1024) {
          throw new Error(`文件 ${(theFile.size / 1048576).toFixed(1)}MB 超过直传上限 3MB（平台请求体限制），请改用 URL 方式`);
        }
        const buf = await theFile.arrayBuffer();
        setLocalPdf(theFile.name, buf); // 前端图区裁剪直接用本地文件，不走代理
        // 分块 base64（避免一次性字符串拼接的内存峰值/调用栈问题）
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        payload = { pdfBase64: btoa(bin), fileName: theFile.name };
      } else {
        payload = { pdfUrl: u };
      }
      const data = await apiExtract(payload);
      setPdfToken(data.pdfToken); // 受控取回令牌（item 7）
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
  // item 10：人工修改必须留 reviewer provenance，并重算 missingFields
  const updatePkg = (next) => {
    const cur = pkgs[pkgIndex] || {};
    const changed = Object.keys(next).filter((k) => typeof next[k] === 'number' && next[k] !== cur[k]);
    let out = next;
    if (changed.length && reviewer) {
      out = { ...cur };
      for (const k of changed) out = applyReviewerEdit(out, k, next[k], reviewer, '人工确认修改');
      out = { ...next, fieldProvenance: out.fieldProvenance, missingFields: out.missingFields, relevantFields: out.relevantFields };
    }
    setPkgs(pkgs.map((p, i) => (i === pkgIndex ? out : p)));
  };
  const sharedWith = pkg ? pkgs.filter((p) => p.pinsetId === pkg.pinsetId).map((p) => p.name) : [];

  const doGenerate = async () => {
    const items = pkgs.filter((p) => p.include !== false).map((p) => ({ pkg: p, pins: pinsOf(p) }));
    if (!items.length) { setError('至少勾选一个封装'); return; }
    setPhase('generating');
    setError('');
    try {
      const result = await apiGenerate({ part, items, mock: !!extract.mock }); // mock 标志全链路传递
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
        <div className="upload-row">
          <label className="btn-secondary upload-btn">
            📄 或上传本地 PDF（≤3MB）
            <input
              type="file"
              accept="application/pdf,.pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setFile(f); doExtract(null, f); }
                e.target.value = '';
              }}
            />
          </label>
          {file && (
            <span className="src-badge src-parser">
              <button className="chip-link" title="重新提取此文件" onClick={() => doExtract(null, file)}>
                {file.name}（{(file.size / 1048576).toFixed(2)}MB）
              </button>
              <button className="btn-ghost" onClick={() => setFile(null)} title="清除">✕</button>
            </span>
          )}
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
            <p className="hint">
              审核者标识（人工修改字段需署名，否则该字段视为未验证、不可晋升）：
              <input
                style={{ width: 180, marginLeft: 8, display: 'inline-block' }}
                value={reviewer}
                placeholder="你的姓名/工号"
                onChange={(e) => { setReviewer(e.target.value); localStorage.setItem('ds2kicad.reviewer', e.target.value); }}
              />
            </p>
            <div className="part-grid">
              <label>型号<input value={part.mpn} onChange={(e) => setPart({ ...part, mpn: e.target.value })} /></label>
              <label>厂商<input value={part.manufacturer} onChange={(e) => setPart({ ...part, manufacturer: e.target.value })} /></label>
              <label className="wide">标题<input value={part.title} onChange={(e) => setPart({ ...part, title: e.target.value })} /></label>
              <label className="wide">中文描述<input value={part.description_zh} onChange={(e) => setPart({ ...part, description_zh: e.target.value })} /></label>
            </div>
          </section>

          <section className="card">
            <div className="confirm-tabs">
              {[['pins', `② 管脚表（${pinsOf(pkg).length}）`], ['pkg', `③ 封装（${includeCount}/${pkgs.length} 参与生成）`], ['figs', `④ 图区截取（${figures.filter((f) => f.confirmed).length}/${figures.length} 已确认）`]].map(([k, label]) => (
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
                reviewer={reviewer}
                onSelect={setPkgIndex}
                onChange={updatePkg}
              />
            )}
            {confirmTab === 'figs' && (
              <FigureEditor pdfUrl={extract.pdfUrl} figures={figures} aiFigures={extract.figures} onChange={setFigures} mock={extract.mock} />
            )}
          </section>

          {figures.length > 0 && (
            <section className="card">
              <h2>截取图集 <span className="sub-hint">随 ④ 的框选与确认实时更新，标注含类型/页码/标题</span></h2>
              <FigureGallery pdfUrl={extract.pdfUrl} figures={figures} />
            </section>
          )}

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
                <ExportPanel bundle={genResult} confirmed={confirmed} pdfUrl={extract.pdfUrl} embedded={embedded} session={session} />
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
