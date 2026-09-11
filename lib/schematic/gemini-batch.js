// Batched connectivity extraction for dense schematic pages.
// Component discovery comes from deterministic Source Census; each model call traces only a small focus set.
import { repairConnectivityJsonText } from './gemini.js';
import { findKnownPart } from '../connectivity/known-parts.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BATCH_SCHEMA = {
  type:'OBJECT',
  properties:{
    components:{ type:'ARRAY', items:{ type:'OBJECT', properties:{
      ref:{type:'STRING'}, value:{type:'STRING'}, mpn:{type:'STRING'}, confidence:{type:'NUMBER'},
      pins:{type:'ARRAY', items:{ type:'OBJECT', properties:{ number:{type:'STRING'}, name:{type:'STRING'}, type:{type:'STRING'}, side:{type:'STRING'}, confidence:{type:'NUMBER'} }, required:['number','name'] }}
    }, required:['ref','pins'] }},
    nets:{ type:'ARRAY', items:{ type:'OBJECT', properties:{
      name:{type:'STRING'}, confidence:{type:'NUMBER'}, evidence:{type:'STRING'},
      endpoints:{type:'ARRAY',items:{type:'OBJECT',properties:{ref:{type:'STRING'},pin:{type:'STRING'},confidence:{type:'NUMBER'}},required:['ref','pin']}}
    }, required:['name','endpoints'] }},
    noConnects:{type:'ARRAY',items:{type:'OBJECT',properties:{ref:{type:'STRING'},pin:{type:'STRING'}},required:['ref','pin']}},
    warnings:{type:'ARRAY',items:{type:'STRING'}}
  },
  required:['components','nets']
};

