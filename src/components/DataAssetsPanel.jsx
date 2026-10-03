import { useEffect, useState } from 'react';
import { apiDataReview, apiGet } from '../api.js';
import './data-assets.css';
const NATURES={unknown:'待确定',absolute_maximum:'绝对最大额定值',recommended:'推荐工作条件',guaranteed:'保证指标',typical:'典型值',characterized:'表征值'};
const STATUS={pending:'待审核',accepted:'已接受',rejected:'已拒绝'};
const STAGE={complete:'已处理',published:'已发布',pending:'待处理',needs_review:'待核对',legacy:'旧版数据'};
const shortValue=o=>o.normalized?['min','typ','max'].filter(k=>o.normalized.value[k]!==null).map(k=>`${k}: ${o.normalized.value[k]}`).join(' / ')+' '+o.normalized.unit:'数值待修正';
function download(value,name){const u=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
export default function DataAssetsPanel({jobId,revision,onRevision,disabled=false}) {
  const [view,setView]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[category,setCategory]=useState(''),[expanded,setExpanded]=useState(null),[draft,setDraft]=useState(null),[identity,setIdentity]=useState({mpn:'',manufacturer:''});
  useEffect(()=>{let live=true;apiGet(`/api/data-assets?jobId=${encodeURIComponent(jobId)}`).then(v=>{if(live){setView(v);setIdentity(v.dataAssets.identity);setCategory(v.dataAssets.classification.categoryId);setError('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[jobId,revision]);
  async function act(payload){setBusy(true);setError('');try{const v=await apiDataReview({jobId,expectedRevision:view.revision,reason,...payload});setView(v);setCategory(v.dataAssets.classification.categoryId);onRevision?.(v.revision);setExpanded(null);setDraft(null);}catch(e){setError(e.message);}finally{setBusy(false);}}
  function edit(o){setExpanded(o.id);setDraft({id:o.id,status:'accepted',value:{...(o.normalized?.value || o.raw.value)},unit:o.normalized?.unit || o.raw.unit,nature:o.nature,conditions:o.conditions,appliesTo:o.appliesTo.join(', '),page:o.evidence.page || '',quotedText:o.evidence.quotedText});}
  async function exportFile(type){try{const data=await apiGet(`/api/data-assets?jobId=${encodeURIComponent(jobId)}&export=${type}`);download(data,`component-data-${type}.json`);}catch(e){setError(e.message);}}
  const blocked=busy||disabled;
  if(!view)return <section className="card"><h2>器件数据资产</h2><p role="status">{error||'正在加载参数资产…'}</p></section>;
  const d=view.dataAssets,s=view.summary,canReview=view.canReview&&!blocked;
  return <section className="card data-assets-panel">
    <div className="asset-heading"><div><span className="asset-eyebrow">COMPONENT DATA ASSETS</span><h2>器件数据资产</h2><p className="hint">分类、参数与证据独立审核，支持单独发布和导出。</p></div><span className="asset-version">{d.publications.length?`${d.publications.length} 个已发布版本`:'待审核'}</span></div>
    <ol className="asset-workflow">{view.workflow.map(stage=><li key={stage.id} className={`stage-${stage.status}`}><span>{String(stage.id).padStart(2,'0')}</span><b>{stage.label}</b><small>{STAGE[stage.status]}</small></li>)}</ol>
    <div className="asset-metrics"><div><b>{s.total}</b><span>参数候选</span></div><div><b>{s.accepted}</b><span>已接受</span></div><div><b>{s.pending}</b><span>待审核</span></div><div><b>{s.missing.length}</b><span>模板待补字段</span></div></div>
    {d.sourceDocument.partial&&<p className="warn-box">部分页面尚未解析或未进入模型提取，未发现的参数不代表手册中不存在。</p>}
    {view.canEditIdentity&&<div className="asset-identity"><label>型号<input aria-label="参数资产型号" value={identity.mpn} disabled={!canReview} onChange={e=>setIdentity({...identity,mpn:e.target.value})}/></label><label>厂商<input aria-label="参数资产厂商" value={identity.manufacturer} disabled={!canReview} onChange={e=>setIdentity({...identity,manufacturer:e.target.value})}/></label><button className="btn-secondary" disabled={!canReview||reason.trim().length<2||!identity.mpn.trim()||!identity.manufacturer.trim()} onClick={()=>act({action:'review',identity})}>保存器件身份</button></div>}
    <div className="asset-toolbar"><label>器件类别<select aria-label="器件类别" value={category} onChange={e=>setCategory(e.target.value)} disabled={!canReview}><option value="unknown">待分类</option>{view.schemas.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label><button className="btn-secondary" disabled={!canReview||category==='unknown'||reason.trim().length<2} onClick={()=>act({action:'review',categoryId:category})}>确认类别</button><span className="hint">{d.classification.status==='confirmed'?'类别已确认':'自动分类待复核'} · 模板 {d.registryVersion}</span></div>
    <label className="asset-reason">审核 / 发布理由<input aria-label="参数审核理由" value={reason} onChange={e=>setReason(e.target.value)} placeholder="例如：对照手册电气参数表与脚注核对" /></label>
    {!view.canReview&&<p className="hint">当前可查看和导出草稿。确认参数需要组织审核权限。</p>}
    {s.total===0&&<div className="asset-empty"><b>尚未提取到可归一的参数</b><p>可切换到完整提取以使用模型读表，或由审核人员补充参数。系统不会填入默认性能值。</p></div>}
    <div className="asset-observations">{d.observations.map(o=><article key={o.id} className="asset-observation">
      <div className="observation-top"><div><b>{o.label||o.parameterId}</b><p>{shortValue(o)}</p></div><span className={`asset-status status-${o.review.status}`}>{STATUS[o.review.status]}</span></div>
      <div className="observation-meta"><span>{NATURES[o.nature]}</span><span>第 {o.evidence.page||'?'} 页</span><span>{o.appliesTo.join(', ')||'适用型号待确认'}</span></div>
      <p className="hint">测试条件：{o.conditions||'待核对表头与脚注'}</p>
      <details><summary>原文证据与提取记录</summary><blockquote>{o.evidence.quotedText||'未提供原文引用'}</blockquote><p className="hint">{o.evidence.verifiedText?'原文文本已匹配':'需人工核对来源'} · {o.evidence.extractor}</p><code>{o.evidence.documentSha256}</code>{o.issues.length>0&&<p className="hint">待处理：{o.issues.join(' · ')}</p>}</details>
      {expanded===o.id&&draft ? <div className="asset-edit">
        <div className="asset-value-grid">{['min','typ','max'].map(k=><label key={k}>{k.toUpperCase()}<input aria-label={`${o.label} ${k}`} value={draft.value[k]??''} onChange={e=>setDraft({...draft,value:{...draft.value,[k]:e.target.value||null}})}/></label>)}<label>单位<input aria-label="参数单位" value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})}/></label></div>
        <label>指标性质<select aria-label="指标性质" value={draft.nature} onChange={e=>setDraft({...draft,nature:e.target.value})}>{Object.entries(NATURES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label>测试条件<textarea aria-label="测试条件" value={draft.conditions} onChange={e=>setDraft({...draft,conditions:e.target.value})}/></label>
        <label>适用型号（逗号分隔）<input aria-label="适用型号" value={draft.appliesTo} onChange={e=>setDraft({...draft,appliesTo:e.target.value})}/></label>
        <label>原文页码<input aria-label="原文页码" type="number" min="1" value={draft.page} onChange={e=>setDraft({...draft,page:e.target.value})}/></label>
        <label>原文证据<textarea aria-label="原文证据" value={draft.quotedText} onChange={e=>setDraft({...draft,quotedText:e.target.value})}/></label>
        <div className="asset-actions"><button className="btn-primary" disabled={!canReview||reason.trim().length<2} onClick={()=>act({action:'review',decisions:[{...draft,page:Number(draft.page),appliesTo:draft.appliesTo.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}]})}>保存并接受参数</button><button className="btn-secondary" onClick={()=>setExpanded(null)}>取消</button></div>
      </div>:<div className="asset-actions"><button className="btn-secondary" disabled={!canReview} onClick={()=>edit(o)}>核对 / 修正</button><button className="btn-ghost" disabled={!canReview||reason.trim().length<2} onClick={()=>act({action:'review',decisions:[{id:o.id,status:'rejected'}]})}>拒绝候选</button></div>}
    </article>)}</div>
    {view.canReview&&<AddObservation schemas={view.schemas} category={d.classification.categoryId} disabled={blocked||reason.trim().length<2} onAdd={raw=>act({action:'review',addObservations:[raw]})}/>}
    <div className="asset-actions asset-export"><button className="btn-secondary" onClick={()=>exportFile('draft')}>导出资产草稿 JSON</button><button className="btn-primary" disabled={!view.canPublish||blocked||s.pending>0||!s.accepted||reason.trim().length<2||d.classification.status!=='confirmed'} onClick={()=>act({action:'publish'})}>发布参数资产</button><button className="btn-secondary" disabled={!d.publications.length} onClick={()=>exportFile('published')}>下载已发布版本</button></div>
    {d.publications.length>0&&<p className="hint">下载内容为最新已发布快照；后续审核修改需再次发布才会更新。</p>}
    {error&&<p className="error-line" role="alert">{error}</p>}{busy&&<p role="status">正在保存…</p>}
  </section>;
}
function AddObservation({schemas,category,disabled,onAdd}) {
  const [field,setField]=useState(''),[value,setValue]=useState(''),[page,setPage]=useState(''),[quote,setQuote]=useState('');
  const schema=schemas.find(s=>s.id===category),selected=schema?.fields.find(f=>f.id===field);
  return <details className="asset-add"><summary>手工补充参数候选</summary><div className="asset-value-grid"><label>参数<select value={field} onChange={e=>setField(e.target.value)}><option value="">选择参数</option>{schema?.fields.map(f=><option key={f.id} value={f.id}>{f.label} ({f.unit})</option>)}</select></label><label>典型值（{selected?.unit||'标准单位'}）<input value={value} onChange={e=>setValue(e.target.value)}/></label><label>页码<input type="number" value={page} onChange={e=>setPage(e.target.value)}/></label></div><label>原文引用<textarea value={quote} onChange={e=>setQuote(e.target.value)}/></label><button className="btn-secondary" disabled={disabled||!selected||!value||!page||!quote} onClick={()=>{onAdd({parameterId:field,name:selected.label,value:{min:null,typ:value,max:null},unit:selected.unit,nature:'unknown',conditions:'',appliesTo:[],page:Number(page),quotedText:quote});setValue('');setQuote('');}}>添加待审核候选</button></details>;
}
