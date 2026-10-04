import { randomUUID } from 'node:crypto';
import { validatePdfUrl } from '../validate.js';
export function createBatch(items, mode = 'full') {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('每批需要 1–100 个 PDF URL');
  if (!['full','data'].includes(mode)) throw new Error('未知资产模式');
  const seen = new Set();
  return { schema:'ds2kicad.batch.v1', mode, createdAt:new Date().toISOString(), items:items.map(item => {
    if (typeof item !== 'string') throw new Error('批次项必须是 PDF URL');
    const v=validatePdfUrl(item); if(!v.ok) throw new Error(v.error);
    if(seen.has(v.url)) return null; seen.add(v.url);
    return {id:randomUUID(),url:v.url,status:'pending',attempts:0,jobId:null,error:null,leaseUntil:null};
  }).filter(Boolean) };
}
export function claimNext(batch, now=Date.now()) {
  if(batch.items.some(i=>i.status==='running' && i.leaseUntil>now)) return null;
  const next=structuredClone(batch);
  const item=next.items.find(i=>i.status==='pending' || (i.status==='running' && i.leaseUntil<=now));
  if(!item) return null;
  item.status='running';item.attempts++;item.leaseId=randomUUID();item.leaseUntil=now+180000;item.error=null;
  return {batch:next,item};
}
export function finishItem(batch, itemId, leaseId, result) {
  const next=structuredClone(batch), item=next.items.find(i=>i.id===itemId);
  if(!item || item.leaseId!==leaseId || item.status!=='running') throw new Error('任务租约已变更');
  item.status=result.jobId?'completed':'failed';item.jobId=result.jobId || null;
  item.error=result.error ? String(result.error).slice(0,1000) : null;item.leaseUntil=null;item.completedAt=new Date().toISOString();
  return next;
}
export function summarizeBatch(batch) {
  return Object.fromEntries(['pending','running','completed','failed'].map(s=>[s,batch.items.filter(i=>i.status===s).length]));
}
