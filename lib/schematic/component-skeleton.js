// Deterministic component skeleton from PDF text-layer census.
// Zero model tokens. The model enriches this skeleton with pins/nets; it does not own component discovery.

const PASSIVE = /^[RCLDF]\d+/i;
const norm = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '');

function genericPins(ref) {
  if (!PASSIVE.test(ref)) return [];
  return [
    { number:'1', name:'1', type:'passive', side:'left', confidence:0.45, description:'deterministic passive pin' },
    { number:'2', name:'2', type:'passive', side:'right', confidence:0.45, description:'deterministic passive pin' }
  ];
}

export function buildComponentSkeleton(census) {
  if (!census?.available) return [];
  const hints = new Map((census.partHints || []).map((h) => [norm(h.ref), h]));
  const positions = new Map((census.referencePositions || []).map((p) => [norm(p.ref), p]));
  return (census.references || []).map((rawRef) => {
    const ref = norm(rawRef);
    const hint = hints.get(ref);
    const pos = positions.get(ref);
    const value = String(hint?.value || ref).trim();
    return {
      ref,
      value,
      mpn: hint && hint.value && /[A-Za-z].*\d|\d.*[A-Za-z]/.test(hint.value) ? hint.value : '',
      manufacturer:'',
      libraryId:'',
      footprint:'',
      position:{ x:Number(pos?.xNorm ?? 0.5), y:Number(pos?.yNorm ?? 0.5) },
      bbox:null,
      rotation:0,
      confidence:Number(pos?.confidence ?? 0.92),
      pins:genericPins(ref),
      notes:'deterministic PDF text-layer census'
    };
  });
}

function mergePins(basePins = [], incomingPins = []) {
  const byNum = new Map(basePins.map((p) => [String(p.number), { ...p }]));
  for (const p of incomingPins || []) {
    if (!p?.number) continue;
    const k = String(p.number);
    const prev = byNum.get(k) || {};
    byNum.set(k, { ...prev, ...p, number:k, confidence:Math.max(Number(prev.confidence||0), Number(p.confidence||0)) });
  }
  return [...byNum.values()];
}

export function mergeModelIntoSkeleton(skeleton, modelRaw) {
  const modelComponents = Array.isArray(modelRaw?.components) ? modelRaw.components : [];
  const byRef = new Map(modelComponents.map((c) => [norm(c.ref || c.reference), c]));
  const components = (skeleton || []).map((base) => {
    const hit = byRef.get(norm(base.ref));
    if (!hit) return base;
    return {
      ...base,
      ...hit,
      ref:base.ref,
      value:String(hit.value || hit.mpn || base.value || base.ref),
      mpn:String(hit.mpn || base.mpn || ''),
      position:hit.position || base.position,
      pins:mergePins(base.pins, hit.pins),
      confidence:Math.max(Number(base.confidence||0), Number(hit.confidence||0))
    };
  });

  // Keep model-only refs for scanned/odd source cases, but never let them replace deterministic refs.
  const known = new Set(components.map((c) => norm(c.ref)));
  for (const c of modelComponents) {
    const ref = norm(c.ref || c.reference);
    if (ref && !known.has(ref)) components.push({ ...c, ref });
  }

  return {
    ...(modelRaw || {}),
    components,
    nets:Array.isArray(modelRaw?.nets) ? modelRaw.nets : [],
    noConnects:Array.isArray(modelRaw?.noConnects) ? modelRaw.noConnects : [],
    warnings:Array.isArray(modelRaw?.warnings) ? modelRaw.warnings : []
  };
}

export function mergeConnectivityBatches(skeleton, batches = [], meta = {}) {
  const raw = { title:meta.title || 'Connectivity Design', pageCount:meta.pageCount || 1, confidence:0.0, components:[], nets:[], noConnects:[], warnings:[] };
  const compByRef = new Map((skeleton || []).map((c) => [norm(c.ref), { ...c, pins:[...(c.pins||[])] }]));
  const namedNets = new Map();
  const anonymous = [];

  for (const b of batches.filter(Boolean)) {
    for (const c of b.components || []) {
      const ref = norm(c.ref || c.reference);
      if (!ref) continue;
      const base = compByRef.get(ref) || { ref, value:c.value || c.mpn || ref, pins:[], position:c.position || {x:0.5,y:0.5}, confidence:0.5 };
      compByRef.set(ref, {
        ...base, ...c, ref,
        value:String(c.value || c.mpn || base.value || ref),
        pins:mergePins(base.pins, c.pins),
        confidence:Math.max(Number(base.confidence||0), Number(c.confidence||0))
      });
    }
    for (const n of b.nets || []) {
      const endpoints = Array.isArray(n.endpoints) ? n.endpoints.filter((e)=>e?.ref && e?.pin).map((e)=>({ ...e, ref:norm(e.ref) })) : [];
      if (endpoints.length < 2) continue;
      const name = String(n.name || '').trim();
      if (name && !/^N\$?\d+$/i.test(name)) {
        const key = name.toUpperCase();
        const prev = namedNets.get(key) || { ...n, name, endpoints:[], confidence:Number(n.confidence||0.6) };
        const epMap = new Map(prev.endpoints.map((e)=>[`${norm(e.ref)}:${e.pin}`,e]));
        for (const e of endpoints) epMap.set(`${norm(e.ref)}:${e.pin}`, e);
        prev.endpoints = [...epMap.values()];
        prev.confidence = Math.max(Number(prev.confidence||0), Number(n.confidence||0));
        namedNets.set(key, prev);
      } else anonymous.push({ ...n, name:'', endpoints });
    }
    for (const nc of b.noConnects || []) if (nc?.ref && nc?.pin) raw.noConnects.push({ ref:norm(nc.ref), pin:String(nc.pin) });
    for (const w of b.warnings || []) raw.warnings.push(String(w));
  }

  // Merge anonymous nets when they share an endpoint. This is a conservative union-find style pass.
  const anonGroups = [];
  for (const n of anonymous) {
    const set = new Set(n.endpoints.map((e)=>`${norm(e.ref)}:${e.pin}`));
    const hit = anonGroups.find((g)=>g.keys.some((k)=>set.has(k)));
    if (hit) {
      for (const e of n.endpoints) {
        const k = `${norm(e.ref)}:${e.pin}`;
        if (!hit.keys.includes(k)) { hit.keys.push(k); hit.endpoints.push(e); }
      }
      hit.confidence = Math.max(hit.confidence, Number(n.confidence||0.55));
    } else anonGroups.push({ keys:[...set], endpoints:[...n.endpoints], confidence:Number(n.confidence||0.55) });
  }

  raw.components = [...compByRef.values()];
  raw.nets = [
    ...namedNets.values(),
    ...anonGroups.filter((g)=>g.endpoints.length>=2).map((g,i)=>({ name:`N$${i+1}`, endpoints:g.endpoints, confidence:g.confidence, evidence:'merged from batched connectivity extraction' }))
  ];
  raw.noConnects = [...new Map(raw.noConnects.map((x)=>[`${x.ref}:${x.pin}`,x])).values()];
  raw.warnings = [...new Set(raw.warnings)];
  raw.confidence = raw.nets.length ? Math.min(0.95, 0.55 + Math.min(0.35, raw.nets.length/200)) : 0.35;
  return raw;
}
