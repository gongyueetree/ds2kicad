import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {resetJobStoreForTests,sha256} from '../lib/jobstore.js';
import {resetObjectStoreForTests,LocalObjectStore,S3ObjectStore} from '../lib/objectstore.js';
import {issueDevSession} from '../lib/auth.js';
import {reserveCredit,commitCredit,refundCredit,getWallet} from '../lib/credits.js';
const KEY='data-assets-api-test-only';
let server,base,store,root,pdf;
const token=(roles=['publisher'],tenantId='test-tenant',sub='u1')=>issueDevSession({sub,tenantId,roles},KEY);
async function call(path,body,auth=token()) {
  const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json()};
}
before(async()=>{
  process.env.EZPLM_JWT_SECRET=KEY;process.env.AUTH_MODE='production';
  delete process.env.EZPLM_JWT_ISS;delete process.env.EZPLM_JWT_AUD;delete process.env.NODE_ENV;delete process.env.VERCEL;delete process.env.DATABASE_URL;delete process.env.MOCK_MODE;delete process.env.GEMINI_API_KEY;
  root=mkdtempSync(join(tmpdir(),'ds2-data-test-'));store=resetJobStoreForTests(join(root,'jobs.db'));resetObjectStoreForTests(new LocalObjectStore(join(root,'objects')));
  const doc=await PDFDocument.create(),page=doc.addPage([612,792]),font=await doc.embedFont(StandardFonts.Helvetica);
  const lines=['TEST358 operational amplifier','Recommended operating conditions','TA = 25 C','Parameter  Min  Typ  Max  Unit','Supply voltage  2  3.3  5.5  V',...Array.from({length:22},(_,i)=>`Synthetic fixture line ${i+1}`)];
  lines.forEach((text,i)=>{
    if(i===3||i===4) text.split('  ').forEach((cell,j)=>page.drawText(cell,{x:[30,220,300,380,460][j],y:750-i*20,size:10,font}));
    else page.drawText(text,{x:30,y:750-i*20,size:10,font});
  });pdf=Buffer.from(await doc.save());
  const app=express();app.use(express.json({limit:'8mb'}));
  for(const name of ['extract','job','job-pdf','data-assets','batch']){const {default:handler}=await import(`../api/${name}.js`);app.all(`/api/${name}`,handler);}
  server=app.listen(0);await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(()=>{server?.close();rmSync(root,{recursive:true,force:true});});

test('PDF upload -> stored source -> parameter review -> independent published export survives reload',async()=>{
  const ex=await call('/api/extract',{pdfBase64:pdf.toString('base64'),fileName:'synthetic.pdf',assetMode:'data',mpn:'TEST358'});
  assert.equal(ex.status,200,JSON.stringify(ex.data));const id=ex.data.jobId;
  assert.equal(ex.data.dataAssets.sourceDocument.sha256,sha256(pdf));assert.equal(ex.data.dataAssets.observations.length,1);
  const got=store.get(id);assert.equal(got.job.ir.pdfBase64,undefined);assert.ok(got.job.ir.documentObject.key);
  const pdfResponse=await fetch(`${base}/api/job-pdf?jobId=${id}`,{headers:{Authorization:`Bearer ${token()}`}});
  assert.equal(pdfResponse.status,200);assert.equal(sha256(Buffer.from(await pdfResponse.arrayBuffer())),sha256(pdf));
  const cross=await call(`/api/data-assets?jobId=${id}`,null,token(['publisher'],'other'));assert.equal(cross.status,403);
  const viewer=await call('/api/data-assets',{jobId:id,action:'review',expectedRevision:1,categoryId:'op_amp',reason:'确认类别'},token(['viewer']));assert.equal(viewer.status,403);
  const o=ex.data.dataAssets.observations[0];
  const reviewed=await call('/api/data-assets',{jobId:id,action:'review',expectedRevision:1,categoryId:'op_amp',identity:{mpn:'TEST358',manufacturer:'Example'},reason:'依据原文审核',decisions:[{id:o.id,status:'accepted',appliesTo:['TEST358']}]});
  assert.equal(reviewed.status,200,JSON.stringify(reviewed.data));assert.equal(reviewed.data.summary.accepted,1);
  const stale=await call('/api/data-assets',{jobId:id,action:'publish',expectedRevision:1,reason:'发布参数'});assert.equal(stale.status,409);
  const noPublish=await call('/api/data-assets',{jobId:id,action:'publish',expectedRevision:reviewed.data.revision,reason:'发布参数'},token(['reviewer']));assert.equal(noPublish.status,403);
  const published=await call('/api/data-assets',{jobId:id,action:'publish',expectedRevision:reviewed.data.revision,reason:'发布参数'});assert.equal(published.status,200,JSON.stringify(published.data));
  const exported=await call(`/api/data-assets?jobId=${id}&export=published`);assert.equal(exported.status,200);assert.equal(exported.data.content.facts[0].nature,'recommended');
  const reload=await call(`/api/job?jobId=${id}`);assert.equal(reload.data.dataAssets.publications.length,1);assert.equal(reload.data.workflow.length,9);
  const correction=await call('/api/data-assets',{jobId:id,action:'review',expectedRevision:published.data.revision,reason:'重新审核参数',decisions:[{id:o.id,status:'rejected'}]});assert.equal(correction.status,200);
  assert.deepEqual((await call(`/api/data-assets?jobId=${id}&export=published`)).data,exported.data);
  // Asset snapshots remain readable after processing-job expiry.
  store.db.prepare('UPDATE jobs SET expires_at=0 WHERE job_id=?').run(id);
  assert.equal((await call(`/api/data-assets?jobId=${id}&export=published`)).status,200);
});

test('full extraction requests parameters, persists them and returns the same job on idempotent retry',async()=>{
  process.env.GEMINI_API_KEY='test-only';process.env.GEMINI_STUB=JSON.stringify({part:{mpn:'TEST358',manufacturer:'Example',title:'Operational amplifier'},packages:[],pinsets:[],figures:[],categoryCandidate:'op_amp',parameterObservations:[{parameterId:'supply_voltage',name:'Supply voltage',value:{min:'2',typ:'3.3',max:'5.5'},unit:'V',nature:'recommended',conditions:'TA = 25 C',appliesTo:['TEST358'],page:1,quotedText:'Supply voltage  2  3.3  5.5  V'}]});
  const request=()=>fetch(base+'/api/extract',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json','idempotency-key':'full-test'},body:JSON.stringify({pdfBase64:pdf.toString('base64'),fileName:'synthetic.pdf'})}).then(async r=>({status:r.status,data:await r.json()}));
  const a=await request(),b=await request();assert.equal(a.status,200,JSON.stringify(a.data));assert.ok(a.data.dataAssets.observations.length);assert.equal(a.data.jobId,b.data.jobId);assert.equal(b.data.reused,true);
  delete process.env.GEMINI_STUB;delete process.env.GEMINI_API_KEY;
});

test('batch API persists progress and isolates tenant and ownership',async()=>{
  process.env.MOCK_MODE='1';process.env.PDF_TOKEN_SECRET='test-only';
  const created=await call('/api/batch',{action:'create',urls:['https://www.ti.com/example.pdf'],requestId:'batch-test'});assert.equal(created.status,201);
  const b=created.data;
  assert.equal((await call(`/api/batch?batchId=${b.batchId}`,null,token(['publisher'],'other'))).status,403);
  assert.equal((await call('/api/batch',{action:'tick',batchId:b.batchId,expectedRevision:b.revision},token(['publisher'],'test-tenant','u2'))).status,403);
  const tick=await call('/api/batch',{action:'tick',batchId:b.batchId,expectedRevision:b.revision});assert.equal(tick.status,200,JSON.stringify(tick.data));assert.equal(tick.data.summary.completed,1);
  const restored=await call(`/api/batch?batchId=${b.batchId}`);assert.ok(restored.data.batch.items[0].jobId);
  delete process.env.MOCK_MODE;
});

test('credit idempotency does not charge completed retries twice',async()=>{
  process.env.CREDIT_ENFORCEMENT='1';process.env.REGISTERED_INITIAL_CREDITS='100';
  const session={sub:'billing-test',tenantId:'t',roles:['editor']};
  const before=await getWallet(session),r=await reserveCredit(session,'datasheet_to_kicad',{refKey:'same-input'});
  assert.equal(r.ok,true);assert.equal((await reserveCredit(session,'datasheet_to_kicad',{refKey:'same-input'})).code,'reservation_in_progress');
  await commitCredit(r.reservationId);
  const again=await reserveCredit(session,'datasheet_to_kicad',{refKey:'same-input'});assert.equal(again.reused,true);assert.equal(again.cost,0);
  assert.equal((await getWallet(session)).balance,before.balance-r.cost);
  const failed=await reserveCredit(session,'datasheet_to_kicad',{refKey:'failed-input'});await refundCredit(failed.reservationId);
  assert.equal((await reserveCredit(session,'datasheet_to_kicad',{refKey:'failed-input'})).ok,true);
  delete process.env.CREDIT_ENFORCEMENT;
});

test('object storage refuses traversal and S3 uses immutable writes and real byte reads',async()=>{
  const local=new LocalObjectStore(join(root,'local'));await assert.rejects(()=>local.put('../escape',Buffer.from('x')),/越界/);
  const calls=[],client={async send(cmd){calls.push(cmd);if(cmd.constructor.name==='GetObjectCommand')return {Body:{transformToByteArray:async()=>Uint8Array.from([1,2,3])}};return {};}};
  const s3=new S3ObjectStore({bucket:'assets',client});const saved=await s3.put('sha.pdf',Buffer.from([1,2,3]),{contentType:'application/pdf'});
  assert.equal(calls[0].input.IfNoneMatch,'*');assert.equal(saved.sha256,sha256(Buffer.from([1,2,3])));assert.deepEqual(await s3.get('sha.pdf'),Buffer.from([1,2,3]));
});
