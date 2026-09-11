// PDF/image-schematic -> deterministic component census -> batched connectivity -> quality gate -> KiCad.
import { setCors } from './extract.js';
import { authenticate } from '../lib/auth.js';
import { reserveCredit, commitCredit, refundCredit } from '../lib/credits.js';
import { signupTarget } from '../lib/platform-session.js';
import { validatePdfUrl } from '../lib/validate.js';
import { extractSchematicWithGemini } from '../lib/schematic/gemini.js';
import { extractConnectivityBatchesWithGemini } from '../lib/schematic/gemini-batch.js';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles } from '../lib/schematic/kicad.js';
import { censusPdf, censusPromptHints } from '../lib/schematic/source-census.js';
import { buildComponentSkeleton, mergeModelIntoSkeleton, mergeConnectivityBatches } from '../lib/schematic/component-skeleton.js';
import { applyConnectivityQuality, qualitySummary } from '../lib/connectivity/quality.js';

const MOCK_SCHEMATIC={title:'Schematic Reconstruction Demo',pageCount:1,confidence:.94,components:[{ref:'R1',value:'1k',position:{x:.35,y:.5},confidence:.98,pins:[{number:'1',name:'1',type:'passive',side:'left',confidence:.9},{number:'2',name:'2',type:'passive',side:'right',confidence:.9}]},{ref:'D1',value:'LED',position:{x:.65,y:.5},confidence:.98,pins:[{number:'1',name:'K',type:'passive',side:'left',confidence:.9},{number:'2',name:'A',type:'passive',side:'right',confidence:.9}]}],nets:[{name:'LED_A',confidence:.96,endpoints:[{ref:'R1',pin:'2'},{ref:'D1',pin:'1'}]}],noConnects:[],warnings:[]};

