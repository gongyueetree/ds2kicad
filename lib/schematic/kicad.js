// Deterministic Schematic IR -> KiCad compiler.
// Emits modern KiCad 9/10-style .kicad_sch plus legacy .sch/cache.lib fallback.
import { randomUUID } from 'node:crypto';

const GRID = 2.54;
const GRID_TEXT = 1.27;
const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
const safeName = (v) => String(v || 'item').replace(/[^A-Za-z0-9_+.-]/g, '_').slice(0, 80) || 'item';
const snap = (n) => Math.round(Number(n) / GRID) * GRID;
const f = (n) => Number(Number(n).toFixed(2)).toString();

const TYPE = new Set(['input','output','bidirectional','power_in','power_out','passive','tri_state','open_collector','no_connect','unspecified']);
const PIN_ANGLE = { left: 0, right: 180, top: 270, bottom: 90 };
const LEGACY_ORIENT = { left: 'R', right: 'L', top: 'D', bottom: 'U' };
const LEGACY_TYPE = { input:'I', output:'O', bidirectional:'B', power_in:'W', power_out:'w', passive:'P', tri_state:'T', open_collector:'C', no_connect:'N', unspecified:'U' };

function effects({ hide = false, justify = '' } = {}) {
  return `(effects (font (size ${GRID_TEXT} ${GRID_TEXT}))${justify ? ` (justify ${justify})` : ''}${hide ? ' hide' : ''})`;
}

function pagePoint(pos = {}) {
  return {
    x: snap(25 + Math.max(0, Math.min(1, Number(pos.x ?? 0.5))) * 160),
    y: snap(25 + Math.max(0, Math.min(1, Number(pos.y ?? 0.5))) * 235)
  };
}

function pinLayout(pins = []) {
  const sides = { left: [], right: [], top: [], bottom: [] };
  for (const p of pins) (sides[p.side] || sides.left).push(p);
  const rows = Math.max(sides.left.length, sides.right.length, 2);
  const halfW = Math.max(5.08, snap((Math.max(4, ...pins.map((p) => String(p.name || '').length)) * 0.7 + 3) * 1.27));
  const halfH = Math.max(5.08, snap((rows + 1) * 1.27));
  const pinLen = 2.54;
  const items = [];
  const rowYs = (arr) => arr.map((_, i) => snap((i - (arr.length - 1) / 2) * GRID));
  const colXs = (arr) => arr.map((_, i) => snap((i - (arr.length - 1) / 2) * GRID));
  rowYs(sides.left).forEach((y, i) => items.push({ pin: sides.left[i], x: -(halfW + pinLen), y, side: 'left' }));
  rowYs(sides.right).forEach((y, i) => items.push({ pin: sides.right[i], x: halfW + pinLen, y, side: 'right' }));
  colXs(sides.top).forEach((x, i) => items.push({ pin: sides.top[i], x, y: -(halfH + pinLen), side: 'top' }));
  colXs(sides.bottom).forEach((x, i) => items.push({ pin: sides.bottom[i], x, y: halfH + pinLen, side: 'bottom' }));
  return { halfW, halfH, pinLen, items };
}

