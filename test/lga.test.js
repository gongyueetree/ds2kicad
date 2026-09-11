import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBundle } from '../lib/kicadgen/index.js';
import { isLgaPackage, promoteLgaPackage } from '../lib/kicadgen/lga.js';
import { sanitizePackage } from '../lib/validate.js';

const pins = Array.from({ length: 12 }, (_, i) => ({
  number: String(i + 1),
  name: `P${i + 1}`,
  type: i === 9 || i === 10 ? 'power_in' : 'passive',
  description: ''
}));

const kxtjStyle = {
  name: '2x2mm 12-LGA',
  type: '12-LGA',
  pinCount: 12,
  pitch: 0.5,
  bodyLength: 2.0,
  bodyWidth: 2.0,
  height: 0.9,
  // Mechanical terminal dimensions from the package drawing.
  leadLength: 0.35,
  leadWidth: 0.25,
  sourcePages: [13]
};

test('LGA is explicitly recognized and promoted from the former unknown family', () => {
  assert.equal(isLgaPackage(kxtjStyle), true);
  const old = sanitizePackage(kxtjStyle);
  assert.equal(old.family, 'unknown');
  const pkg = promoteLgaPackage(old, kxtjStyle);
  assert.equal(pkg.family, 'lga');
  assert.equal(pkg.familySupported, true);
  assert.deepEqual(pkg.missingFields, []);
});

test('KXTJ-style 12-LGA generates a KiCad footprint and approximate WRL model', () => {
  const bundle = generateBundle({
    part: { mpn: 'KXTJ3-1057', title: 'Accelerometer' },
    items: [{ pkg: kxtjStyle, pins }],
    sessionAuthenticated: true,
    pinsReviewRequired: false,
    confirmedFigureCount: 1,
    figures: [{ kind: 'package_outline', page: 13, confirmed: true }]
  });
  const item = bundle.items[0];
  assert.equal(item.family, 'lga');
  assert.equal(item.blocked, false);
  assert.ok(item.files.kicadMod, JSON.stringify(item.warnings));
  assert.ok(item.files.wrl);
  assert.equal((item.files.kicadMod.match(/\(pad "/g) || []).length, 12);
  assert.match(item.files.kicadMod, /12-pin LGA/);
  assert.match(item.files.kicadMod, /package terminal geometry \(provisional derived footprint\)/);
  assert.match(item.files.wrl, /approximate parametric LGA model/);
});

test('LGA fails closed and exposes missing geometry instead of inventing a footprint', () => {
  const bad = { ...kxtjStyle, leadWidth: null };
  const bundle = generateBundle({
    part: { mpn: 'KXTJ3-1057' },
    items: [{ pkg: bad, pins }],
    sessionAuthenticated: true
  });
  const item = bundle.items[0];
  assert.equal(item.family, 'lga');
  assert.equal(item.blocked, true);
  assert.equal(item.files.kicadMod, undefined);
  assert.ok(item.missingFields.includes('leadWidth'));
  assert.ok(item.warnings.some((w) => w.includes('blocked_missing_geometry')));
});
