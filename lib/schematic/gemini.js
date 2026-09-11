// Vision/LLM layer for schematic reconstruction.
// It outputs only logical Connectivity IR candidates. KiCad files are generated deterministically elsewhere.
import { repairJSON } from '../gemini.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildSchematicPrompt({ fileName = '', libraryHints = [], compact = true } = {}) {
  const hints = Array.isArray(libraryHints) && libraryHints.length
    ? `\nKnown ezPLM/KiCad library candidates that may appear in this design:\n${libraryHints.slice(0, 80).join('\n')}`
    : '';
  const compactRule = compact
    ? `\nFAST CONNECTIVITY MODE:\n- Connectivity is more important than descriptive metadata.\n- Keep description/notes/manufacturer/footprint empty unless clearly visible and useful.\n- Use short evidence strings.\n- Do not spend output tokens explaining obvious passive components.\n- Return the complete component/pin/net graph before optional metadata.`
    : '';
  return `You are reconstructing an ELECTRONIC SCHEMATIC from a PDF/image into a structured Connectivity IR.
Do NOT output KiCad text. Do NOT invent electrical connectivity. Follow visible wires, junction dots, net labels, pin labels and reference designators.

Source file: ${fileName || 'uploaded schematic'}${hints}${compactRule}

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
1. Coordinates are normalized to each source page: top-left=(0,0), bottom-right=(1,1). For multi-page PDFs, reconstruct the first actual schematic sheet only in this runtime and report the total pageCount you can see.
2. Every visible component reference (R1, C3, U2, J1, D4, Q1, TP1, etc.) must appear exactly once. Exclude title-block logos and drawing decorations.
3. For R/C/L/fuse/diode/LED/switch two-terminal symbols whose pin numbers are not printed, assign pin 1 to the visually left/top terminal and pin 2 to the right/bottom terminal. Set pin confidence <=0.6 when inferred.
4. For ICs/connectors, copy visible pin numbers and names. If a pin number truly cannot be read, use a unique sequential number but confidence <=0.35 and add a warning. Never silently claim a guessed IC pin mapping is high confidence.
5. Allowed pin types: input, output, bidirectional, power_in, power_out, passive, tri_state, open_collector, no_connect, unspecified. Power rails and grounds are power_in unless clearly outputs.
6. Pin side is one of left/right/top/bottom, referring to the visual side of the symbol in the source image.
7. Connectivity is the most important field. Trace each wire from endpoint to endpoint. A line crossing another line WITHOUT a junction dot is NOT connected. A crossing WITH a junction dot IS connected. Same-name net labels connect electrically even when no continuous line is drawn.
8. Each net endpoint must reference a component ref and a pin NUMBER from that component's pins array. Do not use pin names in endpoint.pin unless the source uses alphanumeric ball/pin designators such as A1.
9. Do not create a net with fewer than two component endpoints. Named power rails may be represented when they join multiple visible endpoints. Never fabricate hidden endpoints merely to keep a power label.
10. Use KiCad official library IDs only when obvious: Device:R, Device:C, Device:C_Polarized, Device:L, Device:D, Device:LED, Device:Fuse, Switch:SW_SPST, Connector_Generic:Conn_01xNN. For ICs, leave libraryId empty unless the exact KiCad symbol is confidently known.
11. Footprints are evidence-based only. Do not guess package/footprint from a generic symbol unless printed in the schematic.
12. Preserve design intent over drawing aesthetics. If the visual wire is ambiguous, lower confidence and add a warning rather than inventing a connection.
13. confidence is 0..1. Overall confidence should reflect the weakest important uncertainty, especially unreadable pin numbers or ambiguous crossings.
14. Protocol labels matter. Preserve exact names such as SDA/SCL, MOSI/MISO/SCK/CS, TX/RX, USB D+/D-/CC1/CC2, SWDIO/SWCLK/NRST and JTAG TCK/TMS/TDI/TDO when visible.
15. Output JSON only, no markdown, no explanation outside JSON.`;
}

function makeTimeoutError(message = 'schematic AI extraction timed out after automatic retry') {
  const e = new Error(message);
  e.status = 504;
  e.code = 'schematic_extraction_timeout';
  return e;
}

