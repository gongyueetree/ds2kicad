// Deterministic PDF text-layer census for schematic completeness checks.
// Zero model tokens: extracts visible reference designators and high-confidence net labels.
import { extractTextPages } from '../pdftext.js';

const REF_RE = /^(?:R|C|L|D|Q|U|IC|J|P|CN|SW|F|FB|TP|RV|VR|X|Y|K|OP|PWR)\d+[A-Z]?$/i;
const REF_SCAN_RE = /\b(?:R|C|L|D|Q|U|IC|J|P|CN|SW|F|FB|TP|RV|VR|X|Y|K|OP|PWR)\d+[A-Z]?\b/gi;
const POWER_RE = /^(?:GND|AGND|DGND|PGND|VGND|VSS|VEE|VCC|VDD|AVDD|DVDD|VBAT|VBUS|VIN|VOUT|VREF|[-+]?[0-9]+(?:\.[0-9]+)?V)$/i;
const PROTOCOL_RE = /^(?:CS|SS|NSS|SCK|SCLK|MOSI|MISO|SDA|SCL|TX|TXD|RX|RXD|SWDIO|SWCLK|SWO|NRST|TCK|TMS|TDI|TDO|D\+|D-|USB_DP|USB_DM|CC1|CC2|AN|RST|PWM|INT)$/i;
const GENERIC_PIN_RE = /^(?:IN|OUT|NC|EN|DIS|THR|TRIG|CON|CLK|DIN|DOUT|CAP[+-]?|CH\d+|IO_?VDD)$/i;
const VALUE_UNIT_RE = /^(?:[-+]?\d+(?:\.\d+)?(?:[kKmM]|[pnuµ]?F|V|R|Ω)?|\d+(?:\.\d+)?[kKmM]|\d+(?:\.\d+)?[pnuµ]?F)$/;

const clean = (v) => String(v || '').trim();
const norm = (v) => clean(v).toUpperCase().replace(/\s+/g, '');
const uniqSorted = (arr) => [...new Set(arr.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));

function prefixOf(ref) {
  const m = /^([A-Z]+)\d/i.exec(ref);
  return m ? m[1].toUpperCase() : 'OTHER';
}

function labelKey(token) {
  const t = clean(token).replace(/[,:;()\[\]{}]/g, '');
  if (POWER_RE.test(t) || PROTOCOL_RE.test(t)) return norm(t);
  return null;
}

function likelyPartToken(text) {
  const t = clean(text);
  if (!t || REF_RE.test(t) || POWER_RE.test(t) || PROTOCOL_RE.test(t) || GENERIC_PIN_RE.test(t)) return false;
  if (VALUE_UNIT_RE.test(t)) return false;
  if (!/[A-Za-z]/.test(t) || !/\d/.test(t)) return false;
  if (t.length < 4 || t.length > 40) return false;
  return true;
}

function partHintsFromItems(pages) {
  const out = [];
  for (const page of pages || []) {
    const items = (page.items || []).map((it) => ({
      text: clean(it.text ?? it.str),
      x: Number(it.x)||0,
      y: Number(it.y)||0,
      w: Number(it.w)||0,
      h: Number(it.h)||8
    })).filter((x)=>x.text);
    const refs = items.filter((x)=>REF_RE.test(x.text));
    const parts = items.filter((x)=>likelyPartToken(x.text));
    for (const r of refs) {
      let best = null;
      for (const p of parts) {
        const dx = Math.abs((p.x + p.w/2) - (r.x + r.w/2));
        const dy = p.y - r.y; // PDF native coords: below the ref is normally negative.
        const ady = Math.abs(dy);
        if (dx > 70 || ady > 95) continue;
        let score = dx * 1.2 + ady * 0.55;
        if (dy < 0) score -= 7;
        if (/^[A-Z]{1,6}\d[A-Z0-9\-\/]+$/i.test(p.text)) score -= 4;
        if (!best || score < best.score) best = { score, value: p.text, dx, dy };
      }
      if (best && best.score < 58) {
        out.push({ ref: norm(r.text), value: best.value, page: page.page, confidence: Math.max(0.55, Math.min(0.95, 0.95 - best.score/140)) });
      }
    }
  }
  const byRef = new Map();
  for (const h of out) {
    const prev = byRef.get(h.ref);
    if (!prev || h.confidence > prev.confidence) byRef.set(h.ref, h);
  }
  return [...byRef.values()].sort((a,b)=>a.ref.localeCompare(b.ref,'en',{numeric:true}));
}

