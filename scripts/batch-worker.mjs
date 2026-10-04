// Run as a supervised process on a worker host; credentials are never stored in batch IR.
const origin=process.env.DS2KICAD_URL,token=process.env.DS2KICAD_WORKER_TOKEN,batchId=process.env.BATCH_ID;
if(!origin||!token||!batchId)throw new Error('需要 DS2KICAD_URL、DS2KICAD_WORKER_TOKEN 和 BATCH_ID');
const base=new URL(origin);if(!['https:','http:'].includes(base.protocol))throw new Error('无效服务地址');
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
async function request(url,options={}){const r=await fetch(url,{...options,headers,signal:AbortSignal.timeout(170000)});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{status:r.status});return data;}
while(!stop){
  try {
    const state=await request(new URL(`/api/batch?batchId=${encodeURIComponent(batchId)}`,base));
    if(!state.summary.pending&&!state.summary.running){console.log(JSON.stringify(state.summary));break;}
    const next=await request(new URL('/api/batch',base),{method:'POST',body:JSON.stringify({action:'tick',batchId,expectedRevision:state.revision})});
    console.log(JSON.stringify(next.summary));
  }catch(e){if([401,403,404].includes(e.status))throw e;console.error(e.message);}
  await new Promise(r=>setTimeout(r,3000));
}