function symbolDefinition(libId, pins) {
  const g = pinLayout(pins);
  const base = safeName(libId.replace(':', '_'));
  const refPrefix = /^[RCLDFQJSTP]/i.test(base) ? base[0].toUpperCase() : 'U';
  const out = [
    `    (symbol "${esc(libId)}"`,
    `      (pin_names (offset 0.508))`,
    `      (exclude_from_sim no)`,
    `      (in_bom yes)`,
    `      (on_board yes)`,
    `      (property "Reference" "${refPrefix}" (at 0 ${f(-g.halfH - 2.54)} 0) ${effects()})`,
    `      (property "Value" "${esc(libId.split(':').pop() || base)}" (at 0 ${f(g.halfH + 2.54)} 0) ${effects()})`,
    `      (property "Footprint" "" (at 0 0 0) ${effects({ hide:true })})`,
    `      (property "Datasheet" "" (at 0 0 0) ${effects({ hide:true })})`,
    `      (property "Description" "Reconstructed by DS2KiCad" (at 0 0 0) ${effects({ hide:true })})`,
    `      (symbol "${base}_0_1"`,
    `        (rectangle (start ${f(-g.halfW)} ${f(-g.halfH)}) (end ${f(g.halfW)} ${f(g.halfH)})`,
    `          (stroke (width 0.254) (type default)) (fill (type background)))`,
    `      )`,
    `      (symbol "${base}_1_1"`
  ];
  for (const it of g.items) {
    const p = it.pin;
    const type = TYPE.has(p.type) ? p.type : 'unspecified';
    out.push(
      `        (pin ${type} line (at ${f(it.x)} ${f(it.y)} ${PIN_ANGLE[it.side]}) (length ${f(g.pinLen)})`,
      `          (name "${esc(p.name || p.number)}" ${effects()})`,
      `          (number "${esc(p.number)}" ${effects()}))`
    );
  }
  out.push('      )', '    )');
  return { text: out.join('\n'), geometry: g };
}

function compileDefinitions(ir) {
  const defs = new Map();
  const compInfo = new Map();
  for (const c of ir.components) {
    const libId = c.libraryId || `DS2KiCad:${c.ref}`;
    const signature = JSON.stringify(c.pins.map((p) => [p.number,p.name,p.type,p.side]));
    let effectiveLibId = libId;
    const hit = defs.get(effectiveLibId);
    if (hit && hit.signature !== signature) effectiveLibId = `DS2KiCad:${c.ref}`;
    if (!defs.has(effectiveLibId)) defs.set(effectiveLibId, { ...symbolDefinition(effectiveLibId, c.pins), signature });
    compInfo.set(c.ref, { libId: effectiveLibId, geometry: defs.get(effectiveLibId).geometry, at: pagePoint(c.position) });
  }
  return { defs, compInfo };
}

function pinAbsolute(comp, pinNumber, compInfo) {
  const info = compInfo.get(comp.ref);
  if (!info) return null;
  const it = info.geometry.items.find((x) => String(x.pin.number) === String(pinNumber));
  if (!it) return null;
  return { x: snap(info.at.x + it.x), y: snap(info.at.y + it.y), side: it.side };
}

function modernProperties(c, at) {
  const refY = at.y - 5.08;
  const valY = at.y + 5.08;
  return [
    `    (property "Reference" "${esc(c.ref)}" (at ${f(at.x)} ${f(refY)} 0) ${effects()})`,
    `    (property "Value" "${esc(c.value || c.mpn || c.ref)}" (at ${f(at.x)} ${f(valY)} 0) ${effects()})`,
    `    (property "Footprint" "${esc(c.footprint || '')}" (at ${f(at.x)} ${f(at.y)} 0) ${effects({ hide:true })})`,
    `    (property "Datasheet" "" (at ${f(at.x)} ${f(at.y)} 0) ${effects({ hide:true })})`
  ];
}

