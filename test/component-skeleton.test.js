import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComponentSkeleton, mergeConnectivityBatches } from '../lib/schematic/component-skeleton.js';

function multimeterRefs(){
  return [
    ...Array.from({length:18},(_,i)=>`C${i+1}`),
    'IC1','OP1A','OP1B','OP2A','OP2B','OP3A','OP3B','OP3C','OP3D','PWR1',
    ...Array.from({length:7},(_,i)=>`Q${i+1}`),
    ...Array.from({length:40},(_,i)=>`R${i+1}`),
    ...Array.from({length:5},(_,i)=>`U${i+1}`)
  ];
}

test('Multimeter source census produces all 80 deterministic component refs before AI',()=>{
  const refs=multimeterRefs();
  assert.equal(refs.length,80);
  const census={available:true,references:refs,partHints:[{ref:'U2',value:'ADM8829',confidence:.92},{ref:'U3',value:'MCP3204',confidence:.92}]};
  const skeleton=buildComponentSkeleton(census);
  assert.equal(skeleton.length,80);
  assert.ok(skeleton.some((c)=>c.ref==='R40'));
  assert.ok(skeleton.some((c)=>c.ref==='C18'));
  assert.equal(skeleton.find((c)=>c.ref==='U2').value,'ADM8829');
  assert.equal(skeleton.find((c)=>c.ref==='R1').pins.length,2);
});

test('batched extraction enriches skeleton instead of replacing it with a few model components',()=>{
  const refs=multimeterRefs();
  const skeleton=buildComponentSkeleton({available:true,references:refs,partHints:[{ref:'U2',value:'ADM8829',confidence:.9}]});
  const raw=mergeConnectivityBatches(skeleton,[{
    components:[{ref:'U2',value:'ADM8829',pins:[{number:'1',name:'OUT',type:'power_out',confidence:.95},{number:'2',name:'IN',type:'power_in',confidence:.95}]}],
    nets:[{name:'VCC',confidence:.9,endpoints:[{ref:'U2',pin:'2'},{ref:'R1',pin:'1'}]}],noConnects:[],warnings:[]
  }],{title:'golden'});
  assert.equal(raw.components.length,80);
  assert.equal(raw.nets.length,1);
  assert.equal(raw.components.find((c)=>c.ref==='U2').pins.find((p)=>p.number==='1').name,'OUT');
});
