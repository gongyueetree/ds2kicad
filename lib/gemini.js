// lib/gemini.js — Gemini 调用层。AI 只负责“语义提取”：管脚表、封装候选参数、图区定位。
// 所有几何/数学由 lib/kicadgen 的确定性引擎完成，AI 结果一律经 validate.js 清洗 + 用户确认。

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const EXTRACT_PROMPT = `You are an electronics component librarian. Read the attached component datasheet PDF and extract structured data for EDA library generation. Respond with ONLY a JSON object (no markdown fences, no commentary) matching exactly this schema:

{
  "part": {
    "mpn": "base part number, e.g. TMUXL27518",
    "manufacturer": "e.g. Texas Instruments",
    "title": "one-line English title from the first page",
    "description_zh": "一句中文功能描述"
  },
  "packages": [
    {
      "name": "human name e.g. WQFN-24",
      "tiCode": "vendor package code e.g. RSM (empty string if none)",
      "type": "package type string e.g. WQFN / TSSOP / SOIC / PDIP / SOT-23",
      "pinCount": 24,
      "pitch": 0.5,
      "bodyLength": 4.0,
      "bodyWidth": 4.0,
      "height": 0.8,
      "leadSpan": 4.0,
      "leadLength": 0.4,
      "leadWidth": 0.25,
      "epLength": 2.6,
      "epWidth": 2.6
    }
  ],
  "recommendedPackageIndex": 0,
  "pins": [
    { "number": "1", "name": "NO1", "type": "passive", "description": "Normally open source pin 1" }
  ],
  "figures": [
    { "kind": "block_diagram", "title": "Functional Block Diagram", "page": 1, "bbox": [0.15, 0.30, 0.85, 0.75] },
    { "kind": "application", "title": "Typical Application", "page": 1, "bbox": [0.1, 0.1, 0.9, 0.5] }
  ]
}

STRICT RULES:
1. "pins" MUST be copied verbatim from the Pin Configuration and Functions table of the recommended package. Every physical pin (including exposed pad, listed as e.g. number "25" or "EP") must appear exactly once. Never invent pin names.
2. "type" for each pin must be one of: input, output, bidirectional, power_in, power_out, passive, tri_state, open_collector, no_connect, unspecified. Analog switch channel pins (source/drain/COM/NO/NC) are "passive". Logic control/select/enable/address pins are "input". Supply pins (VDD/VCC) are "power_in"; GND is "power_in". Exposed thermal pad is "passive".
3. Package dimensions come from the Mechanical/Package outline drawing at the end of the datasheet, in millimeters, using NOMINAL (typical) values. "bodyLength" is the dimension along the pin rows; "leadSpan" is the lead-tip-to-lead-tip overall span for gull-wing packages (equals body size for QFN). If a value is not explicitly printed in this datasheet, output null. NEVER estimate or substitute a JEDEC/typical/industry-standard value.
4. "figures": locate (a) the functional/internal block diagram, and (b) 1 to 3 typical application / simplified schematic figures. "page" is the 1-based PDF page number. "bbox" is [x0, y0, x1, y1] normalized to page width/height with origin at TOP-LEFT, generously enclosing the whole figure INCLUDING its caption. Precision matters less than full coverage — expand by ~3% margin on all sides.
5. All numbers must be plain JSON numbers in millimeters. Output must be valid JSON. Do not truncate.`;

/**
 * 按需拼装提示词：程序化解析已高置信拿到的字段不再让 AI 输出。
 * need = { part, packages, pins, figures }（布尔）；hints 注入已确定的事实（如 mpn）。
 */
