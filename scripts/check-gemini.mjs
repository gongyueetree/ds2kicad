// Explicit, preview-only smoke test using a public TI datasheet. Never exports credentials or raw logs.
import { writeFileSync } from 'node:fs';
import { extractWithGemini, geminiGenerationConfig } from '../lib/gemini.js';
import { safeDownload } from '../lib/safedl.js';
import { extractTextPages } from '../lib/pdftext.js';
import { selectRelevantPages, findFigures } from '../lib/heuristics.js';
import { locateRegions } from '../lib/data-assets/pipeline.js';
import { slicePdf } from '../lib/pdfslice.js';

if (process.env.VERCEL_ENV === 'preview' && process.env.DS2_GEMINI_DIAGNOSTIC === 'tmuxl27518') {
  const model=process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const result={checkedAt:new Date().toISOString(),commit:process.env.VERCEL_GIT_COMMIT_SHA || null,model,keyConfigured:!!process.env.GEMINI_API_KEY,checks:[]};
  const timed=async(name,fn)=>{
    const start=Date.now();
    try { const data=await fn(); result.checks.push({name,ok:true,elapsedMs:Date.now()-start,...data}); return data; }
    catch(e){result.checks.push({name,ok:false,elapsedMs:Date.now()-start,code:e.code || e.name || 'failed',httpStatus:e.httpStatus || null});return null;}
  };
  if(result.keyConfigured) {
    await timed('gemini_text',async()=>{
      const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},
        signal:AbortSignal.timeout(20000),body:JSON.stringify({contents:[{parts:[{text:'Return exactly {"ok":true} as JSON.'}]}],generationConfig:{...geminiGenerationConfig(model),maxOutputTokens:2048}})
      });
      if(!response.ok)throw Object.assign(new Error('upstream'),{httpStatus:response.status,code:`gemini_http_${response.status}`});
      const data=await response.json();const text=(data.candidates?.[0]?.content?.parts || []).filter(p=>!p.thought).map(p=>p.text||'').join('');
      if(!JSON.parse(text).ok)throw Object.assign(new Error('invalid result'),{code:'invalid_response'});
      return {httpStatus:response.status};
    });
    let pdf,parsed;
    const downloaded=await timed('public_pdf_download',async()=>{
      pdf=(await safeDownload('https://www.ti.com/lit/ds/symlink/tmuxl27518.pdf',{maxBytes:15*1024*1024,timeoutMs:30000})).buf;
      parsed=await extractTextPages(pdf);
      return {bytes:pdf.length,pages:parsed.pageCount};
    });
    if(downloaded)await timed('gemini_pdf_extraction',async()=>{
      const selected=[...new Set([...selectRelevantPages(parsed.pages,findFigures(parsed.pages)),...locateRegions(parsed.pages).flatMap(r=>[r.page,r.page+1]).filter(n=>n<=parsed.pageCount)])].sort((a,b)=>a-b);
      const sliced=await slicePdf(pdf,selected);const input=sliced?.buf || pdf;const attempts=[];
      const raw=await extractWithGemini({apiKey:process.env.GEMINI_API_KEY,model,pdfBase64:input.toString('base64'),sourceUrl:'https://www.ti.com/lit/ds/symlink/tmuxl27518.pdf',need:{part:true,pins:true,packages:true,figures:true,parameters:true},hints:{mpn:'TMUXL27518'},deadlineMs:140000,onAttempt:e=>attempts.push(e)});
      const pins=(raw.pinsets || []).reduce((n,s)=>n+(s.pins?.length || 0),0) || raw.pins?.length || 0;
      if(!pins || !raw.packages?.length)throw Object.assign(new Error('incomplete'),{code:'extraction_incomplete'});
      return {selectedPages:sliced?.pageMap?.length || parsed.pageCount,inputBytes:input.length,pins,packages:raw.packages.length,parameters:raw.parameterObservations?.length || 0,attempts};
    });
  }
  writeFileSync('dist/gemini-health.json',JSON.stringify(result,null,2));
  const escaped = JSON.stringify(result,null,2).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  writeFileSync('dist/gemini-health.html',`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DS2KiCad Gemini 诊断</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:20px;background:#f5f7fb;color:#142338}pre{background:white;padding:24px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Gemini 实际调用检查</h1><p>仅展示公开测试资料的诊断摘要；不包含密钥或用户文件。</p><pre>${escaped}</pre><a href="/">返回 DS2KiCad</a></html>`);
  console.log('[gemini-diagnostic]',JSON.stringify(result));
}
