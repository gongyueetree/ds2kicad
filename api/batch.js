import {setCors} from './extract.js';
import extract from './platform-extract.js';
import {authenticate,authorizeJobAccess,hasRole} from '../lib/auth.js';
import {getJobStore} from '../lib/jobstore.js';
import {createBatch,claimNext,finishItem,summarizeBatch} from '../lib/data-assets/batch.js';
import {digest} from '../lib/data-assets/pipeline.js';
export default async function handler(req,res) {
  setCors(res,req);if(req.method==='OPTIONS')return res.status(204).end();
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'仅支持 GET / POST'});
  const auth=authenticate(req);if(!auth.ok)return res.status(auth.status).json({error:auth.error});
  const session=auth.session;
  if(!session.authenticated)return res.status(403).json({error:'批量处理需要登录组织账户'});
  try {
    const body=req.method==='GET'?req.query:req.body;
    if(!body || typeof body!=='object' || Array.isArray(body))return res.status(400).json({error:'非法请求'});
    const store=await getJobStore();
    if(req.method==='POST'&&body.action==='create') {
      if(!hasRole(session,'editor'))return res.status(403).json({error:'需要 editor 权限'});
      const batch=createBatch(body.urls,body.assetMode || 'full');
      const job=await store.create({ir:{batch},tenantId:session.tenantId,ownerId:session.sub,operation:'asset_batch',datasheetSha256:digest({urls:batch.items.map(i=>i.url),mode:batch.mode}),idempotencyKey:typeof body.requestId==='string'?body.requestId.slice(0,100):null,ttlMs:90*86400000});
      return res.status(201).json(view(job));
    }
    const got=await store.get(body.batchId);if(!got.ok)return res.status(404).json({error:got.error});
    const job=got.job,az=authorizeJobAccess(session,job);
    if(!az.ok)return res.status(az.status).json({error:az.error});
    if(job.operation!=='asset_batch'||!job.ir.batch)return res.status(400).json({error:'不是批量任务'});
    if(req.method==='GET')return res.status(200).json(view(job));
    if(job.ownerId!==session.sub||!hasRole(session,'editor'))return res.status(403).json({error:'仅批次创建者可执行'});
    if(body.expectedRevision!==job.revision)return res.status(409).json({error:'批次已更新，请刷新',code:'revision_conflict',currentRevision:job.revision});
    if(body.action==='retry') {
      const batch=structuredClone(job.ir.batch),item=batch.items.find(i=>i.id===body.itemId);
      if(!item||item.status!=='failed')return res.status(400).json({error:'只能重试失败项'});
      item.status='pending';item.error=null;
      const saved=await commit(store,job,batch,session.sub,'batch_retry');
      return res.status(saved.ok?200:409).json(saved.ok?view(saved.job):{error:saved.error,code:saved.code});
    }
    if(body.action!=='tick')return res.status(400).json({error:'未知动作'});
    const claim=claimNext(job.ir.batch);if(!claim)return res.status(200).json(view(job));
    const saved=await commit(store,job,claim.batch,session.sub,'batch_claim');
    if(!saved.ok)return res.status(409).json({error:saved.error,code:saved.code});
    let payload=null,statusCode=200;
    const captured={headersSent:false,status(n){statusCode=n;return this;},setHeader(){},end(){},json(v){payload=v;this.headersSent=true;return this;}};
    try {
      await extract({...req,method:'POST',headers:{...req.headers,'idempotency-key':`batch:${job.jobId}:${claim.item.id}`},body:{pdfUrl:claim.item.url,assetMode:claim.batch.mode}},captured);
    } catch(e) { statusCode=500;payload={error:e.message}; }
    const current=await store.get(job.jobId);if(!current.ok)return res.status(409).json({error:current.error});
    const batch=finishItem(current.job.ir.batch,claim.item.id,claim.item.leaseId,statusCode<300&&payload?.jobId?{jobId:payload.jobId}:{error:payload?.error||`HTTP ${statusCode}`});
    const completed=await commit(store,current.job,batch,session.sub,'batch_finished');
    return res.status(completed.ok?200:409).json(completed.ok?view(completed.job):{error:completed.error,code:completed.code});
  }catch(e){return res.status(400).json({error:e.message});}
}
function view(job){return {batchId:job.jobId,revision:job.revision,batch:job.ir.batch,summary:summarizeBatch(job.ir.batch)};}
function commit(store,job,batch,actor,action){return store.commitGeneration(job.jobId,{ir:{batch},expectedRevision:job.revision,actor,auditEntries:[{action,detail:{summary:summarizeBatch(batch)}}]});}
