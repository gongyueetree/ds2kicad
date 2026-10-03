import { useEffect, useRef, useState } from 'react';
import { apiBatch, apiGet } from '../api.js';
import './data-assets.css';
export default function BatchPanel(){
  const [urls,setUrls]=useState(''),[mode,setMode]=useState('full'),[state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[running,setRunning]=useState(false),[resume,setResume]=useState('');
  const active=useRef(false);
  useEffect(()=>{const id=new URLSearchParams(location.search).get('batch');if(id){setResume(id);load(id);}},[]);
  useEffect(()=>{active.current=running;return()=>{active.current=false;};},[running]);
  async function load(id){setError('');try{setState(await apiGet(`/api/batch?batchId=${encodeURIComponent(id)}`));}catch(e){setError(e.message);}}
  async function create(){setBusy(true);setError('');try{const r=await apiBatch({action:'create',urls:urls.split('\n').map(x=>x.trim()).filter(Boolean),assetMode:mode,requestId:crypto.randomUUID()});setState(r);setResume(r.batchId);const p=new URLSearchParams(location.search);p.set('batch',r.batchId);history.replaceState(null,'',`${location.pathname}?${p}`);}catch(e){setError(e.message);}finally{setBusy(false);}}
  useEffect(()=>{
    if(!running||!state||busy)return;
    if(!state.summary.pending&&!state.summary.running){setRunning(false);return;}
    const timer=setTimeout(async()=>{if(!active.current)return;setBusy(true);setError('');try{const next=await apiBatch({action:'tick',batchId:state.batchId,expectedRevision:state.revision});setState(next);}catch(e){setError(e.message);setRunning(false);await load(state.batchId);}finally{setBusy(false);}},500);
    return()=>clearTimeout(timer);
  },[running,state,busy]);
  async function retry(itemId){setBusy(true);setError('');try{setState(await apiBatch({action:'retry',batchId:state.batchId,expectedRevision:state.revision,itemId}));}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <section className="card batch-panel"><details open={!!state}><summary>批量生成数据资产</summary><p className="hint">每行一个 PDF 直链，最多 100 项。进度保存在服务器；关闭页面后可恢复，持续后台处理可配置独立 Worker。</p>
    <textarea aria-label="批量 PDF 链接" rows="4" value={urls} onChange={e=>setUrls(e.target.value)} placeholder="https://manufacturer.example/datasheet-a.pdf" disabled={running}/>
    <div className="asset-toolbar"><select aria-label="批量提取模式" value={mode} onChange={e=>setMode(e.target.value)}><option value="full">完整提取：参数 + EDA 资产</option><option value="data">文本参数提取（无需模型）</option></select><button className="btn-secondary" disabled={busy||running||!urls.trim()} onClick={create}>创建批次</button></div>
    <div className="asset-toolbar"><input aria-label="恢复批次 ID" value={resume} onChange={e=>setResume(e.target.value)} placeholder="批次 ID"/><button className="btn-ghost" disabled={busy||running||!resume} onClick={()=>load(resume)}>恢复批次</button></div>
    {state&&<><p className="hint">批次 {state.batchId} · 已完成 {state.summary.completed}/{state.batch.items.length} · 失败 {state.summary.failed}</p><button className="btn-primary" disabled={!running&&busy} onClick={()=>setRunning(!running)}>{running?'暂停后续任务':'继续处理'}</button><div className="batch-items">{state.batch.items.map(i=><div key={i.id}><span className="batch-url">{i.url}</span><span>{{pending:'待处理',running:'处理中',completed:'待审核',failed:'失败'}[i.status]}</span>{i.jobId&&<a href={`?job=${encodeURIComponent(i.jobId)}`} target="_blank" rel="noreferrer">查看资产</a>}{i.status==='failed'&&<button disabled={busy||running} onClick={()=>retry(i.id)}>重试</button>}{i.error&&<p className="error-line">{i.error}</p>}</div>)}</div></>}
    {error&&<p className="error-line" role="alert">{error}</p>}
  </details></section>;
}
