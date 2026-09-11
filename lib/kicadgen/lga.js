// Deterministic perimeter-LGA footprint + approximate 3D generator.
// LGA is intentionally handled as its own family: never approximate it as SOIC/QFN.
import { escSexpr } from '../textsafe.js';

const f2 = (n) => Number(Number(n).toFixed(3));
const S = 1 / 2.54; // KiCad WRL: 1 unit = 2.54 mm
const fw = (n) => Number((Number(n) * S).toFixed(4));

export function isLgaPackage(pkg) {
  const text = `${pkg?.type || ''} ${pkg?.name || ''}`.toUpperCase();
  return /(?:^|[^A-Z])(?:V?FLGA|LGA)(?:[^A-Z]|$)/.test(text);
}

function provenanceMissing(prov, key, raw) {
  const p = prov?.[key];
  if (p) return ['missing', 'absent', 'clamped', 'invalid'].includes(p.source) || (p.source === 'reviewer' && !p.reviewer);
  const v = Number(raw?.[key]);
  return raw?.[key] === null || raw?.[key] === undefined || raw?.[key] === '' || !Number.isFinite(v) || v <= 0;
}

/** Upgrade sanitizePackage's conservative `unknown` result to an explicit, validated LGA family. */
export function promoteLgaPackage(pkg, rawPkg = {}) {
  if (!isLgaPackage(rawPkg) && !isLgaPackage(pkg)) return pkg;
  const required = ['pinCount', 'pitch', 'bodyLength', 'bodyWidth', 'leadLength', 'leadWidth', 'height'];
  const prov = { ...(pkg.fieldProvenance || {}) };
  const missing = required.filter((k) => provenanceMissing(prov, k, rawPkg));
  // Fields inherited from sanitizePackage that are dual-only should not block LGA.
  for (const k of ['leadSpan', 'rowSpan']) {
    if (prov[k]?.source === 'missing') prov[k] = { source: 'not_applicable', normalizedValue: prov[k].normalizedValue };
  }
  return {
    ...pkg,
    family: 'lga',
    familySupported: true,
    familyProvenance: {
      source: 'lga_deterministic_generator',
      resolvedFrom: `${rawPkg?.type || pkg.type || ''}|${rawPkg?.name || pkg.name || ''}`,
      notes: ['explicit_lga_family']
    },
    relevantFields: required,
    missingFields: missing,
    fieldProvenance: prov
  };
}

function pad(num, x, y, w, h, pin1 = false) {
  const shape = pin1 ? 'rect' : 'roundrect';
  const rr = pin1 ? '' : ` (roundrect_rratio ${Math.min(0.25, 0.25 / Math.min(w, h)).toFixed(3)})`;
  return `  (pad "${num}" smd ${shape} (at ${f2(x)} ${f2(y)}) (size ${f2(w)} ${f2(h)}) (layers "F.Cu" "F.Paste" "F.Mask")${rr})`;
}
function line(x1, y1, x2, y2, layer, width = 0.12) {
  return `  (fp_line (start ${f2(x1)} ${f2(y1)}) (end ${f2(x2)} ${f2(y2)}) (stroke (width ${width}) (type solid)) (layer "${layer}"))`;
}
function rect(x1, y1, x2, y2, layer, width = 0.12) {
  return [line(x1,y1,x2,y1,layer,width), line(x2,y1,x2,y2,layer,width), line(x2,y2,x1,y2,layer,width), line(x1,y2,x1,y1,layer,width)];
}

function dimensions(pkg) {
  const n = Number(pkg.pinCount);
  if (!Number.isInteger(n) || n < 4 || n % 4 !== 0) throw new Error(`LGA 管脚数 ${pkg.pinCount} 不是 4 的倍数，无法确定性还原四边焊盘`);
  const pitch = Number(pkg.pitch);
  const bodyX = Number(pkg.bodyWidth);
  const bodyY = Number(pkg.bodyLength);
  const terminalL = Number(pkg.landPattern?.padL || pkg.leadLength);
  const terminalW = Number(pkg.landPattern?.padW || pkg.leadWidth);
  for (const [name, v] of Object.entries({ pitch, bodyX, bodyY, terminalL, terminalW })) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`LGA 缺少有效 ${name} 几何参数`);
  }
  const perSide = n / 4;
  const span = (perSide - 1) * pitch;
  if (span + terminalW > bodyX + 0.15 || span + terminalW > bodyY + 0.15) {
    throw new Error(`LGA 焊盘阵列 ${perSide}/边 × ${pitch}mm 与 ${bodyX}×${bodyY}mm 本体尺寸不自洽`);
  }
  // Package-terminal geometry: terminals sit on the underside at the package perimeter.
  // If a recommended land pattern exists, pad dimensions come from it; otherwise this is provisional.
  const cx = bodyX / 2 - terminalL / 2;
  const cy = bodyY / 2 - terminalL / 2;
  return { n, perSide, pitch, bodyX, bodyY, terminalL, terminalW, cx, cy };
}

