import test from 'node:test';
import assert from 'node:assert/strict';
import { repairConnectivityJsonText, isConnectivityShape } from '../lib/schematic/gemini.js';

const valid = {
  title: 'demo', pageCount: 1, confidence: 0.9,
  components: [{ ref: 'R1', pins: [{ number: '1', name: '1' }, { number: '2', name: '2' }] }],
  nets: [{ name: 'N1', endpoints: [{ ref: 'R1', pin: '1' }, { ref: 'R1', pin: '2' }] }],
  noConnects: [], warnings: []
};

test('Connectivity JSON guard accepts valid JSON', () => {
  const parsed = repairConnectivityJsonText(JSON.stringify(valid));
  assert.equal(isConnectivityShape(parsed), true);
  assert.equal(parsed.components[0].ref, 'R1');
});

test('Connectivity JSON guard repairs missing colon after property name', () => {
  const broken = `{
    "title": "demo",
    "components" [{"ref":"R1","pins":[{"number":"1","name":"1"}]}],
    "nets": []
  }`;
  const parsed = repairConnectivityJsonText(broken);
  assert.equal(isConnectivityShape(parsed), true);
  assert.equal(parsed.components[0].ref, 'R1');
});

test('Connectivity JSON guard repairs missing comma between properties', () => {
  const broken = `{
    "title": "demo"
    "components": [{"ref":"R1","pins":[]}],
    "nets": []
  }`;
  const parsed = repairConnectivityJsonText(broken);
  assert.equal(isConnectivityShape(parsed), true);
  assert.equal(parsed.title, 'demo');
});

test('Connectivity JSON guard repairs trailing commas and markdown fence', () => {
  const broken = '```json\n{"components":[{"ref":"R1","pins":[],}],"nets":[],}\n```';
  const parsed = repairConnectivityJsonText(broken);
  assert.equal(isConnectivityShape(parsed), true);
});

test('Connectivity JSON guard does not fabricate missing top-level graph arrays', () => {
  const parsed = repairConnectivityJsonText('{"title":"demo"}');
  assert.equal(isConnectivityShape(parsed), false);
});