export function buildSourceCensus(textPages) {
  const pages = textPages?.pages || [];
  const refs = [];
  const labelCounts = new Map();
  let textChars = 0;
  for (const page of pages) {
    for (const line of page.lines || []) {
      const text = clean(line.text);
      textChars += text.length;
      for (const m of text.matchAll(REF_SCAN_RE)) refs.push(norm(m[0]));
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const key = labelKey(token);
        if (key) labelCounts.set(key, (labelCounts.get(key)||0)+1);
      }
    }
    // Item-level text is used only to improve reference census and ref/value pairing.
    // Net-label counts are intentionally NOT repeated here; otherwise every single occurrence
    // would be double-counted once from its line and once from its item.
    for (const it of page.items || []) {
      const text = clean(it.text ?? it.str);
      if (REF_RE.test(text)) refs.push(norm(text));
    }
  }
  const references = uniqSorted(refs);
  const countsByPrefix = {};
  for (const r of references) countsByPrefix[prefixOf(r)] = (countsByPrefix[prefixOf(r)]||0)+1;
  const netLabels = [...labelCounts.keys()].sort();
  const gateNetLabels = netLabels.filter((k)=> (labelCounts.get(k)||0) >= 2 || /^(?:GND|VCC|VDD|VGND|VREF|AGND|DGND|[-+]?[0-9.]+V)$/.test(k));
  const partHints = partHintsFromItems(pages);
  return {
    available: references.length > 0 || netLabels.length > 0,
    method: 'pdf_text_layer',
    pageCount: Number(textPages?.pageCount || pages.length || 1),
    textChars,
    references,
    countsByPrefix,
    netLabels,
    gateNetLabels,
    netLabelOccurrences: Object.fromEntries([...labelCounts.entries()]),
    partHints
  };
}

export async function censusPdf(buf, { maxPages = 3 } = {}) {
  try {
    const textPages = await extractTextPages(buf, { maxPages });
    return buildSourceCensus(textPages);
  } catch (e) {
    return { available:false, method:'pdf_text_layer', pageCount:1, textChars:0, references:[], countsByPrefix:{}, netLabels:[], gateNetLabels:[], netLabelOccurrences:{}, partHints:[], error:e.message || String(e) };
  }
}

export function censusPromptHints(census) {
  if (!census?.available) return [];
  const refs = (census.references || []).slice(0, 220);
  const labels = (census.gateNetLabels || census.netLabels || []).slice(0, 100);
  const pairs = (census.partHints || []).filter((x)=>x.confidence>=0.65).slice(0,80).map((x)=>`${x.ref}=${x.value}`);
  return [
    `SOURCE_CENSUS_REFERENCE_DESIGNATORS (${refs.length}): ${refs.join(', ')}`,
    `SOURCE_CENSUS_HIGH_CONFIDENCE_NET_LABELS (${labels.length}): ${labels.join(', ')}`,
    pairs.length ? `SOURCE_CENSUS_REF_VALUE_HINTS: ${pairs.join(', ')}` : '',
    'SOURCE_CENSUS_RULE: these were extracted deterministically from the PDF text layer. Treat them as a completeness checklist. Do not use a part number as the reference designator. If a listed reference is visually present, include it exactly; preserve visible net labels.'
  ].filter(Boolean);
}
