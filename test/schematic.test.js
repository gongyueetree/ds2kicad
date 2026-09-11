import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles, generateModernSchematic } from '../lib/schematic/kicad.js';
import { buildSchematicPrompt, extractSchematicWithGemini } from '../lib/schematic/gemini.js';

const raw={title:'LED test',confidence:.92,components:[{ref:'R1',value:'1k',position:{x:.3,y:.5},pins:[{number:'1',name:'1',type:'passive',side:'left',confidence:.9},{number:'2',name:'2',type:'passive',side:'right',confidence:.9}]},{ref:'D1',value:'LED GREEN',position:{x:.7,y:.5},pins:[{number:'1',name:'K',type:'passive',side:'left',confidence:.9},{number:'2',name:'A',type:'passive',side:'right',confidence:.9}]}],nets:[{name:'LED_A',confidence:.95,endpoints:[{ref:'R1',pin:'2'},{ref:'D1',pin:'1'}]}]};
function balancedSexpr(text){let depth=0,quoted=false,escaped=false;for(const ch of text){if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}if(ch==='"'){quoted=true;continue;}if(ch==='(')depth++;else if(ch===')')depth--;if(depth<0)return false;}return depth===0&&!quoted;}
const pin=(number,name,type='passive',side='left')=>({number:String(number),name,type,side,confidence:1});

test('Connectivity IR is source of truth and resolves common KiCad hints',()=>{const ir=sanitizeSchematicIR(raw,{fileName:'fixture.pdf',model:'stub'});assert.equal(ir.schemaVersion,'connectivity-intelligence.ir.v1');assert.equal(ir.kind,'connectivity-ir');assert.equal(ir.components.length,2);assert.equal(ir.components[0].libraryId,'Device:R');assert.equal(ir.components[1].libraryId,'Device:LED');assert.deepEqual(ir.nets[0].endpoints.map(e=>`${e.ref}.${e.pin}`),['R1.2','D1.1']);assert.equal(ir.health.deterministic,true);assert.equal(ir.health.tokenCost,0);assert.deepEqual(ir.health.layers,['graph','protocol','power']);assert.equal(summarizeSchematicIR(ir).components,2);});

test('Graph ERC detects multiple drivers and unconnected power inputs without model calls',()=>{const ir=sanitizeSchematicIR({title:'ERC',components:[{ref:'U1',value:'A',pins:[pin(1,'OUT','output','right'),pin(2,'VDD','power_in','top')]},{ref:'U2',value:'B',pins:[pin(1,'OUT','output','right')]}],nets:[{name:'BAD',confidence:1,endpoints:[{ref:'U1',pin:'1'},{ref:'U2',pin:'1'}]}]});assert.ok(ir.issues.some(x=>x.code==='MULTIPLE_DRIVERS'&&x.severity==='error'));assert.ok(ir.issues.some(x=>x.code==='POWER_INPUT_UNCONNECTED'));assert.equal(ir.health.tokenCost,0);});

test('Protocol ERC clusters I2C across pull-up resistors and verifies pull-up rails',()=>{const ir=sanitizeSchematicIR({title:'I2C',components:[
 {ref:'U1',value:'MCU',pins:[pin(1,'SDA','bidirectional'),pin(2,'SCL','bidirectional')]},
 {ref:'U2',value:'SENSOR',pins:[pin(1,'SDA','bidirectional'),pin(2,'SCL','bidirectional')]},
 {ref:'R1',value:'4.7k',pins:[pin(1,'1'),pin(2,'2')]},{ref:'R2',value:'4.7k',pins:[pin(1,'1'),pin(2,'2')]},
 {ref:'U3',value:'REG',pins:[pin(1,'3V3','power_out','right')]}
],nets:[
 {name:'SDA',confidence:1,endpoints:[{ref:'U1',pin:'1'},{ref:'U2',pin:'1'},{ref:'R1',pin:'1'}]},
 {name:'SCL',confidence:1,endpoints:[{ref:'U1',pin:'2'},{ref:'U2',pin:'2'},{ref:'R2',pin:'1'}]},
 {name:'3V3',confidence:1,endpoints:[{ref:'R1',pin:'2'},{ref:'R2',pin:'2'},{ref:'U3',pin:'1'}]}
]});const i2c=ir.interfaces.filter(x=>x.type==='I2C');assert.equal(i2c.length,1);assert.deepEqual(i2c[0].members,['U1','U2']);assert.equal(i2c[0].protocolStatus,'pass');assert.ok(i2c[0].protocolChecks.some(x=>x.code==='I2C_SDA_PULLUP_OK'&&x.status==='pass'));assert.ok(i2c[0].protocolChecks.some(x=>x.code==='I2C_SCL_PULLUP_OK'&&x.status==='pass'));assert.equal(ir.protocolSummary.error,0);});

