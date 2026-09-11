import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles, generateModernSchematic } from '../lib/schematic/kicad.js';
import { buildSchematicPrompt } from '../lib/schematic/gemini.js';

const raw = {
  title: 'LED test', confidence: 0.92,
  components: [
    { ref:'R1', value:'1k', position:{x:.3,y:.5}, pins:[
      {number:'1',name:'1',type:'passive',side:'left',confidence:.9},
      {number:'2',name:'2',type:'passive',side:'right',confidence:.9}
    ] },
    { ref:'D1', value:'LED GREEN', position:{x:.7,y:.5}, pins:[
      {number:'1',name:'K',type:'passive',side:'left',confidence:.9},
      {number:'2',name:'A',type:'passive',side:'right',confidence:.9}
    ] }
  ],
  nets:[{name:'LED_A',confidence:.95,endpoints:[{ref:'R1',pin:'2'},{ref:'D1',pin:'1'}]}]
};

test('schematic IR resolves common KiCad library hints and nets', () => {
  const ir = sanitizeSchematicIR(raw, { fileName:'fixture.pdf', model:'stub' });
  assert.equal(ir.schemaVersion, 'ds2kicad.schematic-ir.v1');
  assert.equal(ir.components.length, 2);
  assert.equal(ir.components[0].libraryId, 'Device:R');
  assert.equal(ir.components[1].libraryId, 'Device:LED');
  assert.equal(ir.nets.length, 1);
  assert.deepEqual(ir.nets[0].endpoints.map((e)=>`${e.ref}.${e.pin}`), ['R1.2','D1.1']);
  assert.equal(summarizeSchematicIR(ir).components, 2);
});

test('modern KiCad schematic contains symbols and electrical net labels', () => {
  const ir = sanitizeSchematicIR(raw);
  const sch = generateModernSchematic(ir).content;
  assert.match(sch, /^\(kicad_sch/);
  assert.match(sch, /\(lib_symbols/);
  assert.match(sch, /\(lib_id "Device:R"\)/);
  assert.match(sch, /\(property "Reference" "R1"/);
  assert.equal((sch.match(/\(label "LED_A"/g)||[]).length, 2);
  assert.match(sch, /\(sheet_instances/);
});

test('bundle includes modern and legacy fallback files', () => {
  const ir = sanitizeSchematicIR(raw);
  const out = buildSchematicFiles(ir);
  const names = out.files.map((x)=>x.path);
  assert.ok(names.includes('reconstructed.kicad_sch'));
  assert.ok(names.includes('reconstructed.sch'));
  assert.ok(names.includes('reconstructed-cache.lib'));
  assert.ok(names.includes('schematic-ir.json'));
  assert.match(out.previewSvg, /<svg/);
});

test('schematic prompt explicitly protects junction semantics', () => {
  const p = buildSchematicPrompt({ fileName:'fixture.pdf' });
  assert.match(p, /WITHOUT a junction dot is NOT connected/);
  assert.match(p, /Return ONLY valid JSON/);
});