export function buildPrompt(need, hints = {}) {
  const schema = [];
  const rules = [];
  if (need.part) {
    schema.push(`"part": { "mpn": "base part number", "manufacturer": "...", "title": "one-line English title", "description_zh": "一句中文功能描述" }`);
  }
  if (need.packages) {
    schema.push(`"packages": [ { "name": <string>, "tiCode": <string|null>, "type": <string>, "drawingId": <string|null>, "pinsetId": "default", "pinCount": <int|null>, "pitch": <mm|null>, "bodyLength": <mm|null>, "bodyWidth": <mm|null>, "height": <mm|null>, "leadSpan": <mm|null>, "leadLength": <mm|null>, "leadWidth": <mm|null>, "epLength": <mm|null>, "epWidth": <mm|null>, "landPattern": { "padW": <mm|null>, "padL": <mm|null>, "rowSpan": <mm|null>, "holeDia": <mm|null>, "sourcePage": <int|null> } , "orderableParts": [<string>], "sourcePages": [<int>], "notes": [] } ],
  "recommendedPackageIndex": 0`);
    rules.push(`APPLICABILITY FILTER (critical for combined family datasheets): include ONLY packages in which the requested part number itself is orderable, per the Package Option Addendum / device comparison table. EXCLUDE packages that exist only for sibling family members (e.g. for LM358 exclude CDIP/LCCC that only apply to LM158, and DDF that only applies to LM358B). List the orderable part numbers for each package in "orderableParts". If applicability is uncertain, include the package but state the uncertainty in "notes".`);
    rules.push(`Package dimensions come from the Mechanical/Package outline drawing, in millimeters, NOMINAL values. "bodyLength" is along the pin rows; "leadSpan" is lead-tip-to-lead-tip (equals body size for QFN). "drawingId" is the vendor mechanical drawing code (e.g. D0008A). "sourcePages" are the 1-based PDF pages of that package's outline/land-pattern drawings.`);
    rules.push(`"landPattern" is the RECOMMENDED LAND PATTERN from the datasheet appendix (preferred over anything derived): "padW" = pad width along the pin row, "padL" = pad length perpendicular to the row, "rowSpan" = inner-edge-to-inner-edge spacing between the two pad rows (for through-hole: hole-center-to-center, and set "holeDia"), "sourcePage" = the PDF page of the land pattern example. Set landPattern to null if the datasheet does not include one for that package.`);
    rules.push(`"pinsetId" on each package references an entry in "pinsets" (see below). Packages sharing identical pin numbering share the same pinsetId.`);
  }
  if (need.pins) {
    schema.push(`"pinsets": [ { "id": "default", "label": "D, P, PW", "pins": [ { "number": "1", "name": "OUT1", "type": "output", "description": "..." } ] } ]`);
    rules.push(`"pinsets": one entry per DISTINCT pin numbering scheme in the datasheet. Most datasheets have exactly one (id "default"). If some package (e.g. a DSBGA/BGA variant, or a metal-can variant) has different pin numbers or names, it gets its own pinset with the ball/pin designators from ITS pin table (e.g. number "A1"). "label" is the package-code column header from the pin table (e.g. "D, P, PW"). Pins MUST be copied verbatim from the Pin Configuration and Functions table — every physical pin (including exposed pad) exactly once per pinset, ONE ENTRY PER PIN NUMBER: if the table merges several pins into one row (e.g. "1, 4, 9  GND"), you must expand it into separate entries {"number":"1"}, {"number":"4"}, {"number":"9"} sharing the same name/type/description. The exposed pad row (EPAD/EP/PAD) gets number = highest pin number + 1 (e.g. "17" for a 16-pin LFCSP). Never invent pin names. "type" is one of: input, output, bidirectional, power_in, power_out, passive, tri_state, open_collector, no_connect, unspecified. Analog switch channel pins are "passive"; logic control pins are "input"; VCC/VDD/GND are "power_in"; exposed pad is "passive".`);
  }
  if (need.figures) {
    schema.push(`"figures": [ { "kind": "block_diagram" | "pin_configuration" | "application", "title": "...", "page": 1, "bbox": [0.15, 0.30, 0.85, 0.75] } ]`);
    rules.push(`"figures": ONLY include figures whose printed caption/title text literally contains these keywords — (a) "Block Diagram" (functional/internal/simplified variants OK): exactly 1; (b) "(Top View)" or "Pin Configuration" package drawings (kind "pin_configuration"): one per package variant; (c) "Typical Application" / "Application Circuit" / "Simplified Schematic": at most 2, the most representative ones. Chinese-language datasheets use equivalent caption keywords which count as matches: 框图/功能框图/内部框图 = Block Diagram; 典型应用/应用电路/应用示例/简化原理图 = Typical Application; 引脚配置/引脚排列/顶视图 = Pin Configuration (Top View); caption prefix may be "图 N-M." instead of "Figure N-M.". STRICTLY EXCLUDE performance curves, waveforms, "Application Curves"/曲线/波形/特性, frequency-response plots, X-vs-Y graphs, tables, and any figure that merely looks like an image — keyword match on the caption is the ONLY criterion. Copy the caption verbatim into "title". "page" is 1-based. "bbox" is [x0,y0,x1,y1] normalized, origin TOP-LEFT, enclosing the figure INCLUDING caption (+3% margin).`);
  }
  const hintLines = [];
  if (hints.mpn) hintLines.push(`The part number is ${hints.mpn}.`);
  if (hints.pinCount) hintLines.push(`The pin table has ${hints.pinCount} entries; package "pinCount" must be consistent with it.`);
  if (hints.note) hintLines.push(hints.note);
  return `You are an electronics component librarian. Read the attached component datasheet PDF and extract structured data for EDA library generation. ${hintLines.join(' ')}
Respond with ONLY a JSON object (no markdown fences, no commentary) with exactly these keys:

{
  ${schema.join(',\n  ')}
}

STRICT RULES:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${rules.length + 1}. All numbers are plain JSON numbers in millimeters. Output must be valid JSON. Do not truncate.`;
}