test('Protocol ERC treats shared SPI MISO as protocol review instead of generic multi-driver error when CS exists',()=>{const ir=sanitizeSchematicIR({title:'SPI',components:[
 {ref:'U1',value:'MCU',pins:[pin(1,'SCK','output'),pin(2,'MOSI','output'),pin(3,'MISO','input'),pin(4,'CS_A','output'),pin(5,'CS_B','output')]},
 {ref:'U2',value:'ADC',pins:[pin(1,'SCK','input'),pin(2,'MOSI','input'),pin(3,'MISO','output'),pin(4,'CS','input')]},
 {ref:'U3',value:'FLASH',pins:[pin(1,'SCK','input'),pin(2,'MOSI','input'),pin(3,'MISO','output'),pin(4,'CS','input')]}
],nets:[
 {name:'SPI_SCK',confidence:1,endpoints:[{ref:'U1',pin:'1'},{ref:'U2',pin:'1'},{ref:'U3',pin:'1'}]},
 {name:'SPI_MOSI',confidence:1,endpoints:[{ref:'U1',pin:'2'},{ref:'U2',pin:'2'},{ref:'U3',pin:'2'}]},
 {name:'SPI_MISO',confidence:1,endpoints:[{ref:'U1',pin:'3'},{ref:'U2',pin:'3'},{ref:'U3',pin:'3'}]},
 {name:'SPI_CS_A',confidence:1,endpoints:[{ref:'U1',pin:'4'},{ref:'U2',pin:'4'}]},
 {name:'SPI_CS_B',confidence:1,endpoints:[{ref:'U1',pin:'5'},{ref:'U3',pin:'4'}]}
]});const spi=ir.interfaces.find(x=>x.type==='SPI'&&x.members.length===3);assert.ok(spi);assert.ok(spi.protocolChecks.some(x=>x.code==='SPI_MISO_SHARED_DRIVERS'&&x.status==='review'));assert.equal(ir.issues.some(x=>x.code==='MULTIPLE_DRIVERS'&&x.nets.includes('SPI_MISO')),false);assert.ok(ir.issues.some(x=>x.code==='SPI_MISO_SHARED_DRIVERS'));});

test('modern KiCad schematic remains a renderer of Connectivity IR',()=>{const ir=sanitizeSchematicIR(raw),sch=generateModernSchematic(ir).content;assert.match(sch,/^\(kicad_sch/);assert.ok(balancedSexpr(sch));assert.match(sch,/\(generator "connectivity-intelligence-engine"\)/);assert.match(sch,/\(lib_id "Device:R"\)/);assert.match(sch,/\(property "Reference" "R1"/);assert.match(sch,/\(pin "1" \(uuid [0-9a-f-]+\)\)/);assert.match(sch,/\(instances\s+\(project "connectivity_reconstructed"/);assert.equal((sch.match(/\(label "LED_A"/g)||[]).length,2);assert.match(sch,/\(sheet_instances/);});

test('bundle exports Connectivity IR plus KiCad compatibility renderers',()=>{const ir=sanitizeSchematicIR(raw),out=buildSchematicFiles(ir),names=out.files.map(x=>x.path);assert.ok(names.includes('reconstructed.kicad_sch'));assert.ok(names.includes('reconstructed.sch'));assert.ok(names.includes('reconstructed-cache.lib'));assert.ok(names.includes('connectivity-ir.json'));assert.ok(names.includes('schematic-ir.json'));assert.ok(names.includes('connectivity-report.json'));assert.match(out.previewSvg,/<svg/);});

test('extraction prompt protects junction semantics, protocol labels and compact connectivity mode',()=>{const p=buildSchematicPrompt({fileName:'fixture.pdf'});assert.match(p,/Connectivity is the most important field|Connectivity is more important/i);assert.match(p,/WITHOUT a junction dot is NOT connected/);assert.match(p,/Protocol labels matter/);assert.match(p,/FAST CONNECTIVITY MODE/);assert.match(p,/Return ONLY valid JSON/);});

test('schematic extractor automatically retries a transient timeout and returns the second result',async()=>{const oldFetch=globalThis.fetch,oldStub=process.env.SCHEMATIC_GEMINI_STUB,oldAttempts=process.env.SCHEMATIC_AI_ATTEMPTS;delete process.env.SCHEMATIC_GEMINI_STUB;process.env.SCHEMATIC_AI_ATTEMPTS='2';let calls=0;globalThis.fetch=async()=>{calls++;if(calls===1){const e=new Error('aborted');e.name='AbortError';throw e;}return{ok:true,status:200,text:async()=>JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({title:'retry',components:[],nets:[],noConnects:[],warnings:[]})}]}}]})};};try{const r=await extractSchematicWithGemini({pdfBase64:'JVBERi0=',apiKey:'test',model:'gemini-test',fileName:'retry.pdf',deadlineMs:25000});assert.equal(calls,2);assert.equal(r.attempts,2);assert.equal(r.raw.title,'retry');}finally{globalThis.fetch=oldFetch;if(oldStub===undefined)delete process.env.SCHEMATIC_GEMINI_STUB;else process.env.SCHEMATIC_GEMINI_STUB=oldStub;if(oldAttempts===undefined)delete process.env.SCHEMATIC_AI_ATTEMPTS;else process.env.SCHEMATIC_AI_ATTEMPTS=oldAttempts;}});