export function generateModernSchematic(ir) {
  const root = randomUUID();
  const projectName = 'reconstructed';
  const { defs, compInfo } = compileDefinitions(ir);
  const lines = [
    `(kicad_sch (version 20250114) (generator "ds2kicad")`,
    `  (generator_version "1.0")`,
    `  (uuid ${root})`,
    `  (paper "A4")`,
    `  (lib_symbols`
  ];
  for (const d of defs.values()) lines.push(d.text);
  lines.push('  )');

  for (const c of ir.components) {
    const info = compInfo.get(c.ref);
    const symbolUuid = randomUUID();
    lines.push(`  (symbol`);
    lines.push(`    (lib_id "${esc(info.libId)}")`);
    lines.push(`    (lib_name "${esc(info.libId.split(':').pop() || info.libId)}")`);
    lines.push(`    (at ${f(info.at.x)} ${f(info.at.y)} 0)`);
    lines.push(`    (unit 1)`);
    lines.push(`    (exclude_from_sim no)`);
    lines.push(`    (in_bom yes)`);
    lines.push(`    (on_board yes)`);
    lines.push(`    (dnp no)`);
    lines.push(`    (uuid ${symbolUuid})`);
    lines.push(...modernProperties(c, info.at));
    for (const p of c.pins) lines.push(`    (pin "${esc(p.number)}" (uuid ${randomUUID()}))`);
    lines.push(`    (instances`);
    lines.push(`      (project "${projectName}"`);
    lines.push(`        (path "/${root}"`);
    lines.push(`          (reference "${esc(c.ref)}")`);
    lines.push(`          (unit 1)`);
    lines.push(`        )`);
    lines.push(`      )`);
    lines.push(`    )`);
    lines.push(`  )`);
  }

  // Same-name local labels are placed directly on the regenerated pin anchors. This preserves
  // electrical connectivity without asking a vision model to hallucinate graphical wire routes.
  for (const net of ir.nets) {
    for (const ep of net.endpoints) {
      const comp = ir.components.find((c) => c.ref === ep.ref);
      const p = comp ? pinAbsolute(comp, ep.pin, compInfo) : null;
      if (!p) continue;
      lines.push(`  (label "${esc(net.name)}" (at ${f(p.x)} ${f(p.y)} 0)`);
      lines.push(`    ${effects()}`);
      lines.push(`    (uuid ${randomUUID()}))`);
    }
  }
  for (const nc of ir.noConnects || []) {
    const comp = ir.components.find((c) => c.ref === nc.ref);
    const p = comp ? pinAbsolute(comp, nc.pin, compInfo) : null;
    if (p) lines.push(`  (no_connect (at ${f(p.x)} ${f(p.y)}) (uuid ${randomUUID()}))`);
  }
  lines.push(`  (sheet_instances`);
  lines.push(`    (path "/" (page "1"))`);
  lines.push(`  )`);
  lines.push(`  (embedded_fonts no)`);
  lines.push(')');
  return { content: lines.join('\n'), compInfo };
}

function legacyDefName(libId) { return safeName(libId.replace(':', '_')); }

function legacySymbolDef(libId, pins) {
  const g = pinLayout(pins);
  const k = 39.37007874;
  const out = [
    `#`, `# ${legacyDefName(libId)}`, `#`,
    `DEF ${legacyDefName(libId)} U 0 40 Y Y 1 F N`,
    `F0 "U" 0 ${Math.round((-g.halfH - 3.81) * k)} 50 H V C CNN`,
    `F1 "${legacyDefName(libId)}" 0 ${Math.round((g.halfH + 3.81) * k)} 50 H V C CNN`,
    `DRAW`,
    `S ${Math.round(-g.halfW*k)} ${Math.round(-g.halfH*k)} ${Math.round(g.halfW*k)} ${Math.round(g.halfH*k)} 0 1 10 f`
  ];
  for (const it of g.items) {
    const p = it.pin;
    out.push(`X ${safeName(p.name || p.number)} ${safeName(p.number)} ${Math.round(it.x*k)} ${Math.round(-it.y*k)} ${Math.round(g.pinLen*k)} ${LEGACY_ORIENT[it.side]} 50 50 1 1 ${LEGACY_TYPE[p.type] || 'U'}`);
  }
  out.push('ENDDRAW', 'ENDDEF');
  return { text: out.join('\n'), geometry: g };
}

