import { setCors } from './extract.js';
import { authenticate, authorizeJobAccess, hasRole } from '../lib/auth.js';
import { getJobStore } from '../lib/jobstore.js';
import { SCHEMAS } from '../lib/data-assets/registry.js';
import { reviewData, publishData, exportData } from '../lib/data-assets/review.js';
import { dataSummary, workflowView } from '../lib/data-assets/pipeline.js';
export default async function handler(req,res) {
  setCors(res,req);
  if(req.method==='OPTIONS') return res.status(204).end();
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'仅支持 GET / POST'});
  const auth=authenticate(req); if(!auth.ok) return res.status(auth.status).json({error:auth.error});
  try {
    const body=req.method==='GET'?req.query:req.body;
    if(!body || typeof body!=='object' || Array.isArray(body)) return res.status(400).json({error:'请求必须是对象'});
    const store=await getJobStore(), got=await store.get(body.jobId);
    if(!got.ok) return res.status(404).json({error:got.error,code:got.code});
    const session=auth.session, job=got.job, az=authorizeJobAccess(session,job);
    if(!az.ok) return res.status(az.status).json({error:az.error,code:az.code});
    if(!job.ir.dataAssets) return res.status(409).json({error:'此作业尚无参数资产，请重新提取',code:'data_assets_missing'});
    if(req.method==='GET') {
      if(body.export==='published' || body.export==='draft') return res.status(200).json(exportData(job.ir.dataAssets,{draft:body.export==='draft',versionId:body.versionId}));
      return res.status(200).json(view(job,session));
    }
    if(!Number.isInteger(body.expectedRevision)) return res.status(400).json({error:'必须携带 expectedRevision'});
    if(body.expectedRevision!==job.revision) return res.status(409).json({error:'数据已更新，请刷新后重试',code:'revision_conflict',currentRevision:job.revision});
    if(!session.authenticated || !hasRole(session,body.action==='publish'?'publisher':'reviewer')) return res.status(403).json({error:'需要已认证的审核/发布权限',code:'insufficient_role'});
    let next, part=job.ir.part;
    if(body.identity !== undefined) {
      if(body.action!=='review' || job.ir.packages?.length) return res.status(400).json({error:'完整 EDA 作业请在器件信息确认后保存身份'});
      if(!body.identity || Array.isArray(body.identity) || typeof body.identity!=='object' || Object.keys(body.identity).some(k=>!['mpn','manufacturer'].includes(k)) || ['mpn','manufacturer'].some(k=>typeof body.identity[k]!=='string' || !body.identity[k].trim() || body.identity[k].length>100 || /[\x00-\x1f]/.test(body.identity[k]))) return res.status(400).json({error:'请填写有效的型号和厂商'});
      part={...part,mpn:body.identity.mpn.trim(),manufacturer:body.identity.manufacturer.trim()};
    }
    if(body.action==='review') next=reviewData(job.ir.dataAssets,body,session.sub,part);
    else if(body.action==='publish') {
      if(Object.keys(body).some(k=>!['jobId','expectedRevision','action','reason'].includes(k))) return res.status(400).json({error:'发布请求包含未知字段'});
      next=publishData(job.ir.dataAssets,{actor:session.sub,reason:body.reason,part:job.ir.part,mock:job.ir.mock,authenticated:session.authenticated});
    } else return res.status(400).json({error:'未知动作'});
    if(next===job.ir.dataAssets) return res.status(200).json(view(job,session));
    const saved=await store.commitGeneration(job.jobId,{ir:{...job.ir,part,dataAssets:next},expectedRevision:job.revision,actor:session.sub,auditEntries:[{action:`data_${body.action}`,detail:{reason:body.reason,summary:dataSummary(next)}}]});
    if(!saved.ok) return res.status(409).json({error:saved.error,code:saved.code,currentRevision:saved.currentRevision});
    return res.status(200).json(view(saved.job,session));
  } catch(e) { return res.status(e.status || 400).json({error:e.message}); }
}
function view(job,session) {
  return {jobId:job.jobId,revision:job.revision,dataAssets:job.ir.dataAssets,summary:dataSummary(job.ir.dataAssets),workflow:workflowView(job.ir),
    canEditIdentity:!job.ir.packages?.length,schemas:SCHEMAS.map(({pattern,...s})=>s),canReview:session.authenticated===true&&hasRole(session,'reviewer'),canPublish:session.authenticated===true&&hasRole(session,'publisher')&&!job.ir.mock};
}
