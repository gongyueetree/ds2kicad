import { useMemo, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { apiSchematicBuild, apiSchematicConvert } from '../platform-api.js';
import './schematic-converter.css';

const PIN_TYPES = ['input','output','bidirectional','power_in','power_out','passive','tri_state','open_collector','no_connect','unspecified'];
const SIDES = ['left','right','top','bottom'];

function locale() {
  const p = new URLSearchParams(location.search);
  const lang = p.get('lang') || p.get('locale') || '';
  if (/^zh/i.test(lang)) return 'zh-CN';
  if (/^en/i.test(lang)) return 'en-US';
  const ch = (p.get('channel') || '').toLowerCase();
  if (ch === 'eetree' || ch === 'ezplm') return 'zh-CN';
  if (ch === 'tindie' || ch === 'eehub') return 'en-US';
  return /^zh/i.test(navigator.language || '') ? 'zh-CN' : 'en-US';
}

const copy = {
  'zh-CN': {
    title:'PDF / 图片原理图 → KiCad', sub:'识别器件、管脚和网络连接，生成可编辑 KiCad 原理图。',
    url:'原理图 PDF URL', start:'开始转换', converting:'识别并重建中…', upload:'或上传 PDF / PNG / JPG',
    back:'元器件库生成', components:'器件', nets:'网络', confidence:'置信度', warnings:'需要复核',
    preview:'重建预览', edit:'器件与管脚复核', rebuild:'按修改重新生成（不扣 Credit）', rebuilding:'重新生成中…',
    download:'下载 .kicad_sch', zip:'下载完整工程 ZIP', ir:'下载 Schematic IR', ref:'位号', value:'型号 / 数值',
    footprint:'封装', library:'符号来源 / Library ID', pins:'管脚', select:'选择器件编辑管脚', number:'编号', name:'名称', type:'属性', side:'位置',
    net:'网络名', endpoints:'连接端点', evidence:'识别依据', note:'当前版本优先保证电气连接正确；低置信度管脚和网络请人工复核后用于生产。',
    fileLarge:'上传文件超过 3MB，请压缩或使用 PDF URL。', badFile:'支持 PDF、PNG、JPG/JPEG。', noInput:'请输入 PDF URL 或上传文件。',
    noResult:'转换完成后将在这里显示可编辑原理图。'
  },
  'en-US': {
    title:'PDF / Image Schematic → KiCad', sub:'Recognize components, pins and connectivity, then generate an editable KiCad schematic.',
    url:'Schematic PDF URL', start:'Convert schematic', converting:'Recognizing & rebuilding…', upload:'or upload PDF / PNG / JPG',
    back:'Library generator', components:'Components', nets:'Nets', confidence:'Confidence', warnings:'Review needed',
    preview:'Reconstruction preview', edit:'Component & pin review', rebuild:'Rebuild after edits (no Credit)', rebuilding:'Rebuilding…',
    download:'Download .kicad_sch', zip:'Download complete ZIP', ir:'Download Schematic IR', ref:'Ref', value:'Part / value',
    footprint:'Footprint', library:'Symbol / Library ID', pins:'Pins', select:'Select component to edit pins', number:'Number', name:'Name', type:'Type', side:'Side',
    net:'Net', endpoints:'Endpoints', evidence:'Evidence', note:'This version prioritizes electrical connectivity. Review low-confidence pins/nets before production use.',
    fileLarge:'Upload is over 3MB. Compress it or use a PDF URL.', badFile:'PDF, PNG and JPG/JPEG are supported.', noInput:'Enter a PDF URL or upload a file.',
    noResult:'The editable reconstructed schematic will appear here.'
  }
};

async function imageToPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await PDFDocument.create();
  const image = (/png/i.test(file.type) || /\.png$/i.test(file.name)) ? await pdf.embedPng(buf) : await pdf.embedJpg(buf);
  const portrait = image.height >= image.width;
  const pageSize = portrait ? [595.28, 841.89] : [841.89, 595.28];
  const [pw, ph] = pageSize; const margin = 12;
  const scale = Math.min((pw-margin*2)/image.width, (ph-margin*2)/image.height);
  const w=image.width*scale, h=image.height*scale;
  const page=pdf.addPage(pageSize); page.drawImage(image,{x:(pw-w)/2,y:(ph-h)/2,width:w,height:h});
  const bytes=await pdf.save({useObjectStreams:true});
  return new File([bytes], `${file.name.replace(/\.[^.]+$/,'') || 'schematic'}.pdf`, {type:'application/pdf'});
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf); let bin='';
  for (let i=0;i<bytes.length;i+=0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000));
  return btoa(bin);
}
function saveText(name, content, type='text/plain') {
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([content],{type})); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function modeHref(mode) {
  const p=new URLSearchParams(location.search); p.set('mode',mode); return `${location.pathname}?${p.toString()}`;
}

