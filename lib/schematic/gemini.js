// Vision/LLM layer for schematic reconstruction.
// It outputs only logical IR candidates. KiCad files are generated deterministically elsewhere.
import { repairJSON } from '../gemini.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildSchematicPrompt({ fileName = '', libraryHints = [] } = {}) {
  const hints = Array.isArray(libraryHints) && libraryHints.length
    ? `\nKnown ezPLM/KiCad library candidates that may appear in this design:\n${libraryHints.slice(0, 80).join('\n')}`
    : '';
  return `You are reconstructing an ELECTRONIC SCHEMATIC from a PDF/image into a structured intermediate representation.
Do NOT output KiCad text. Do NOT invent electrical connectivity. Follow visible wires, junction dots, net labels, pin labels and reference designators.

Source file: ${fileName || 'uploaded schematic'}${hints}

Return ONLY valid JSON with this exact top-level shape:
{
  "title": "...",
  "pageCount": 1,
  "confidence": 0.0,
  "components": [
    {
      "ref": "U1",
      "value": "part/value printed near symbol",
      "mpn": "manufacturer part number if visible, otherwise empty",
      "manufacturer": "if visible, otherwise empty",
      "libraryId": "KiCad library hint if confidently recognized, otherwise empty",
      "footprint": "only if explicitly printed or unambiguous from the source, otherwise empty",
      "position": {"x": 0.0, "y": 0.0},
      "bbox": [0.0,0.0,1.0,1.0],
      "rotation": 0,
      "confidence": 0.0,
      "pins": [
        {"number":"1","name":"IN+","type":"input","side":"left","confidence":0.0,"description":""}
      ],
      "notes": ""
    }
  ],
  "nets": [
    {
      "name": "VIN or empty for unnamed",
      "confidence": 0.0,
      "evidence": "short explanation such as label VIN joins U1.3 and R1.1",
      "endpoints": [
        {"ref":"U1","pin":"3","confidence":0.0},
        {"ref":"R1","pin":"1","confidence":0.0}
      ]
    }
  ],
  "noConnects": [{"ref":"U2","pin":"7"}],
  "warnings": ["ambiguous observations only"]
}

STRICT RECONSTRUCTION RULES:
1. Coordinates are normalized to each source page: top-left=(0,0), bottom-right=(1,1). For multi-page PDFs, reconstruct the first actual schematic sheet only in this P0 runtime and report the total pageCount.
2. Every visible component reference (R1, C3, U2, J1, D4, Q1, TP1, etc.) must appear exactly once. Exclude title-block logos and drawing decorations.
3. For R/C/L/fuse/diode/LED/switch two-terminal symbols whose pin numbers are not printed, assign pin 1 to the visually left/top terminal and pin 2 to the right/bottom terminal. Set pin confidence <=0.6 when inferred.
4. For ICs/connectors, copy visible pin numbers and names. If a pin number truly cannot be read, use a unique sequential number but confidence <=0.35 and add a warning. Never silently claim a guessed IC pin mapping is high confidence.
5. Allowed pin types: input, output, bidirectional, power_in, power_out, passive, tri_state, open_collector, no_connect, unspecified. Power rails and grounds are power_in unless clearly outputs.
6. Pin side is one of left/right/top/bottom, referring to the visual side of the symbol in the source image.
7. Connectivity is the most important field. Trace each wire from endpoint to endpoint. A line crossing another line WITHOUT a junction dot is NOT connected. A crossing WITH a junction dot IS connected. Same-name net labels connect electrically even when no continuous line is drawn.
8. Each net endpoint must reference a component ref and a pin NUMBER from that component's pins array. Do not use pin names in endpoint.pin unless the source uses alphanumeric ball/pin designators such as A1.
9. Do not create a net with fewer than two component endpoints. Power labels that touch only one component may be omitted from nets in this P0 output unless they connect multiple visible endpoints.
10. Use KiCad official library IDs only when obvious: Device:R, Device:C, Device:C_Polarized, Device:L, Device:D, Device:LED, Device:Fuse, Switch:SW_SPST, Connector_Generic:Conn_01xNN. For ICs, leave libraryId empty unless the exact KiCad symbol is confidently known.
11. Footprints are evidence-based only. Do not guess package/footprint from a generic symbol unless printed in the schematic.
12. Preserve design intent over drawing aesthetics. If the visual wire is ambiguous, lower confidence and add a warning rather than inventing a connection.
13. confidence is 0..1. Overall confidence should reflect the weakest important uncertainty, especially unreadable pin numbers or ambiguous crossings.
14. Output JSON only, no markdown, no explanation outside JSON.`;
}

export async function extractSchematicWithGemini({ pdfBase64, apiKey, model, fileName, libraryHints = [], deadlineMs = 50000 }) {
  const stub = process.env.SCHEMATIC_GEMINI_STUB;
  if (stub) {
    if (stub.startsWith('throw:')) throw new Error(stub.slice(6) || 'stubbed schematic extraction failure');
    try { return JSON.parse(stub); } catch (e) { throw new Error(`SCHEMATIC_GEMINI_STUB is invalid JSON: ${e.message}`); }
  }
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  if (!pdfBase64) throw new Error('schematic extractor requires PDF bytes');

  const mdl = model || process.env.SCHEMATIC_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${API_BASE}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = buildSchematicPrompt({ fileName, libraryHints });
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt }
    ] }],
    generationConfig: {
      temperature: 0.05,
      maxOutputTokens: Math.max(8192, Number(process.env.SCHEMATIC_MAX_OUTPUT_TOKENS || 24576)),
      responseMimeType: 'application/json'
    }
  };

  const deadline = Date.now() + Math.max(12000, Number(deadlineMs || 50000));
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 7000) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(remaining - 2000, 50000));
    try {
      const resp = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ac.signal
      });
      const raw = await resp.text();
      if (!resp.ok) {
        const err = new Error(`Gemini schematic API ${resp.status}: ${raw.slice(0, 300)}`);
        if (resp.status !== 429 && resp.status < 500) err.fatal = true;
        throw err;
      }
      const data = JSON.parse(raw);
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('schematic model returned empty content');
      clearTimeout(timer);
      return { raw: repairJSON(text), model: mdl };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error('schematic AI extraction timed out') : e;
      if (e.fatal) break;
      if (attempt < 3) await sleep(800 * (2 ** (attempt - 1)));
    }
  }
  throw lastErr || new Error('schematic AI extraction exceeded time budget');
}