export function generateLegacySchematic(ir) {
  const k = 39.37007874;
  const { defs, compInfo } = compileDefinitions(ir);
  const cache = ['EESchema-LIBRARY Version 2.4', '#encoding utf-8'];
  for (const [libId, d] of defs.entries()) cache.push(legacySymbolDef(libId, d.geometry.items.map((x) => x.pin)).text);
  cache.push('#End Library');

  const lines = [
    'EESchema Schematic File Version 4',
    'LIBS:reconstructed-cache',
    'EELAYER 29 0', 'EELAYER END',
    '$Descr A4 11693 8268', 'Sheet 1 1', `Title "${esc(ir.title)}"`, '$EndDescr'
  ];
  for (const c of ir.components) {
    const info = compInfo.get(c.ref);
    const x = Math.round(info.at.x * k), y = Math.round(info.at.y * k);
    lines.push('$Comp');
    lines.push(`L ${legacyDefName(info.libId)} ${safeName(c.ref)}`);
    lines.push(`U 1 1 ${randomUUID().replace(/-/g,'').slice(0,8).toUpperCase()}`);
    lines.push(`P ${x} ${y}`);
    lines.push(`F 0 "${esc(c.ref)}" H ${x} ${y-150} 50  0000 C CNN`);
    lines.push(`F 1 "${esc(c.value || c.mpn || c.ref)}" H ${x} ${y+150} 50  0000 C CNN`);
    lines.push(`F 2 "${esc(c.footprint || '')}" H ${x} ${y} 50  0001 C CNN`);
    lines.push(`\t1    ${x} ${y}`, '\t1    0    0    -1', '$EndComp');
  }
  for (const net of ir.nets) {
    for (const ep of net.endpoints) {
      const comp = ir.components.find((c) => c.ref === ep.ref);
      const p = comp ? pinAbsolute(comp, ep.pin, compInfo) : null;
      if (!p) continue;
      const x = Math.round(p.x*k), y = Math.round(p.y*k);
      lines.push(`Text Label ${x} ${y} 0    50   ~ 0`, esc(net.name));
    }
  }
  lines.push('$EndSCHEMATC');
  return { schematic: lines.join('\n'), cacheLib: cache.join('\n') };
}

export function generateSchematicPreviewSvg(ir) {
  const { compInfo } = compileDefinitions(ir);
  const W = 920, H = 620;
  const sx = (x) => x / 210 * W;
  const sy = (y) => y / 297 * H;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`, `<rect width="100%" height="100%" fill="white"/>`];
  for (const net of ir.nets) {
    const pts = net.endpoints.map((ep) => {
      const c = ir.components.find((x) => x.ref === ep.ref);
      return c ? pinAbsolute(c, ep.pin, compInfo) : null;
    }).filter(Boolean);
    if (pts.length >= 2) {
      const a = pts[0];
      for (const b of pts.slice(1)) parts.push(`<path d="M ${sx(a.x)} ${sy(a.y)} L ${sx(b.x)} ${sy(b.y)}" stroke="#9aa4b2" stroke-width="1.5" fill="none"/>`);
    }
  }
  for (const c of ir.components) {
    const info = compInfo.get(c.ref); const g = info.geometry;
    const x = sx(info.at.x-g.halfW), y = sy(info.at.y-g.halfH), w = sx(g.halfW*2), h = sy(g.halfH*2);
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f8fafc" stroke="#334155" stroke-width="1.2" rx="3"/>`);
    parts.push(`<text x="${sx(info.at.x)}" y="${sy(info.at.y)-3}" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700">${xml(c.ref)}</text>`);
    parts.push(`<text x="${sx(info.at.x)}" y="${sy(info.at.y)+11}" text-anchor="middle" font-family="sans-serif" font-size="9">${xml(c.value)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

const xml = (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export function buildSchematicFiles(ir) {
  const modern = generateModernSchematic(ir);
  const legacy = generateLegacySchematic(ir);
  const report = {
    schemaVersion: ir.schemaVersion,
    title: ir.title,
    confidence: ir.confidence,
    componentCount: ir.components.length,
    netCount: ir.nets.length,
    warnings: ir.warnings,
    note: 'Generated by DS2KiCad. Verify low-confidence pin mappings and nets before production use.'
  };
  return {
    files: [
      { path: 'reconstructed.kicad_sch', content: modern.content, contentType: 'text/plain' },
      { path: 'reconstructed.sch', content: legacy.schematic, contentType: 'text/plain' },
      { path: 'reconstructed-cache.lib', content: legacy.cacheLib, contentType: 'text/plain' },
      { path: 'schematic-ir.json', content: JSON.stringify(ir, null, 2), contentType: 'application/json' },
      { path: 'conversion-report.json', content: JSON.stringify(report, null, 2), contentType: 'application/json' }
    ],
    previewSvg: generateSchematicPreviewSvg(ir),
    report
  };
}