function modelPlan(primary) {
  const fallback = String(process.env.SCHEMATIC_FALLBACK_MODEL || '').trim();
  return [...new Set([primary, fallback].filter(Boolean))];
}

function buildRequestBody({ pdfBase64, prompt, maxOutputTokens }) {
  const generationConfig = {
    temperature: 0.02,
    maxOutputTokens,
    responseMimeType: 'application/json'
  };
  const thinkingBudget = Number(process.env.SCHEMATIC_THINKING_BUDGET);
  if (Number.isFinite(thinkingBudget) && thinkingBudget >= 0) {
    generationConfig.thinkingConfig = { thinkingBudget: Math.floor(thinkingBudget) };
  }
  return {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt }
    ] }],
    generationConfig
  };
}

export async function extractSchematicWithGemini({ pdfBase64, apiKey, model, fileName, libraryHints = [], deadlineMs = 140000 }) {
  const stub = process.env.SCHEMATIC_GEMINI_STUB;
  if (stub) {
    if (stub.startsWith('throw:')) throw new Error(stub.slice(6) || 'stubbed schematic extraction failure');
    try { return { raw: JSON.parse(stub), model: 'stub', attempts: 0, elapsedMs: 0 }; }
    catch (e) { throw new Error(`SCHEMATIC_GEMINI_STUB is invalid JSON: ${e.message}`); }
  }
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  if (!pdfBase64) throw new Error('schematic extractor requires PDF bytes');

  const primary = model || process.env.SCHEMATIC_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const models = modelPlan(primary);
  const maxAttempts = Math.max(1, Math.min(3, Number(process.env.SCHEMATIC_AI_ATTEMPTS || 2)));
  const maxOutputTokens = Math.max(6144, Math.min(32768, Number(process.env.SCHEMATIC_MAX_OUTPUT_TOKENS || 12288)));
  const attemptCapMs = Math.max(20000, Math.min(120000, Number(process.env.SCHEMATIC_ATTEMPT_TIMEOUT_MS || 68000)));
  const totalBudgetMs = Math.max(25000, Number(deadlineMs || 140000));
  const started = Date.now();
  const deadline = started + totalBudgetMs;
  const prompt = buildSchematicPrompt({ fileName, libraryHints, compact: process.env.SCHEMATIC_EXTRACTION_DETAIL !== 'full' });
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 6000) break;
    const mdl = models[Math.min(attempt - 1, models.length - 1)] || primary;
    const url = `${API_BASE}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = buildRequestBody({ pdfBase64, prompt, maxOutputTokens });
    const ac = new AbortController();
    const attemptMs = Math.max(5000, Math.min(attemptCapMs, remaining - 2500));
    const timer = setTimeout(() => ac.abort(), attemptMs);
    try {
      const resp = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ac.signal
      });
      const rawText = await resp.text();
      if (!resp.ok) {
        const err = new Error(`Gemini schematic API ${resp.status}: ${rawText.slice(0, 300)}`);
        err.statusCode = resp.status;
        if (resp.status !== 408 && resp.status !== 429 && resp.status < 500) err.fatal = true;
        throw err;
      }
      const data = JSON.parse(rawText);
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('schematic model returned empty content');
      const parsed = repairJSON(text);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.components) || !Array.isArray(parsed.nets)) {
        throw new Error('schematic model returned incomplete Connectivity IR JSON');
      }
      clearTimeout(timer);
      return { raw: parsed, model: mdl, attempts: attempt, elapsedMs: Date.now() - started };
    } catch (e) {
      clearTimeout(timer);
      if (e?.name === 'AbortError') lastErr = makeTimeoutError(`schematic AI extraction attempt ${attempt} timed out after ${attemptMs}ms`);
      else lastErr = e;
      if (e?.fatal) break;
      if (attempt < maxAttempts && deadline - Date.now() > 7000) await sleep(Math.min(1200, 350 * attempt));
    }
  }

  if (lastErr?.code === 'schematic_extraction_timeout') {
    lastErr.message = `schematic AI extraction timed out after ${maxAttempts} attempt(s); total budget ${totalBudgetMs}ms`;
    throw lastErr;
  }
  if (Date.now() >= deadline - 1000) throw makeTimeoutError(`schematic AI extraction exceeded ${totalBudgetMs}ms total budget`);
  throw lastErr || makeTimeoutError('schematic AI extraction exceeded time budget');
}
