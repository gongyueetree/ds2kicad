import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalShift, normalizeValue } from '../lib/data-assets/units.js';
import { classify } from '../lib/data-assets/registry.js';
import { buildDataAssets, parseObservations, normalizeObservation, digest } from '../lib/data-assets/pipeline.js';
import { reviewData, publishData, exportData } from '../lib/data-assets/review.js';
import { createBatch, claimNext, finishItem } from '../lib/data-assets/batch.js';
import { applyReviewPatch } from '../lib/reviewpatch.js';
import { remapDerivedPages } from '../api/extract.js';
const part={mpn:'TEST358',manufacturer:'Example',title:'Operational amplifier'};
const quote='Input offset voltage  0.3  1  mV';
const raw={categoryCandidate:'op_amp',parameterObservations:[{parameterId:'input_offset_voltage',name:'Input offset voltage',value:{min:null,typ:'0.3',max:'1'},unit:'mV',nature:'guaranteed',conditions:'TA = 25 C, VS = 5 V',appliesTo:['TEST358'],page:1,quotedText:quote}]};
const pages=[{page:1,width:600,height:800,lines:[{text:'Electrical characteristics',x:10,y:770,x1:300,h:10},{text:quote,x:10,y:700,x1:500,h:10}]}];
function data(){return buildDataAssets({part,pages,raw,documentSha256:'a'.repeat(64),pageCount:1});}
function approve(d=data()){return reviewData(d,{categoryId:'op_amp',reason:'核对数据手册',decisions:[{id:d.observations[0].id,status:'accepted'}]},'reviewer',part);}
const pubopts={actor:'publisher',reason:'审核后发布',part,mock:false,authenticated:true};

test('decimal normalization preserves precision, prefix case and compound dimensions',()=>{
  assert.equal(decimalShift('0.1234567890123456789',-6),'0.0000001234567890123456789');
  assert.equal(decimalShift('-1.25e-3',3),'-1.25');
  assert.equal(normalizeValue({typ:'2'},'V/µs','V/s').value.typ,'2000000');
  assert.equal(normalizeValue({typ:'10'},'mΩ','ohm').value.typ,'0.01');
  assert.equal(normalizeValue({typ:'10'},'MΩ','ohm').value.typ,'10000000');
  assert.throws(()=>normalizeValue({typ:'5'},'V','A'),/不兼容/);
  assert.throws(()=>normalizeValue({min:'5',max:'3'},'V','V'),/Min/);
  assert.throws(()=>decimalShift('3 ± 0.1'));
  assert.throws(()=>normalizeValue({min:'0.12345678901234567892',max:'0.12345678901234567891'},'V','V'),/Min/);
});
test('ambiguous classifications remain unknown and first page does not override a clear title',()=>{
  assert.equal(classify({title:'LDO operational amplifier'}).categoryId,'unknown');
  assert.equal(classify(part,[{lines:[{text:'MOSFET ADC'}]}]).categoryId,'op_amp');
});
test('all parameter candidates remain pending; original evidence stays immutable',()=>{
  const d=data(),original=structuredClone(d),o=d.observations[0];
  assert.equal(o.normalized.value.typ,'0.0003');assert.equal(o.evidence.verifiedText,true);assert.equal(o.review.status,'pending');
  const reviewed=reviewData(d,{categoryId:'op_amp',reason:'核对原文',decisions:[{id:o.id,status:'accepted',value:{typ:'0.0004',max:'0.001'},unit:'V'}]},'r',part);
  assert.deepEqual(d,original);assert.equal(reviewed.observations[0].raw.value.typ,'0.3');assert.equal(reviewed.observations[0].normalized.value.typ,'0.0004');
});
test('unlocatable, unknown-unit and missing-condition candidates cannot silently publish',()=>{
  const o=normalizeObservation({...raw.parameterObservations[0],unit:'banana',page:99},{categoryId:'op_amp',documentSha256:'x',pages});
  assert.equal(o.normalized,null);assert.equal(o.evidence.verifiedText,false);
  const d=data();d.observations[0].conditions='';
  assert.throws(()=>approve(d),/测试条件/);
  assert.throws(()=>publishData(data(),pubopts),/类别/);
  assert.throws(()=>reviewData(data(),{reason:'合法理由',approvals:{}},'r',part),/未知字段/);
});
test('published parameter snapshots are immutable, idempotent and independently exportable',()=>{
  const reviewed=approve(),published=publishData(reviewed,pubopts),snapshot=exportData(published);
  assert.equal(published.publications.length,1);assert.equal(snapshot.sha256,digest(snapshot.content));
  assert.equal(publishData(published,pubopts),published);
  const edited=reviewData(published,{reason:'修改审核',decisions:[{id:published.observations[0].id,status:'rejected'}]},'r',part);
  assert.deepEqual(exportData(edited),snapshot);assert.equal(exportData(edited,{draft:true}).nonPromotable,true);
  assert.throws(()=>publishData(reviewed,{...pubopts,mock:true}),/演示/);
  assert.throws(()=>publishData(reviewed,{...pubopts,authenticated:false}),/认证/);
});
test('category and identity changes invalidate facts without changing released history',()=>{
  const published=publishData(approve(),pubopts);
  const changed=reviewData(published,{categoryId:'ldo',reason:'重新分类'},'r',part);
  assert.equal(changed.observations[0].review.status,'pending');assert.equal(changed.observations[0].normalized,null);
  const ir={part,dataAssets:published};
  const result=applyReviewPatch(ir,{part:{mpn:{value:'OTHER',reason:'更正型号'}}},{reviewer:{sub:'r'}});
  assert.equal(result.ok,true);assert.equal(result.ir.dataAssets.observations[0].review.status,'pending');assert.deepEqual(result.ir.dataAssets.publications,published.publications);
});
test('aligned table extraction retains absolute max and blanks, rejects ambiguous column counts',()=>{
  const p=[{page:2,lines:[{text:'Absolute maximum ratings'},{text:'Parameter  Min  Typ  Max  Unit'},{text:'Supply voltage  -  -  6  V'},{text:'Supply voltage  2  V'}]}];
  const rows=parseObservations(p,'op_amp');assert.equal(rows.length,1);assert.equal(rows[0].nature,'absolute_maximum');assert.equal(rows[0].value.typ,null);assert.equal(rows[0].value.max,'6');
});
test('sliced parameter evidence maps back to original page numbers',()=>{
  const r={parameterObservations:[{page:2},{page:90},null]};remapDerivedPages(r,[1,28]);assert.equal(r.parameterObservations[0].page,28);assert.equal(r.parameterObservations[1].page,null);
});
test('batch claims are resumable, leased and fenced against late results',()=>{
  const batch=createBatch(['https://www.ti.com/a.pdf','https://www.ti.com/a.pdf','https://www.ti.com/b.pdf']);assert.equal(batch.items.length,2);
  const first=claimNext(batch,1000);assert.equal(claimNext(first.batch,2000),null);
  const recovered=claimNext(first.batch,200000);assert.notEqual(recovered.item.leaseId,first.item.leaseId);
  assert.throws(()=>finishItem(recovered.batch,first.item.id,first.item.leaseId,{jobId:'old'}),/租约/);
  const done=finishItem(recovered.batch,recovered.item.id,recovered.item.leaseId,{jobId:'new'});assert.equal(done.items[0].status,'completed');assert.equal(claimNext(done,300000).item.id,done.items[1].id);
  assert.throws(()=>createBatch(['http://127.0.0.1/x.pdf']));
});