export default async function handler(req,res){
 setCors(res,req); if(req.method==='OPTIONS')return res.status(204).end(); if(req.method!=='POST')return res.status(405).json({error:'POST only'});
 const auth=authenticate(req); if(!auth.ok)return res.status(auth.status||401).json({error:auth.error});
 const session=auth.session, body=req.body&&typeof req.body==='object'?req.body:safeParse(req.body); if(!body)return res.status(422).json({error:'invalid JSON body'});
 const mock=process.env.MOCK_MODE==='1'||body.mock===true;
 let reservation={ok:true,reservationId:null,cost:0};
 if(!mock){reservation=await reserveCredit(session,'schematic_to_kicad',{cost:session.guest?Number(process.env.GUEST_SCHEMATIC_TRIAL_COST||3):undefined,refKey:req.headers?.['idempotency-key']||null,metadata:{channel:session.channel||'direct',mode:'connectivity_extraction'}});if(!reservation.ok)return res.status(402).json({error:session.guest?'免费原理图转换体验已用完。注册 ezPLM / eeHub 后可继续转换并保存工程。':'Credit 余额不足，请充值后继续转换。',code:'credits_exhausted',wallet:reservation.wallet,requiredCredits:reservation.cost,signupUrl:signupTarget({channel:session.channel,locale:session.locale})});}
 const started=Date.now(); let stream=null,creditFinalized=false;
 try{
  let pdfBuf=null,fileName=String(body.fileName||'schematic.pdf').slice(0,160),sourceUrl='';
  if(mock){} else if(typeof body.pdfBase64==='string'&&body.pdfBase64.length){try{pdfBuf=Buffer.from(body.pdfBase64,'base64')}catch{throw httpError(400,'upload is not valid base64')}if(pdfBuf.length>3.2*1024*1024)throw httpError(413,'上传 PDF 超过 3MB，请压缩或使用 PDF URL');if(pdfBuf.subarray(0,5).toString('latin1')!=='%PDF-')throw httpError(422,'上传内容不是 PDF；图片请通过网页上传入口转换');}
  else{const v=validatePdfUrl(body.pdfUrl);if(!v.ok)throw httpError(400,v.error);sourceUrl=v.url;fileName=fileName==='schematic.pdf'?fileNameFromUrl(v.url):fileName;const {safeDownload}=await import('../lib/safedl.js');const dl=await safeDownload(v.url,{maxBytes:Number(process.env.MAX_PDF_MB||15)*1024*1024,timeoutMs:Math.min(40000,Number(process.env.SCHEMATIC_DOWNLOAD_TIMEOUT_MS||28000)),headers:{'User-Agent':'Mozilla/5.0 ConnectivityIntelligenceEngine/1.0','Accept':'application/pdf,*/*;q=0.8'}});pdfBuf=dl.buf;if(pdfBuf.subarray(0,5).toString('latin1')!=='%PDF-')throw httpError(422,'URL did not return a PDF');}

  const census=mock?{available:false,method:'mock',references:[],netLabels:[],gateNetLabels:[],partHints:[]}:await censusPdf(pdfBuf,{maxPages:Number(process.env.SCHEMATIC_CENSUS_MAX_PAGES||3)});
  const skeleton=buildComponentSkeleton(census);
  if(!mock&&process.env.SCHEMATIC_STREAM_HEARTBEAT!=='0')stream=beginJsonHeartbeat(res,Number(process.env.SCHEMATIC_HEARTBEAT_MS||8000));

  let raw,model='mock',extraction={attempts:0,elapsedMs:0,strategy:'mock'};
  if(mock)raw=MOCK_SCHEMATIC;
  else{
   const pdfBase64=pdfBuf.toString('base64');
   const useBatches=process.env.SCHEMATIC_BATCH_MODE!=='0'&&census.available&&(census.references?.length||0)>=Number(process.env.SCHEMATIC_BATCH_MIN_REFS||12);
   if(useBatches){
    const batched=await extractConnectivityBatchesWithGemini({pdfBase64,apiKey:process.env.GEMINI_API_KEY,model:process.env.SCHEMATIC_MODEL||process.env.GEMINI_MODEL,fileName,census,skeleton,deadlineMs:Number(process.env.SCHEMATIC_EXTRACT_BUDGET_MS||145000)});
    raw=mergeConnectivityBatches(skeleton,batched.batches,{title:fileName,pageCount:census.pageCount||1});
    model=batched.model; extraction={strategy:'deterministic_component_skeleton+batched_connectivity',attempts:batched.attempts||batched.batchCount||1,elapsedMs:batched.elapsedMs||Date.now()-started,batchCount:batched.batchCount||0,batchSize:batched.batchSize||0};
    // If every focus batch failed to produce connectivity, keep the deterministic skeleton but do one compact whole-page fallback for enrichment.
    if(!raw.nets.length&&Date.now()-started<Number(process.env.SCHEMATIC_FALLBACK_AFTER_BATCH_MS||100000)){
     try{const fallback=await extractSchematicWithGemini({pdfBase64,apiKey:process.env.GEMINI_API_KEY,model:process.env.SCHEMATIC_FALLBACK_MODEL||process.env.SCHEMATIC_MODEL||process.env.GEMINI_MODEL,fileName,libraryHints:censusPromptHints(census),deadlineMs:Math.max(25000,Number(process.env.SCHEMATIC_EXTRACT_BUDGET_MS||145000)-(Date.now()-started)-5000)});raw=mergeModelIntoSkeleton(skeleton,fallback.raw);extraction.fallbackWholePage=true;extraction.attempts+=(fallback.attempts||1);}catch(e){raw.warnings=[...(raw.warnings||[]),`whole-page fallback failed: ${e.message}`];}}
   }else{
    const extracted=await extractSchematicWithGemini({pdfBase64,apiKey:process.env.GEMINI_API_KEY,model:process.env.SCHEMATIC_MODEL||process.env.GEMINI_MODEL,fileName,libraryHints:censusPromptHints(census),deadlineMs:Number(process.env.SCHEMATIC_EXTRACT_BUDGET_MS||145000)});
    raw=skeleton.length?mergeModelIntoSkeleton(skeleton,extracted.raw):extracted.raw;model=extracted.model;extraction={strategy:skeleton.length?'deterministic_component_skeleton+whole_page':'whole_page',attempts:extracted.attempts||1,elapsedMs:extracted.elapsedMs||Date.now()-started};
   }
  }

  const baseIr=sanitizeSchematicIR(raw,{fileName,sourceUrl,model});
  const ir=applyConnectivityQuality(baseIr,census);
  const built=buildSchematicFiles(ir),exportAllowed=ir.qualityGate?.exportAllowed!==false;
  const files=exportAllowed?built.files:built.files.filter((x)=>/\.json$/i.test(x.path)),previewSvg=exportAllowed?built.previewSvg:null;
  const report={...built.report,exportBlocked:!exportAllowed,qualityGate:ir.qualityGate,sourceCensus:census};
  if(!mock){if(exportAllowed)await commitCredit(reservation.reservationId);else await refundCredit(reservation.reservationId);creditFinalized=true;}
  const summary={...summarizeSchematicIR(ir),...qualitySummary(ir)};
  const payload={ok:true,mode:'connectivity_intelligence',ir,summary,files,previewSvg,report,extraction:{...extraction,census:{available:census.available,references:census.references?.length||0,highConfidenceNetLabels:census.gateNetLabels?.length||0,partHints:census.partHints?.length||0}},qualityGate:ir.qualityGate,chargedCredits:exportAllowed?(reservation.cost||0):0,mock};
  if(stream)return stream.end(payload);try{res.setHeader('Cache-Control','no-store')}catch{}return res.status(200).json(payload);
 }catch(e){
  if(!mock&&!creditFinalized){try{await refundCredit(reservation.reservationId)}catch(billingError){console.error('[schematic-convert] refund failed',billingError)}}
  const status=Number(e.status||(e.code==='schematic_extraction_timeout'?504:500));console.error('[schematic-convert]',{code:e.code,message:e.message,elapsedMs:Date.now()-started});
  const payload={ok:false,error:e.code==='schematic_extraction_timeout'?'Connectivity 提取超时；系统已自动重试。请再次提交，或使用更小/更清晰的 PDF。':(e.message||'schematic conversion failed'),detail:e.message||null,code:e.code||'schematic_conversion_failed',status,elapsedMs:Date.now()-started};if(stream)return stream.end(payload);return res.status(status).json(payload);
 }
}

function beginJsonHeartbeat(res,intervalMs=8000){res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate, no-transform');res.setHeader('X-Accel-Buffering','no');res.setHeader('X-Connectivity-Streaming','heartbeat-v1');try{res.flushHeaders?.()}catch{}const beat=()=>{if(res.writableEnded||res.destroyed)return;try{res.write(`\n${' '.repeat(1024)}`)}catch{}};beat();const timer=setInterval(beat,Math.max(3000,Math.min(20000,Number(intervalMs)||8000)));timer.unref?.();const stop=()=>clearInterval(timer);res.once('finish',stop);res.once('close',stop);return{end(payload){stop();if(res.writableEnded||res.destroyed)return;try{res.end(JSON.stringify(payload))}catch{}}}}
function safeParse(s){try{return JSON.parse(s)}catch{return null}}function httpError(status,message){const e=new Error(message);e.status=status;return e}function fileNameFromUrl(url){try{return decodeURIComponent(new URL(url).pathname.split('/').pop()||'schematic.pdf').slice(0,160)}catch{return'schematic.pdf'}}
