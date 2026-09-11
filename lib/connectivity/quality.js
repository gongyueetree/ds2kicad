// Source-grounded quality gate for Connectivity Intelligence Engine.
// Converts model self-confidence into measurable source coverage + pin-map + graph consistency.
import { analyzeConnectivity } from './analysis.js';
import { reconcileReferenceHints, reconcileKnownPinMaps } from './known-parts.js';

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x)||0));
const norm = (v) => String(v||'').toUpperCase().replace(/\s+/g,'');

function qualityIssue(id,severity,code,title,detail,refs=[],nets=[]) {
  return { id, layer:'quality', severity, code, title, detail, refs:[...new Set(refs)], nets:[...new Set(nets)] };
}

function matchCoverage(sourceValues, actualValues) {
  const src = [...new Set((sourceValues||[]).map(norm).filter(Boolean))];
  const actual = new Set((actualValues||[]).map(norm).filter(Boolean));
  const matched = src.filter((x)=>actual.has(x));
  const missing = src.filter((x)=>!actual.has(x));
  return { source:src.length, matched:matched.length, ratio:src.length?matched.length/src.length:null, matchedItems:matched, missingItems:missing };
}

export function applyConnectivityQuality(inputIr, census = null) {
  const modelConfidence = Number(inputIr.confidence || 0);
  const refRec = reconcileReferenceHints(inputIr, census);
  const pinRec = reconcileKnownPinMaps(refRec.ir);
  let ir = pinRec.ir;

  // Re-run deterministic ERC after canonical pin names/types and ref reconciliation.
  const analysis = analyzeConnectivity(ir);
  ir = { ...ir, ...analysis };

  const sourceRefs = census?.available ? (census.references || []) : [];
  const sourceNetLabels = census?.available ? (census.gateNetLabels || []) : [];
  const compCoverage = matchCoverage(sourceRefs, ir.components.map((c)=>c.ref));
  const netCoverage = matchCoverage(sourceNetLabels, ir.nets.map((n)=>n.name));

  const knownCompared = pinRec.checks.reduce((n,x)=>n+x.compared,0);
  const knownMismatches = pinRec.checks.reduce((n,x)=>n+x.mismatches,0);
  const knownMissing = pinRec.checks.reduce((n,x)=>n+x.missingAdded,0);
  const knownExtra = pinRec.checks.reduce((n,x)=>n+x.extraPins.length,0);
  const pinAccuracy = knownCompared ? clamp01((knownCompared-knownMismatches)/knownCompared) : null;

  const baseErrors = analysis.health?.error || 0;
  const baseWarnings = analysis.health?.warning || 0;
  const baseReview = analysis.health?.review || 0;
  const graphDen = Math.max(8, ir.components.length + ir.nets.length);
  const graphConsistency = clamp01(1 - (baseErrors*2 + baseWarnings*0.45 + baseReview*0.2)/graphDen);

  // Re-normalize weights when a source signal is unavailable (e.g. scanned image with no text layer).
  const signals = [
    { key:'components', weight:0.30, value:compCoverage.ratio },
    { key:'nets', weight:0.40, value:netCoverage.ratio },
    { key:'pins', weight:0.20, value:pinAccuracy },
    { key:'graph', weight:0.10, value:graphConsistency }
  ].filter((x)=>x.value !== null && Number.isFinite(x.value));
  const weightSum = signals.reduce((n,x)=>n+x.weight,0) || 1;
  const score = Math.round(100 * signals.reduce((n,x)=>n+x.weight*x.value,0)/weightSum);

  const minComp = Number(process.env.SCHEMATIC_MIN_COMPONENT_COVERAGE || 0.70);
  const minNet = Number(process.env.SCHEMATIC_MIN_NET_COVERAGE || 0.70);
  const reasons = [];
  if (compCoverage.source >= 4 && (compCoverage.ratio ?? 1) < minComp) reasons.push({ code:'COMPONENT_COVERAGE_LOW', detail:`${compCoverage.matched}/${compCoverage.source} source references reconstructed` });
  if (netCoverage.source >= 3 && ir.nets.length === 0) reasons.push({ code:'VISIBLE_NETS_BUT_ZERO_RECONSTRUCTED', detail:`PDF text layer contains ${netCoverage.source} high-confidence net labels but no nets were reconstructed` });
  if (netCoverage.source >= 3 && (netCoverage.ratio ?? 1) < minNet) reasons.push({ code:'NAMED_NET_COVERAGE_LOW', detail:`${netCoverage.matched}/${netCoverage.source} high-confidence named nets reconstructed` });
  for (const chk of pinRec.checks) {
    if (chk.compared >= 3 && chk.originalAccuracy < 0.8) reasons.push({ code:'KNOWN_PINMAP_CONFLICT', detail:`${chk.ref} ${chk.part}: original pin-map accuracy ${Math.round(chk.originalAccuracy*100)}%; canonical map was applied` });
    if (chk.unresolved) reasons.push({ code:'KNOWN_PINMAP_EXTRA_PINS', detail:`${chk.ref} ${chk.part}: unexpected pins ${chk.extraPins.join(', ')}` });
  }

  let status = reasons.length ? 'rejected' : (score < 85 || refRec.changes.length || knownMismatches || knownMissing ? 'review' : 'accepted');
  if (!census?.available && status === 'accepted' && score < 90) status = 'review';

  const qIssues = [];
  let q = 1;
  if (compCoverage.source >= 4 && compCoverage.ratio < minComp) qIssues.push(qualityIssue(`quality-${q++}`,'error','COMPONENT_COVERAGE_LOW','Source component coverage is too low',`${compCoverage.matched} of ${compCoverage.source} PDF reference designators were reconstructed. Missing: ${compCoverage.missingItems.slice(0,30).join(', ')}${compCoverage.missingItems.length>30?'…':''}`,compCoverage.missingItems.slice(0,30)));
  if (netCoverage.source >= 3 && netCoverage.ratio < minNet) qIssues.push(qualityIssue(`quality-${q++}`,'error','NAMED_NET_COVERAGE_LOW','Source named-net coverage is too low',`${netCoverage.matched} of ${netCoverage.source} high-confidence PDF net labels were reconstructed. Missing: ${netCoverage.missingItems.join(', ')}`,[],netCoverage.missingItems));
  if (netCoverage.source >= 3 && !ir.nets.length) qIssues.push(qualityIssue(`quality-${q++}`,'error','VISIBLE_NETS_BUT_ZERO_RECONSTRUCTED','Visible net labels exist but no nets were reconstructed',`The PDF text layer exposes ${netCoverage.source} high-confidence labels, while Connectivity IR contains zero nets.`));
  for (const c of refRec.changes) qIssues.push(qualityIssue(`quality-${q++}`,'review','REFERENCE_RECONCILED','Reference designator was repaired from source census',`${c.from} was changed to ${c.to} because the PDF text layer associates ${c.to} with ${c.value}.`,[c.to]));
  for (const chk of pinRec.checks) {
    if (chk.mismatches || chk.missingAdded) qIssues.push(qualityIssue(`quality-${q++}`,'review','KNOWN_PINMAP_RECONCILED','Known-part pin map was reconciled',`${chk.ref} ${chk.part}: ${chk.mismatches} mismatched and ${chk.missingAdded} missing pins were replaced/added from the verified canonical map.`,[chk.ref]));
    if (chk.extraPins.length) qIssues.push(qualityIssue(`quality-${q++}`,'error','KNOWN_PINMAP_EXTRA_PINS','Unexpected pins on known part',`${chk.ref} ${chk.part} has unexpected pins: ${chk.extraPins.join(', ')}.`,[chk.ref]));
  }

  const allIssues = [...analysis.issues, ...qIssues];
  const counts = { error:0, warning:0, review:0, passed:analysis.health?.passed||0 };
  for (const x of allIssues) counts[x.severity] = (counts[x.severity]||0)+1;

  const qualityGate = {
    status,
    accepted: status === 'accepted',
    exportAllowed: status !== 'rejected',
    score,
    reasons,
    sourceCensusAvailable: !!census?.available,
    coverage: {
      components: compCoverage,
      namedNets: netCoverage,
      knownPins: { compared:knownCompared, mismatches:knownMismatches, missingAdded:knownMissing, extraPins:knownExtra, accuracy:pinAccuracy },
      graphConsistency
    },
    referenceReconciliations: refRec.changes,
    knownPartChecks: pinRec.checks,
    modelConfidence
  };

  return {
    ...ir,
    source: { ...(ir.source||{}), census: census || null, modelConfidence },
    confidence: score/100,
    issues: allIssues,
    qualityGate,
    health: {
      ...(analysis.health||{}), ...counts,
      score,
      ercScore: analysis.health?.score ?? null,
      qualityStatus: status,
      sourceGrounded: !!census?.available,
      layers: [...new Set([...(analysis.health?.layers||[]),'quality'])]
    }
  };
}

export function qualitySummary(ir) {
  const q = ir?.qualityGate;
  return q ? {
    qualityStatus:q.status,
    qualityAccepted:q.accepted,
    connectivityScore:q.score,
    componentCoverage:q.coverage?.components?.ratio ?? null,
    componentSourceCount:q.coverage?.components?.source ?? 0,
    componentMatchedCount:q.coverage?.components?.matched ?? 0,
    namedNetCoverage:q.coverage?.namedNets?.ratio ?? null,
    namedNetSourceCount:q.coverage?.namedNets?.source ?? 0,
    namedNetMatchedCount:q.coverage?.namedNets?.matched ?? 0,
    exportAllowed:q.exportAllowed,
    gateReasons:q.reasons || []
  } : {};
}
