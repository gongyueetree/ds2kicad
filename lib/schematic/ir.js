// Canonical intermediate representation for PDF/image schematic reconstruction.
// AI output is never written directly to KiCad. It is normalized here first.
import { randomUUID } from 'node:crypto';

export const SCHEMATIC_IR_VERSION = 'ds2kicad.schematic-ir.v1';
const PIN_TYPES = new Set([
  'input', 'output', 'bidirectional', 'power_in', 'power_out', 'passive',
  'tri_state', 'open_collector', 'no_connect', 'unspecified'
]);
const SIDES = new Set(['left', 'right', 'top', 'bottom']);

const clamp01 = (n, fallback = 0.5) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : fallback;
};
const clean = (v, max = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const confidence = (v, fallback = 0.7) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
};

function defaultPinSide(type, index = 0) {
  if (type === 'power_in') return index % 2 ? 'bottom' : 'top';
  if (type === 'power_out' || type === 'output' || type === 'bidirectional') return 'right';
  return 'left';
}

function commonLibraryId(ref, value, pinCount) {
  const r = clean(ref, 24).toUpperCase();
  const v = clean(value, 80).toUpperCase();
  if (/^R\d+/.test(r)) return 'Device:R';
  if (/^C\d+/.test(r)) return /POL|ELECT|TANT/.test(v) ? 'Device:C_Polarized' : 'Device:C';
  if (/^L\d+/.test(r)) return 'Device:L';
  if (/^F\d+/.test(r)) return 'Device:Fuse';
  if (/^D\d+/.test(r) && /LED/.test(v)) return 'Device:LED';
  if (/^D\d+/.test(r)) return 'Device:D';
  if (/^SW\d+/.test(r)) return 'Switch:SW_SPST';
  if (/^J\d+/.test(r) && pinCount > 0 && pinCount <= 40) return `Connector_Generic:Conn_01x${String(pinCount).padStart(2, '0')}`;
  return '';
}

function ensurePassivePins(ref, pins) {
  if (pins.length) return pins;
  if (/^[RCLDF]\d+/i.test(ref)) {
    return [
      { number: '1', name: '1', type: 'passive', side: 'left', confidence: 0.45 },
      { number: '2', name: '2', type: 'passive', side: 'right', confidence: 0.45 }
    ];
  }
  return pins;
}

function normalizePins(rawPins, ref, warnings) {
  const seen = new Set();
  let pins = Array.isArray(rawPins) ? rawPins.slice(0, 256).map((p, i) => {
    let number = clean(p?.number, 24);
    if (!number || number === '?') number = String(i + 1);
    if (seen.has(number)) {
      warnings.push(`${ref}: duplicate pin number ${number}; de-duplicated for generated symbol`);
      let j = 2;
      while (seen.has(`${number}_${j}`)) j++;
      number = `${number}_${j}`;
    }
    seen.add(number);
    const type = PIN_TYPES.has(p?.type) ? p.type : 'unspecified';
    const side = SIDES.has(p?.side) ? p.side : defaultPinSide(type, i);
    return {
      number,
      name: clean(p?.name || number, 80),
      type,
      side,
      confidence: confidence(p?.confidence, 0.7),
      description: clean(p?.description, 240)
    };
  }) : [];
  pins = ensurePassivePins(ref, pins);
  return pins;
}

