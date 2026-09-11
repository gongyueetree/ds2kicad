import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceCensus } from '../lib/schematic/source-census.js';
import { applyConnectivityQuality } from '../lib/connectivity/quality.js';

const source = {
  pageCount:1,
  pages:[{
    page:1,width:1000,height:700,
    lines:[
      {text:'R1 R2 R3 R4 C1 C2 U2 U3 U4 IC1',x:0,y:600,x1:500,h:8},
      {text:'VCC GND VCC GND CS SCK MOSI MISO CS SCK MOSI MISO',x:0,y:500,x1:600,h:8}
    ],
    items:[
      {text:'U2',x:100,y:400,w:10,h:8},{text:'ADM8829',x:96,y:370,w:50,h:8},
      {text:'U3',x:300,y:400,w:10,h:8},{text:'MCP3204',x:295,y:365,w:55,h:8}
    ]
  }]
};

test('source census finds references, repeated net labels and ref/value hints',()=>{
  const c=buildSourceCensus(source);
  assert.equal(c.available,true);
  assert.ok(c.references.includes('U2'));
  assert.ok(c.references.includes('R4'));
  assert.ok(c.gateNetLabels.includes('VCC'));
  assert.ok(c.gateNetLabels.includes('MOSI'));
  assert.equal(c.partHints.find(x=>x.ref==='U2')?.value,'ADM8829');
});

test('quality gate rejects low component/net coverage and repairs MPN-as-reference',()=>{
  const census=buildSourceCensus(source);
  const ir={
    source:{fileName:'golden.pdf'}, confidence:0.65,
    components:[
      {id:'a',ref:'ADM8829',value:'ADM8829',mpn:'ADM8829',pins:[
        {number:'1',name:'IN',type:'input',confidence:0.7},
        {number:'2',name:'CAP-',type:'passive',confidence:0.7},
        {number:'3',name:'GND',type:'power_in',confidence:0.7},
        {number:'4',name:'CAP-',type:'passive',confidence:0.7},
        {number:'5',name:'OUT',type:'output',confidence:0.7},
        {number:'6',name:'VCC',type:'power_in',confidence:0.7}
      ]},
      {id:'b',ref:'IC1',value:'MAX6106',mpn:'MAX6106',pins:[
        {number:'1',name:'IN',type:'power_in',confidence:0.9},
        {number:'2',name:'OUT',type:'power_out',confidence:0.9},
        {number:'3',name:'GND',type:'power_in',confidence:0.9}
      ]}
    ],
    nets:[], noConnects:[], warnings:[]
  };
  const out=applyConnectivityQuality(ir,census);
  assert.equal(out.qualityGate.status,'rejected');
  assert.ok(out.qualityGate.coverage.components.ratio < 0.5);
  assert.equal(out.nets.length,0);
  const u2=out.components.find(x=>x.ref==='U2');
  assert.ok(u2,'ADM8829 reference should reconcile to U2');
  assert.deepEqual(u2.pins.slice(0,6).map(p=>[p.number,p.name]),[
    ['1','OUT'],['2','IN'],['3','CAP-'],['4','GND'],['5','NC'],['6','CAP+']
  ]);
  assert.ok(out.issues.some(x=>x.code==='COMPONENT_COVERAGE_LOW'));
  assert.ok(out.issues.some(x=>x.code==='VISIBLE_NETS_BUT_ZERO_RECONSTRUCTED'));
});

test('quality gate accepts source-grounded complete graph',()=>{
  const census={available:true,references:['R1','R2'],gateNetLabels:['SIG'],netLabels:['SIG'],partHints:[]};
  const ir={source:{},confidence:0.9,components:[
    {id:'1',ref:'R1',value:'1k',pins:[{number:'1',name:'1',type:'passive',confidence:.9},{number:'2',name:'2',type:'passive',confidence:.9}]},
    {id:'2',ref:'R2',value:'1k',pins:[{number:'1',name:'1',type:'passive',confidence:.9},{number:'2',name:'2',type:'passive',confidence:.9}]}
  ],nets:[{id:'n',name:'SIG',confidence:.95,endpoints:[{ref:'R1',pin:'2'},{ref:'R2',pin:'1'}]}],noConnects:[],warnings:[]};
  const out=applyConnectivityQuality(ir,census);
  assert.notEqual(out.qualityGate.status,'rejected');
  assert.equal(out.qualityGate.coverage.components.ratio,1);
  assert.equal(out.qualityGate.coverage.namedNets.ratio,1);
});
