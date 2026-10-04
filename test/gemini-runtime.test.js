import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractWithGemini,geminiGenerationConfig} from '../lib/gemini.js';
import {checkRequestedPart} from '../lib/part-match.js';
const base={apiKey:'private-key',model:'gemini-2.5-flash',pdfBase64:'pdf',need:{part:true},deadlineMs:30000};
test('Gemini bounds thinking, sends credentials only in headers, and excludes thought content',async()=>{
  const events=[];
  const result=await extractWithGemini({...base,onAttempt:e=>events.push(e),fetchImpl:async(url,opts)=>{
    assert.ok(!url.includes('private-key'));assert.equal(opts.headers['x-goog-api-key'],'private-key');
    assert.equal(JSON.parse(opts.body).generationConfig.thinkingConfig.thinkingBudget,1024);
    return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'private reasoning'},{text:'{"part":{"mpn":"TEST1"}}'}]}}]}));
  }});
  assert.equal(result.part.mpn,'TEST1');assert.equal(events.at(-1).event,'success');
  assert.equal(geminiGenerationConfig('another-model').thinkingConfig,undefined);
});
test('Gemini permissions errors are actionable, do not retry, and do not expose provider response',async()=>{
  let count=0;
  await assert.rejects(extractWithGemini({...base,fetchImpl:async()=>{count++;return new Response('sensitive upstream text',{status:403});}}),e=>e.code==='gemini_permission_denied'&&!e.message.includes('sensitive'));
  assert.equal(count,1);
});
test('Gemini budget exhaustion never starts an over-budget call',async()=>{
  await assert.rejects(extractWithGemini({...base,deadlineMs:0,fetchImpl:()=>{throw new Error('must not call');}}),e=>e.code==='gemini_budget_exhausted');
});
test('Gemini does not accept token-truncated JSON as completed extraction',async()=>{
  const response={candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"part":{"mpn":"TEST1"'}]}}]};
  await assert.rejects(extractWithGemini({...base,deadlineMs:8500,fetchImpl:async()=>new Response(JSON.stringify(response))}),e=>e.code==='gemini_output_truncated');
});
test('MPN guard rejects another part but accepts family members and ordering suffixes',()=>{
  const pages=[{lines:[{text:'TMUXL27518 datasheet Analog switch'}]}];
  assert.equal(checkRequestedPart({requested:'AD8065',detected:'TMUXL27518',pages}).code,'mpn_document_mismatch');
  assert.equal(checkRequestedPart({requested:'TMUXL27518RSVR',detected:'TMUXL27518',pages}),null);
  assert.equal(checkRequestedPart({requested:'LM358',detected:'LM158',pages:[{lines:[{text:'LM158 LM258 LM358 operational amplifiers'}]}]}),null);
  assert.equal(checkRequestedPart({requested:'AD8065',detected:'DATASHEET',pages}),null);
});