export default function SchematicConverter() {
  const loc=useMemo(locale,[]); const t=copy[loc];
  const [url,setUrl]=useState(''); const [file,setFile]=useState(null); const [busy,setBusy]=useState(false); const [rebuilding,setRebuilding]=useState(false);
  const [error,setError]=useState(''); const [result,setResult]=useState(null); const [selected,setSelected]=useState(0);

  const run = async (targetFile=file) => {
    setError(''); setBusy(true); setResult(null);
    try {
      let payload;
      if (targetFile) {
        let f=targetFile;
        if (!(f.type==='application/pdf'||/\.pdf$/i.test(f.name))) {
          if (/image\/(png|jpeg)/i.test(f.type)||/\.(png|jpe?g)$/i.test(f.name)) f=await imageToPdf(f); else throw new Error(t.badFile);
        }
        if (f.size>3*1024*1024) throw new Error(t.fileLarge);
        payload={pdfBase64:toBase64(await f.arrayBuffer()),fileName:f.name};
      } else if (url.trim()) payload={pdfUrl:url.trim()};
      else throw new Error(t.noInput);
      const r=await apiSchematicConvert(payload); setResult(r); setSelected(0);
      window.dispatchEvent(new Event('ds2k:usage-changed'));
    } catch(e) {
      setError(e.message);
      if(e?.payload?.signupUrl) setError(`${e.message} ${e.payload.signupUrl}`);
    } finally { setBusy(false); }
  };

  const setComponent=(idx,patch)=>setResult((r)=>({...r,ir:{...r.ir,components:r.ir.components.map((c,i)=>i===idx?{...c,...patch}:c)}}));
  const setPin=(ci,pi,patch)=>setResult((r)=>({...r,ir:{...r.ir,components:r.ir.components.map((c,i)=>i===ci?{...c,pins:c.pins.map((p,j)=>j===pi?{...p,...patch}:p)}:c)}}));
  const rebuild=async()=>{ if(!result?.ir)return; setRebuilding(true);setError('');try{const r=await apiSchematicBuild(result.ir);setResult((old)=>({...old,...r}));}catch(e){setError(e.message);}finally{setRebuilding(false);}};

  const modern=result?.files?.find((x)=>x.path.endsWith('.kicad_sch'));
  const irFile=result?.files?.find((x)=>x.path==='schematic-ir.json');
  const downloadZip=async()=>{if(!result?.files)return;const z=new JSZip();result.files.forEach((x)=>z.file(x.path,x.content));const blob=await z.generateAsync({type:'blob'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ds2kicad-reconstructed-schematic.zip';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
  const sel=result?.ir?.components?.[Math.min(selected,(result?.ir?.components?.length||1)-1)];

  return <div className="schematic-app">
    <header className="schematic-head">
      <div><h1>{t.title}</h1><p>{t.sub}</p></div>
      <a className="mode-link" href={modeHref('library')}>← {t.back}</a>
    </header>

    <section className="card schematic-input-card">
      <label>{t.url}</label>
      <div className="schematic-url-row"><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://.../schematic.pdf" onKeyDown={(e)=>e.key==='Enter'&&!busy&&run(null)}/><button className="btn-primary" onClick={()=>run(null)} disabled={busy}>{busy?t.converting:t.start}</button></div>
      <div className="upload-row">
        <label className="btn-secondary upload-btn">📄 {t.upload}<input type="file" accept="application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg" hidden onChange={async(e)=>{const f=e.target.files?.[0];e.target.value='';if(f){setFile(f);await run(f);}}}/></label>
        {file&&<span className="src-badge src-parser">{file.name}</span>}
      </div>
      {error&&<p className="error-line">✕ {error}</p>}
      <p className="hint">{t.note}</p>
    </section>

    {!result&&<section className="card schematic-empty">{t.noResult}</section>}
    {result&&<>
      <section className="schematic-metrics">
        <div><b>{result.summary?.components||0}</b><span>{t.components}</span></div><div><b>{result.summary?.nets||0}</b><span>{t.nets}</span></div><div><b>{Math.round((result.summary?.confidence||0)*100)}%</b><span>{t.confidence}</span></div><div><b>{result.summary?.warnings||0}</b><span>{t.warnings}</span></div>
      </section>
      <section className="card"><h2>{t.preview}</h2><div className="schematic-preview" dangerouslySetInnerHTML={{__html:result.previewSvg||''}}/></section>
      <section className="card"><h2>{t.edit}</h2>
        <div className="schematic-table-wrap"><table className="schematic-table"><thead><tr><th>{t.ref}</th><th>{t.value}</th><th>{t.library}</th><th>{t.footprint}</th><th>{t.pins}</th><th>{t.confidence}</th></tr></thead><tbody>{result.ir.components.map((c,i)=><tr key={c.id||c.ref} className={i===selected?'selected':''} onClick={()=>setSelected(i)}><td><input value={c.ref} onChange={(e)=>setComponent(i,{ref:e.target.value})}/></td><td><input value={c.value} onChange={(e)=>setComponent(i,{value:e.target.value})}/></td><td><input value={c.libraryId||''} onChange={(e)=>setComponent(i,{libraryId:e.target.value})}/></td><td><input value={c.footprint||''} onChange={(e)=>setComponent(i,{footprint:e.target.value})}/></td><td>{c.pins.length}</td><td>{Math.round((c.confidence||0)*100)}%</td></tr>)}</tbody></table></div>
        {sel&&<div className="pin-edit"><h3>{t.select}: {sel.ref}</h3><table className="schematic-table pin-edit-table"><thead><tr><th>{t.number}</th><th>{t.name}</th><th>{t.type}</th><th>{t.side}</th><th>{t.confidence}</th></tr></thead><tbody>{sel.pins.map((p,pi)=><tr key={`${p.number}-${pi}`}><td><input value={p.number} onChange={(e)=>setPin(selected,pi,{number:e.target.value})}/></td><td><input value={p.name} onChange={(e)=>setPin(selected,pi,{name:e.target.value})}/></td><td><select value={p.type} onChange={(e)=>setPin(selected,pi,{type:e.target.value})}>{PIN_TYPES.map(x=><option key={x}>{x}</option>)}</select></td><td><select value={p.side} onChange={(e)=>setPin(selected,pi,{side:e.target.value})}>{SIDES.map(x=><option key={x}>{x}</option>)}</select></td><td>{Math.round((p.confidence||0)*100)}%</td></tr>)}</tbody></table></div>}
        <button className="btn-primary schematic-rebuild" onClick={rebuild} disabled={rebuilding}>{rebuilding?t.rebuilding:t.rebuild}</button>
      </section>
      <section className="card"><h2>{t.nets}</h2><div className="schematic-table-wrap"><table className="schematic-table"><thead><tr><th>{t.net}</th><th>{t.endpoints}</th><th>{t.confidence}</th><th>{t.evidence}</th></tr></thead><tbody>{result.ir.nets.map((n)=><tr key={n.id||n.name}><td>{n.name}</td><td>{n.endpoints.map(e=>`${e.ref}.${e.pin}`).join(' ↔ ')}</td><td>{Math.round((n.confidence||0)*100)}%</td><td>{n.evidence||''}</td></tr>)}</tbody></table></div>
        {!!result.ir.warnings?.length&&<div className="schematic-warnings"><b>{t.warnings}</b><ul>{result.ir.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></div>}
      </section>
      <section className="card schematic-downloads"><button className="btn-primary" disabled={!modern} onClick={()=>modern&&saveText(modern.path,modern.content)}>{t.download}</button><button className="btn-secondary" onClick={downloadZip}>{t.zip}</button><button className="btn-secondary" disabled={!irFile} onClick={()=>irFile&&saveText(irFile.path,irFile.content,'application/json')}>{t.ir}</button></section>
    </>}
  </div>;
}
