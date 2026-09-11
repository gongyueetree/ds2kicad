// Small verified bootstrap pin-map registry used to validate exact known parts.
// This is intentionally conservative. Future versions should resolve the same contract from ezPLM.

const PARTS = [
  {
    id:'ADM8829', aliases:['ADM8829'],
    pins:[
      ['1','OUT','power_out'], ['2','IN','power_in'], ['3','CAP-','passive'],
      ['4','GND','power_in'], ['5','NC','no_connect'], ['6','CAP+','passive']
    ]
  },
  {
    id:'MCP3204', aliases:['MCP3204'],
    pins:[
      ['1','CH0','input'], ['2','CH1','input'], ['3','CH2','input'], ['4','CH3','input'],
      ['5','NC','no_connect'], ['6','NC','no_connect'], ['7','DGND','power_in'],
      ['8','CS/SHDN','input'], ['9','DIN','input'], ['10','DOUT','tri_state'], ['11','CLK','input'],
      ['12','AGND','power_in'], ['13','VREF','power_in'], ['14','VDD','power_in']
    ]
  },
  {
    id:'NE555', aliases:['NE555','LM555','SE555'],
    pins:[
      ['1','GND','power_in'], ['2','TRIG','input'], ['3','OUT','output'], ['4','RST','input'],
      ['5','CON','input'], ['6','THR','input'], ['7','DIS','open_collector'], ['8','VCC','power_in']
    ]
  },
  {
    id:'MAX6106', aliases:['MAX6106'],
    pins:[['1','IN','power_in'],['2','OUT','power_out'],['3','GND','power_in']]
  }
];

const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
const pinName = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9+\-/]/g,'');

export function findKnownPart(component) {
  const fields = [component?.mpn, component?.value, component?.ref].map(norm).filter(Boolean);
  for (const part of PARTS) {
    if (part.aliases.some((a)=>fields.includes(norm(a)))) return part;
  }
  return null;
}

function defaultSide(type, index) {
  if (type === 'power_in') return index % 2 ? 'bottom' : 'top';
  if (['output','power_out','tri_state'].includes(type)) return 'right';
  return 'left';
}

function renameRef(ir, from, to) {
  if (from === to) return ir;
  return {
    ...ir,
    components: ir.components.map((c)=>c.ref===from?{...c,ref:to}:c),
    nets: ir.nets.map((n)=>({...n,endpoints:n.endpoints.map((e)=>e.ref===from?{...e,ref:to}:e)})),
    noConnects: (ir.noConnects||[]).map((x)=>x.ref===from?{...x,ref:to}:x)
  };
}

/** Deterministically reconcile obvious ref/value swaps using PDF text-layer ref/value hints. */
export function reconcileReferenceHints(inputIr, census) {
  let ir = inputIr;
  const changes = [];
  const sourceRefs = new Set((census?.references||[]).map((x)=>String(x).toUpperCase()));
  for (const hint of census?.partHints || []) {
    if (Number(hint.confidence||0) < 0.66) continue;
    const target = String(hint.ref||'').toUpperCase();
    if (!target || ir.components.some((c)=>String(c.ref).toUpperCase()===target)) continue;
    const hv = norm(hint.value);
    if (!hv) continue;
    const candidates = ir.components.filter((c)=>[c.mpn,c.value,c.ref].some((v)=>norm(v)===hv));
    if (candidates.length !== 1) continue;
    const c = candidates[0];
    // Never overwrite another plausible source reference; this only repairs obvious MPN-as-ref mistakes.
    if (sourceRefs.has(String(c.ref).toUpperCase())) continue;
    const from = c.ref;
    ir = renameRef(ir, from, target);
    changes.push({ type:'reference_reconciled', from, to:target, value:hint.value, confidence:hint.confidence });
  }
  return { ir, changes };
}

export function reconcileKnownPinMaps(inputIr) {
  const components = [];
  const checks = [];
  for (const comp of inputIr.components || []) {
    const known = findKnownPart(comp);
    if (!known) { components.push(comp); continue; }
    const oldByNum = new Map((comp.pins||[]).map((p)=>[String(p.number),p]));
    const expectedNums = new Set(known.pins.map((x)=>x[0]));
    const corrections = [];
    let compared = 0, mismatches = 0, missing = 0;
    const pins = known.pins.map(([number,name,type],i)=>{
      const old = oldByNum.get(number);
      if (old) {
        compared++;
        if (pinName(old.name)!==pinName(name) || old.type!==type) {
          mismatches++;
          corrections.push({ pin:number, from:{name:old.name,type:old.type}, to:{name,type} });
        }
      } else {
        missing++;
        corrections.push({ pin:number, from:null, to:{name,type} });
      }
      return {
        ...(old||{}), number, name, type,
        side: old?.side || defaultSide(type,i),
        confidence: Math.max(Number(old?.confidence||0),0.98),
        canonicalSource:'verified_pinmap_bootstrap'
      };
    });
    const extras = (comp.pins||[]).filter((p)=>!expectedNums.has(String(p.number))).map((p)=>({...p,confidence:Math.min(Number(p.confidence||0.5),0.4),knownMapConflict:true}));
    components.push({...comp,pins:[...pins,...extras],knownPart:known.id});
    checks.push({
      ref:comp.ref, part:known.id, expectedPins:known.pins.length,
      compared, mismatches, missingAdded:missing, extraPins:extras.map((p)=>p.number), corrections,
      originalAccuracy: compared ? (compared-mismatches)/compared : 0,
      unresolved: extras.length > 0
    });
  }
  return { ir:{...inputIr,components}, checks };
}

export const KNOWN_PART_IDS = PARTS.map((p)=>p.id);