function chunk(arr, size) {
  const out=[];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

function knownPinHint(component) {
  const p = findKnownPart(component);
  if (!p) return '';
  return `${component.ref}=${p.id} pins ${p.pins.map(([n,name,type])=>`${n}:${name}:${type}`).join(' | ')}`;
}

function focusPrompt({ fileName, focus, allRefs, skeleton }) {
  const byRef = new Map((skeleton||[]).map((c)=>[String(c.ref).toUpperCase(),c]));
  const focusLines = focus.map((ref)=>{
    const c=byRef.get(String(ref).toUpperCase()) || {ref,value:ref,pins:[]};
    const known=knownPinHint(c);
    return known || `${ref}${c.value && c.value!==ref ? `=${c.value}` : ''}`;
  });
  return `Trace ELECTRICAL CONNECTIVITY for a dense schematic PDF. Component discovery is already complete and deterministic; do not search for a different component list.

Source: ${fileName || 'schematic.pdf'}
FOCUS REFERENCES (${focus.length}): ${focusLines.join(', ')}
ALL VALID REFERENCES (${allRefs.length}): ${allRefs.join(', ')}

Return JSON only with components, nets, noConnects, warnings.

Rules:
1. Inspect every FOCUS reference. Return its visible pin number/name mapping in components. For simple R/C/L/D/F parts, use pins 1 and 2 if numbers are not printed.
2. Trace EVERY visible wire/net touching a FOCUS reference. A returned net may include endpoints on any ALL VALID REFERENCES, not only focus refs.
3. Endpoint.ref MUST be one of ALL VALID REFERENCES. Never use a part number (e.g. ADM8829) as endpoint.ref.
4. Endpoint.pin MUST be a pin number/designator. Preserve visible pin numbers. Never use pin names as numbers unless the package uses alphanumeric designators.
5. Preserve explicit labels exactly: VCC, GND, VGND, Vref, -5V, CS, SCK, MOSI, MISO, etc.
6. A crossing without a junction dot is not connected; crossing with a junction dot is connected. Same-name labels are connected.
7. For unnamed nets use an empty name; the server will assign stable N$ names after merging.
8. Do not invent hidden connectivity. If ambiguous, lower confidence and add a warning.
9. Keep output compact. The goal is complete endpoints, not prose.
10. Return each net that touches a FOCUS component even if another batch will also see the same net.`;
}

async function callBatch({ pdfBase64, apiKey, model, prompt, timeoutMs, maxOutputTokens }) {
  const url=`${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ac=new AbortController();
  const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try {
    const body={
      contents:[{role:'user',parts:[{inline_data:{mime_type:'application/pdf',data:pdfBase64}},{text:prompt}]}],
      generationConfig:{temperature:0.01,maxOutputTokens,responseMimeType:'application/json',responseSchema:BATCH_SCHEMA}
    };
    let resp=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ac.signal});
    let text=await resp.text();
    if (resp.status===400 && /schema/i.test(text)) {
      delete body.generationConfig.responseSchema;
      resp=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ac.signal});
      text=await resp.text();
    }
    if (!resp.ok) throw new Error(`Gemini batch ${resp.status}: ${text.slice(0,240)}`);
    const data=JSON.parse(text);
    const content=(data?.candidates?.[0]?.content?.parts||[]).map((p)=>p.text||'').join('');
    const parsed=repairConnectivityJsonText(content);
    if (!parsed || !Array.isArray(parsed.components) || !Array.isArray(parsed.nets)) throw new Error('invalid batch connectivity JSON');
    return parsed;
  } finally { clearTimeout(timer); }
}

export async function extractConnectivityBatchesWithGemini({ pdfBase64, apiKey, model, fileName, census, skeleton, deadlineMs=145000 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const refs=(census?.references||[]).filter(Boolean);
  if (!refs.length) return { batches:[], model:model||'', attempts:0, elapsedMs:0 };
  const primary=model || process.env.SCHEMATIC_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const batchSize=Math.max(8,Math.min(28,Number(process.env.SCHEMATIC_FOCUS_BATCH_SIZE||18)));
  const groups=chunk(refs,batchSize);
  const concurrency=Math.max(1,Math.min(6,Number(process.env.SCHEMATIC_BATCH_CONCURRENCY||4)));
  const maxTokens=Math.max(4096,Math.min(16384,Number(process.env.SCHEMATIC_BATCH_MAX_OUTPUT_TOKENS||8192)));
  const perCall=Math.max(20000,Math.min(90000,Number(process.env.SCHEMATIC_BATCH_TIMEOUT_MS||60000)));
  const started=Date.now(), deadline=started+Math.max(30000,Number(deadlineMs||145000));
  const results=new Array(groups.length).fill(null);
  let cursor=0, attempts=0;

  async function worker() {
    while (true) {
      const i=cursor++;
      if (i>=groups.length) return;
      const remaining=deadline-Date.now();
      if (remaining<7000) return;
      const timeoutMs=Math.min(perCall,remaining-2500);
      const prompt=focusPrompt({fileName,focus:groups[i],allRefs:refs,skeleton});
      attempts++;
      try {
        results[i]=await callBatch({pdfBase64,apiKey,model:primary,prompt,timeoutMs,maxOutputTokens:maxTokens});
      } catch (e) {
        // one cheap retry for a failed focus batch if budget remains
        if (deadline-Date.now()>15000) {
          await sleep(250);
          attempts++;
          try { results[i]=await callBatch({pdfBase64,apiKey,model:primary,prompt,timeoutMs:Math.min(timeoutMs,deadline-Date.now()-2000),maxOutputTokens:maxTokens}); }
          catch (e2) { results[i]={components:[],nets:[],noConnects:[],warnings:[`focus batch ${i+1}/${groups.length} failed: ${e2.message}`]}; }
        } else results[i]={components:[],nets:[],noConnects:[],warnings:[`focus batch ${i+1}/${groups.length} failed: ${e.message}`]};
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,groups.length)},()=>worker()));
  return { batches:results.filter(Boolean), model:primary, attempts, elapsedMs:Date.now()-started, batchCount:groups.length, batchSize };
}