export function sanitizeSchematicIR(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('schematic extraction returned no object');
  const warnings = [];
  const components = [];
  const refs = new Set();
  const inputComponents = Array.isArray(raw.components) ? raw.components.slice(0, 300) : [];

  for (let i = 0; i < inputComponents.length; i++) {
    const c = inputComponents[i] || {};
    let ref = clean(c.ref || c.reference || `U${i + 1}`, 32).replace(/\s+/g, '');
    if (!ref) ref = `U${i + 1}`;
    if (refs.has(ref)) {
      const base = ref;
      let n = 2;
      while (refs.has(`${base}_${n}`)) n++;
      ref = `${base}_${n}`;
      warnings.push(`duplicate reference ${base}; renamed to ${ref}`);
    }
    refs.add(ref);
    const pins = normalizePins(c.pins, ref, warnings);
    const inferred = commonLibraryId(ref, c.value || c.mpn, pins.length);
    const libraryId = clean(c.libraryId || c.library_id || inferred || `DS2KiCad:${ref}`, 120);
    const bbox = Array.isArray(c.bbox) && c.bbox.length === 4
      ? [clamp01(c.bbox[0], 0.45), clamp01(c.bbox[1], 0.45), clamp01(c.bbox[2], 0.55), clamp01(c.bbox[3], 0.55)]
      : null;
    let x = clamp01(c.position?.x ?? c.x ?? (bbox ? (bbox[0] + bbox[2]) / 2 : 0.5));
    let y = clamp01(c.position?.y ?? c.y ?? (bbox ? (bbox[1] + bbox[3]) / 2 : 0.5));
    components.push({
      id: clean(c.id, 80) || randomUUID(),
      ref,
      value: clean(c.value || c.mpn || ref, 120),
      mpn: clean(c.mpn, 120),
      manufacturer: clean(c.manufacturer, 120),
      footprint: clean(c.footprint, 180),
      libraryId,
      source: inferred && !c.libraryId && !c.library_id ? 'kicad_official_hint' : (c.libraryId || c.library_id ? 'ai_library_hint' : 'generated'),
      position: { x, y },
      bbox,
      rotation: [0, 90, 180, 270].includes(Number(c.rotation)) ? Number(c.rotation) : 0,
      pins,
      confidence: confidence(c.confidence, 0.65),
      notes: clean(c.notes, 300)
    });
  }

  const byRef = new Map(components.map((c) => [c.ref, c]));
  const nets = [];
  const rawNets = Array.isArray(raw.nets) ? raw.nets.slice(0, 1200) : [];
  let anon = 1;
  for (const n of rawNets) {
    const endpoints = [];
    const seen = new Set();
    for (const e of Array.isArray(n?.endpoints) ? n.endpoints.slice(0, 128) : []) {
      const ref = clean(e?.ref || e?.reference, 32).replace(/\s+/g, '');
      const pin = clean(e?.pin || e?.number, 24);
      const comp = byRef.get(ref);
      if (!comp || !pin) continue;
      const actual = comp.pins.find((p) => p.number === pin) || comp.pins.find((p) => p.name === pin);
      if (!actual) {
        warnings.push(`net ${clean(n?.name, 80) || '(unnamed)'}: ${ref}.${pin} not found in extracted pin list`);
        continue;
      }
      const key = `${ref}:${actual.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({ ref, pin: actual.number, confidence: confidence(e?.confidence, n?.confidence ?? 0.65) });
    }
    if (endpoints.length < 2) continue;
    const name = clean(n?.name, 100) || `N$${anon++}`;
    nets.push({
      id: clean(n?.id, 80) || randomUUID(),
      name,
      endpoints,
      confidence: confidence(n?.confidence, 0.65),
      evidence: clean(n?.evidence, 300)
    });
  }

  const connected = new Set(nets.flatMap((n) => n.endpoints.map((e) => `${e.ref}:${e.pin}`)));
  const noConnects = [];
  for (const c of components) {
    for (const p of c.pins) {
      if (p.type === 'no_connect' || (Array.isArray(raw.noConnects) && raw.noConnects.some((x) => x?.ref === c.ref && String(x?.pin) === p.number))) {
        noConnects.push({ ref: c.ref, pin: p.number });
      } else if (!connected.has(`${c.ref}:${p.number}`) && p.confidence < 0.5) {
        warnings.push(`${c.ref}.${p.number} is unconnected and low-confidence`);
      }
    }
  }

  const overall = confidence(raw.confidence, components.length ? Math.min(...components.map((c) => c.confidence)) : 0.2);
  if (!components.length) warnings.push('No components were recognized from the schematic.');
  if (components.length && !nets.length) warnings.push('Components were recognized, but no multi-endpoint nets were reconstructed.');

  return {
    schemaVersion: SCHEMATIC_IR_VERSION,
    title: clean(raw.title || meta.fileName || 'Reconstructed Schematic', 160),
    source: {
      fileName: clean(meta.fileName, 160),
      sourceUrl: clean(meta.sourceUrl, 500),
      model: clean(meta.model, 120),
      pageCount: Math.max(1, Math.min(50, Number(raw.pageCount || meta.pageCount || 1) || 1))
    },
    components,
    nets,
    noConnects,
    confidence: overall,
    warnings: [...warnings, ...(Array.isArray(raw.warnings) ? raw.warnings.map((w) => clean(w, 300)).filter(Boolean).slice(0, 100) : [])]
  };
}

export function summarizeSchematicIR(ir) {
  const pinCount = ir.components.reduce((n, c) => n + c.pins.length, 0);
  const endpointCount = ir.nets.reduce((n, net) => n + net.endpoints.length, 0);
  return {
    components: ir.components.length,
    pins: pinCount,
    nets: ir.nets.length,
    endpoints: endpointCount,
    confidence: ir.confidence,
    warnings: ir.warnings.length
  };
}