/** 模式修复式 JSON 解析：剥离围栏 → 截取首个 { → 补齐未闭合括号/引号 */
export function repairJSON(text) {
  if (!text) throw new Error('empty response');
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  s = s.slice(start);
  try { return JSON.parse(s); } catch { /* fallthrough to repair */ }

  // 逐字符扫描：跟踪字符串/转义状态。若在字符串中被截断，先就地闭合字符串；
  // 否则回退到最后一个完整值处截断，再补齐未闭合括号、处理悬空冒号/逗号。
  let inStr = false, esc = false, lastGood = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') { inStr = false; lastGood = i + 1; }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '}' || c === ']') lastGood = i + 1;
    else if (c === ',' || /\s/.test(c)) { /* 不推进 lastGood */ }
    else lastGood = i + 1;
  }
  let t = inStr
    ? (esc ? s.slice(0, s.length - 1) : s) + '"'   // 截断在转义符上则丢弃半个转义
    : s.slice(0, lastGood);
  t = t.replace(/,\s*$/, '');
  if (/:\s*$/.test(t)) t += 'null';                 // 悬空冒号 → 补 null
  // 补齐未闭合括号
  const st2 = [];
  let in2 = false, e2 = false;
  for (const c of t) {
    if (in2) { if (e2) e2 = false; else if (c === '\\') e2 = true; else if (c === '"') in2 = false; continue; }
    if (c === '"') in2 = true;
    else if (c === '{' || c === '[') st2.push(c);
    else if (c === '}' || c === ']') st2.pop();
  }
  while (st2.length) t += st2.pop() === '{' ? '}' : ']';
  return JSON.parse(t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用 Gemini 提取数据手册。pdfBase64 为 PDF 的 base64 编码。
 * 3 次重试 + 指数退避；maxOutputTokens 给足以防截断（既往教训）。
 */
export async function extractWithGemini({ pdfBase64, apiKey, model, sourceUrl, need, hints, deadlineMs }) {
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;
  const mdl = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${API_BASE}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = need
    ? buildPrompt(need, hints)
    : EXTRACT_PROMPT; // 兼容旧调用：不传 need 则全量提取
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: prompt + (sourceUrl ? `\n\nDatasheet source URL: ${sourceUrl}` : '') }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json'
    }
  };

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 时间预算：余量 <8s 不再发起新尝试，直接抛出（让上层给出结构化错误而非平台 504）
    const remaining = deadline ? deadline - Date.now() : Infinity;
    if (remaining < 8000) {
      throw lastErr || new Error(`AI 提取时间预算耗尽（剩余 ${Math.max(0, Math.round(remaining / 1000))}s）`);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(remaining - 3000, 45000));
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      const raw = await resp.text();
      if (!resp.ok) {
        // 4xx（除 429）不重试
        if (resp.status !== 429 && resp.status < 500) {
          throw Object.assign(new Error(`Gemini API ${resp.status}: ${raw.slice(0, 300)}`), { fatal: true });
        }
        throw new Error(`Gemini API ${resp.status}`);
      }
      const data = JSON.parse(raw);
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '').join('');
      if (!text) throw new Error('Gemini 返回内容为空（可能被安全策略拦截）');
      clearTimeout(timer);
      return repairJSON(text);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError'
        ? new Error('Gemini 单次调用超时，PDF 可能过大或网络缓慢')
        : e;
      if (e.fatal) break;
      if (attempt < 3) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