/** Pin numbering follows the existing perimeter convention: left↓, bottom→, right↑, top←. */
export function generateLgaFootprint({ fpName, pkg, pinNumbers }) {
  const d = dimensions(pkg);
  const nums = pinNumbers?.length >= d.n ? pinNumbers.map(String) : Array.from({ length: d.n }, (_, i) => String(i + 1));
  const q0 = -((d.perSide - 1) / 2) * d.pitch;
  const pads = [];
  for (let i = 0; i < d.perSide; i++) {
    const q = q0 + i * d.pitch;
    pads.push(pad(nums[i], -d.cx, q, d.terminalL, d.terminalW, i === 0));
    pads.push(pad(nums[d.perSide + i], q, d.cy, d.terminalW, d.terminalL));
    pads.push(pad(nums[2 * d.perSide + i], d.cx, -q, d.terminalL, d.terminalW));
    pads.push(pad(nums[3 * d.perSide + i], -q, -d.cy, d.terminalW, d.terminalL));
  }

  const bx = d.bodyX / 2, by = d.bodyY / 2;
  const crt = 0.25;
  const out = [];
  out.push(`(footprint "${fpName}" (version 20221018) (generator connectivity-intelligence-engine) (layer "F.Cu")`);
  const source = pkg.landPattern ? 'recommended land pattern' : 'package terminal geometry (provisional derived footprint)';
  out.push(`  (descr "${escSexpr(`${pkg.name} ${d.n}-pin LGA, body ${pkg.bodyLength}x${pkg.bodyWidth}mm, pitch ${pkg.pitch}mm, ${source}; verify against datasheet before production`)}")`);
  out.push('  (attr smd)');
  out.push(`  (tags "${escSexpr(`${pkg.type || 'LGA'} ${pkg.name || ''} ConnectivityIntelligenceEngine`)}")`);
  out.push(`  (fp_text reference "REF**" (at 0 ${f2(-by - 1.2)}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`);
  out.push(`  (fp_text value "${fpName}" (at 0 ${f2(by + 1.2)}) (layer "F.Fab") (effects (font (size 0.8 0.8) (thickness 0.12))))`);
  out.push(...rect(-bx, -by, bx, by, 'F.Fab', 0.1));
  // Pin-1 marker and minimal silkscreen corner marks, kept outside pads.
  out.push(`  (fp_circle (center ${f2(-bx - 0.25)} ${f2(-by - 0.25)}) (end ${f2(-bx - 0.12)} ${f2(-by - 0.25)}) (stroke (width 0.12) (type solid)) (fill solid) (layer "F.SilkS"))`);
  out.push(...rect(-bx - crt, -by - crt, bx + crt, by + crt, 'F.CrtYd', 0.05));
  out.push(...pads);
  out.push(`  (model "${fpName}.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`);
  out.push(')');
  return out.join('\n');
}

function box(cx, cy, cz, sx, sy, sz, material) {
  return `Transform { translation ${cx} ${cy} ${cz} children [ Shape { appearance Appearance { material Material { ${material} } } geometry Box { size ${sx} ${sy} ${sz} } } ] }`;
}

export function generateLgaWrl({ pkg }) {
  const d = dimensions(pkg);
  const bodyH = Number(pkg.height) * 0.88;
  const bodyMat = 'diffuseColor 0.16 0.16 0.18 shininess 0.25';
  const metalMat = 'diffuseColor 0.78 0.78 0.80 specularColor 0.9 0.9 0.9 shininess 0.9';
  const markMat = 'diffuseColor 0.85 0.83 0.80';
  const parts = [box(0, fw(bodyH / 2 + 0.03), 0, fw(d.bodyX * 0.98), fw(bodyH), fw(d.bodyY * 0.98), bodyMat)];
  const q0 = -((d.perSide - 1) / 2) * d.pitch;
  const t = 0.08;
  for (let i = 0; i < d.perSide; i++) {
    const q = q0 + i * d.pitch;
    parts.push(box(fw(-d.cx), fw(t / 2), fw(q), fw(d.terminalL), fw(t), fw(d.terminalW), metalMat));
    parts.push(box(fw(q), fw(t / 2), fw(d.cy), fw(d.terminalW), fw(t), fw(d.terminalL), metalMat));
    parts.push(box(fw(d.cx), fw(t / 2), fw(-q), fw(d.terminalL), fw(t), fw(d.terminalW), metalMat));
    parts.push(box(fw(-q), fw(t / 2), fw(-d.cy), fw(d.terminalW), fw(t), fw(d.terminalL), metalMat));
  }
  parts.push(`Transform { translation ${fw(-d.bodyX/2 + 0.28)} ${fw(bodyH + 0.05)} ${fw(-d.bodyY/2 + 0.28)} children [ Shape { appearance Appearance { material Material { ${markMat} } } geometry Cylinder { radius ${fw(0.12)} height ${fw(0.035)} } } ] }`);
  return `#VRML V2.0 utf8\n# Connectivity Intelligence Engine — approximate parametric LGA model\n${parts.join('\n')}\n`;
}
