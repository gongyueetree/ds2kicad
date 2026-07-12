// lib/heuristics.js — 确定性提取器（零 AI）。
// 输入 lib/pdftext.js 的行结构，输出：器件信息 / 管脚表(带置信度) / 图区定位 / Gemini 相关页选择。
// 原则：解析器只认得高置信模式；模式不匹配就降置信，让上层回退 Gemini —— 宁可少提取，绝不猜。

const TYPE_MAP = {
  'I': 'input', 'O': 'output', 'I/O': 'bidirectional', 'IO': 'bidirectional',
  'P': 'power_in', 'PWR': 'power_in', 'G': 'power_in', 'GND': 'power_in',
  'NC': 'no_connect', '-': 'passive', '—': 'passive', '–': 'passive'
};

const NAME_RE = '[A-Za-z][\\w+#/.\\-]{0,15}';

/** 型号：优先 URL 文件名（ti symlink 惯例），回退首页顶部全大写 token */
export function findPartInfo(pages, pdfUrl = '') {
  let mpn = '';
  const m = /([A-Za-z][A-Za-z0-9\-]{4,})\.pdf/i.exec(pdfUrl || '');
  if (m) mpn = m[1].toUpperCase();
  const p1 = pages[0];
  let title = '', manufacturer = '';
  if (p1) {
    const top = p1.lines.filter((l) => l.y > p1.height * 0.55);
    if (!mpn) {
      const cand = top.find((l) => /^[A-Z]{2,}[A-Z0-9\-]{3,}(\s*,\s*[A-Z0-9\-]+)*$/.test(l.text));
      if (cand) mpn = cand.text.split(/[\s,]+/)[0];
    }
    // 标题：首页较长的描述行（含器件类别词），排除法务/页眉
    const tl = top.find((l) => l.text.length > 25 && l.text.length < 160 &&
      /(multiplexer|switch|amplifier|regulator|converter|controller|driver|sensor|transceiver|comparator|MOSFET|microcontroller|translator|monitor)/i.test(l.text));
    if (tl) title = tl.text;
    const allTxt = p1.lines.map((l) => l.text).join(' ');
    const mm = /(Texas Instruments|Analog Devices|STMicroelectronics|NXP|Infineon|onsemi|ON Semiconductor|Microchip|Renesas|Toshiba|ROHM|Diodes Incorporated|Nexperia|Vishay|Silicon Labs|Skyworks|Qorvo|TDK|Murata)/i.exec(allTxt);
    if (mm) manufacturer = mm[1];
  }
  const ok = !!mpn;
  return { ok, part: { mpn, manufacturer, title, description_zh: '' } };
}

/** 管脚表解析（支持多封装编号列）：
 *  单列：  (NAME NO TYPE DESC) 或 (NO NAME TYPE DESC)
 *  多列：  NAME | 编号列1 | 编号列2 | I/O | DESC（TI 常见：NAME  D,P,PW  DSBGA  I/O  DESC）
 *  返回 { pinsets:[{id,label,pins}], confidence }；多列时列头 token 作为 pinset label 供封装归属。
 */
export function parsePinTable(pages) {
  const LOC = '(?:\\d{1,3}|[A-J]\\d{1,2})'; // 数字编号或 BGA 球号
  const TY = '(I/O|IO|I|O|P|PWR|G|GND|NC|[-—–])';
  const rowRe1A = new RegExp(`^(${NAME_RE})\\s+(\\d{1,3})\\s+${TY}\\s*(.*)$`);
  const rowRe1B = new RegExp(`^(\\d{1,3})\\s+(${NAME_RE})\\s+${TY}\\s*(.*)$`);
  const rowRe2 = new RegExp(`^(${NAME_RE})\\s+(${LOC})\\s+(${LOC})\\s+${TY}\\s*(.*)$`);
  const epRe = new RegExp(`^(${NAME_RE})?\\s*(?:Thermal\\s+)?[Pp]ad\\b.*|^EP\\b.*`);
  const stop = /^\d+(\.\d+)*\s+(Specifications|Detailed Description|Application|Parameter Measurement|Absolute Maximum)/i;
  const headRe = /^(\d+(\.\d+)*\s+)?Pin (Configuration and )?Functions?\b/i;
  const colHeadRe = /\bPIN\b|\bNAME\b/;

  const setA = new Map(), setB = new Map(); // 列1 / 列2
  let labels = ['', ''];
  let headerSeen = false, twoCol = false;

  for (const pg of pages) {
    for (const ln of pg.lines) {
      const t = ln.text;
      if (!headerSeen) {
        if (headRe.test(t) || (/\bPIN\b/.test(t) && /\b(DESCRIPTION|FUNCTION)\b/i.test(t))) headerSeen = true;
        continue;
      }
      if (stop.test(t)) { headerSeen = false; continue; }
      // 列头行：捕获两个编号列的封装代码标签，如 "NAME  D, P, PW  DSBGA  I/O  DESCRIPTION"
      if (colHeadRe.test(t) && /I\/O|TYPE/i.test(t)) {
        const m = /NAME\s+(.+?)\s{2,}(.+?)\s{2,}(?:I\/O|TYPE)/i.exec(t);
        if (m) { labels = [m[1].trim(), m[2].trim()]; }
        continue;
      }
      const m2 = rowRe2.exec(t);
      if (m2 && !/^\d+$/.test(m2[1])) {
        twoCol = true;
        addRow(setA, m2[2], m2[1], m2[4], m2[5]);
        addRow(setB, m2[3], m2[1], m2[4], m2[5]);
        continue;
      }
      let mA = rowRe1A.exec(t), mB = rowRe1B.exec(t);
      if (mA && /^\d+$/.test(mA[1])) mA = null;
      const m1 = mA || mB;
      if (m1) {
        const [name, num] = mA ? [m1[1], m1[2]] : [m1[2], m1[1]];
        addRow(setA, num, name, m1[3], m1[4]);
      } else if (epRe.test(t) && setA.size >= 4) {
        const nums = [...setA.keys()].filter((k) => /^\d+$/.test(k)).map(Number);
        const epNum = String((nums.length ? Math.max(...nums) : setA.size) + 1);
        if (!setA.has(epNum)) setA.set(epNum, { number: epNum, name: 'EP', type: 'passive', description: 'Exposed thermal pad' });
      }
    }
  }

  const toPins = (map) => [...map.values()].sort(cmpPinNum);
  const pinsets = [];
  const pA = toPins(setA);
  if (pA.length) pinsets.push({ id: 'default', label: twoCol ? labels[0] : '', pins: pA });
  if (twoCol) {
    const pB = toPins(setB);
    if (pB.length) pinsets.push({ id: 'alt1', label: labels[1], pins: pB });
  }

  // 置信度：主集行数≥4、（数字编号时）从 1 起连续覆盖≥80%
  const nums = pA.filter((p) => /^\d+$/.test(p.number)).map((p) => +p.number);
  const max = nums.length ? Math.max(...nums) : 0;
  const coverage = max ? nums.length / max : 0;
  let confidence = pA.length >= 4 && max >= 6 && coverage >= 0.8 && Math.min(...nums) === 1 ? 'high' : 'low';
  // 多列但没解析出列头标签 → 无法归属封装，降置信交 AI
  if (twoCol && (!labels[0] || !labels[1])) confidence = 'low';
  return { pinsets, pins: pA, confidence, coverage: +coverage.toFixed(2), multiColumn: twoCol };
}

function addRow(map, num, name, ty, desc) {
  if (map.has(num)) return;
  const T = (ty || '').toUpperCase();
  map.set(num, {
    number: num,
    name,
    type: /^(GND|VSS)/i.test(name) || /^(VCC|VDD|V\+)/i.test(name)
      ? 'power_in'
      : (TYPE_MAP[T] || 'unspecified'),
    description: (desc || '').trim().slice(0, 160)
  });
}

function cmpPinNum(a, b) {
  const na = +a.number, nb = +b.number;
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a.number).localeCompare(String(b.number), 'en', { numeric: true });
}

/** pinset 归属：列头 token（如 "D, P, PW" / "DSBGA"）与封装 tiCode/type/name 的 token 精确匹配；未命中回退 default */
export function assignPinsets(packages, pinsets) {
  if (!pinsets.length) return packages;
  const tokenSets = pinsets.map((ps) => ps.label.toUpperCase().split(/[\s,/]+/).filter(Boolean));
  return packages.map((pkg) => {
    const keyTokens = new Set(
      [pkg.tiCode, pkg.type, pkg.name]
        .flatMap((s) => String(s || '').toUpperCase().split(/[^A-Z0-9]+/))
        .filter(Boolean)
    );
    let id = pinsets[0].id;
    for (let i = 0; i < pinsets.length; i++) {
      if (tokenSets[i].some((tok) => keyTokens.has(tok))) { id = pinsets[i].id; break; }
    }
    return { ...pkg, pinsetId: id };
  });
}

const FIG_KINDS = [
  { kind: 'block_diagram', re: /(functional|internal|simplified)?\s*block\s+diagram/i },
  { kind: 'application', re: /(typical\s+application|application\s+(circuit|schematic|diagram)|simplified\s+(schematic|application))/i },
  { kind: 'pin_configuration', re: /top\s+view|pin\s+(configuration|connections?|assignment)\s*(diagram)?\b(?!\s+and\s+functions)/i }
];

/** 图区定位：以 “Figure N. <标题>” 说明行为锚（图在其上方），或独立章节标题为锚（图在其下方） */
export function findFigures(pages) {
  const out = [];
  const mL = 0.06, mR = 0.94; // 页面左右边距（归一化）
  for (const pg of pages) {
    const H = pg.height;
    const sorted = [...pg.lines].sort((a, b) => b.y - a.y); // 自上而下
    for (let i = 0; i < sorted.length; i++) {
      const l = sorted[i];
      const cap = /^Figure\s+(\d+(?:[-.]\d+)*)[.:]?\s+(.*)$/i.exec(l.text);
      const matchKind = (s) => FIG_KINDS.find((k) => k.re.test(s))?.kind;
      if (cap) {
        let kind = matchKind(cap[2]);
        // 曲线/波形类说明行（如 "Application Curves"、"Gain vs Frequency"）不是电路图
        if (kind && /\b(curve|curves|waveform|response|characteristic|performance|graph|plot|vs\.?|versus)\b/i.test(cap[2])) kind = null;
        if (!kind) continue;
        // 图在说明行上方：上界=上一条“实质文本行”（长句/章节标题）之下，找不到则向上取 45% 页高
        let topY = Math.min(H * 0.94, l.y + H * 0.45);
        for (let j = i - 1; j >= 0; j--) {
          const t = sorted[j];
          if (t.y - l.y > H * 0.5) break;
          const substantial = t.text.length > 60 || /^\d+(\.\d+)*\s+[A-Z]/.test(t.text) || /^Figure\s+\d+/i.test(t.text);
          if (substantial) { topY = t.y - t.h * 1.2; break; }
        }
        const botY = l.y - l.h * 1.6; // 含说明行
        pushFig(out, kind, cap[2].trim(), pg.page, [mL, 1 - topY / H, mR, Math.min(0.98, 1 - botY / H)]);
      } else {
        // 无 Figure 编号的独立标题（如首页 Simplified Schematic / 章节 Functional Block Diagram）
        let kind = l.text.length < 60 && !/\b(see|shown|refer)\b/i.test(l.text) ? matchKind(l.text) : null;
        // 独立标题（无 Figure 编号）误报率高：只认 block diagram / simplified schematic 两类明确标题；
        // "Pin Configuration" 是管脚表章节名、泛化的 "Typical Application" 是章节名，都不算图
        if (kind === 'pin_configuration') kind = null;
        if (kind === 'application' && !/simplified\s+schematic/i.test(l.text)) kind = null;
        if (!kind) continue;
        // 图在标题下方：下界=下一条实质文本行之上，找不到则向下取 45% 页高
        let botY = Math.max(H * 0.06, l.y - H * 0.45);
        for (let j = i + 1; j < sorted.length; j++) {
          const t = sorted[j];
          if (l.y - t.y > H * 0.5) break;
          if (t.text.length > 60 || /^\d+(\.\d+)*\s+[A-Z]/.test(t.text)) { botY = t.y + t.h * 0.6; break; }
        }
        pushFig(out, kind, l.text, pg.page, [mL, 1 - (l.y - l.h * 0.4) / H, mR, Math.min(0.98, 1 - botY / H)]);
      }
    }
  }
  // 排序去冗：功能框图 1 个 → 管脚排布图（每封装一张，上限由调用方按封装数收窄）→ 重要应用示例 2-3 个
  const blocks = out.filter((f) => f.kind === 'block_diagram').slice(0, 1);
  const pincfg = out.filter((f) => f.kind === 'pin_configuration').slice(0, 8);
  const apps = out.filter((f) => f.kind === 'application').slice(0, 3);
  return [...blocks, ...pincfg, ...apps];
}

function pushFig(arr, kind, title, page, bbox) {
  const [x0, y0, x1, y1] = bbox.map((v) => Math.min(0.98, Math.max(0.02, +v.toFixed(4))));
  if (y1 - y0 < 0.04) return; // 区域过小视为定位失败
  if (arr.some((f) => f.page === page && f.kind === kind && Math.abs(f.bbox[1] - y0) < 0.05)) return;
  arr.push({ kind, title: title.slice(0, 80), page, bbox: [x0, y0, x1, y1] });
}

/** 供 Gemini 的相关页选择：首页 + 管脚表页 + 机械图/封装页 + 图区页（去重升序） */
export function selectRelevantPages(pages, figures = []) {
  const keep = new Set([1]);
  for (const pg of pages) {
    const txt = pg.lines.map((l) => l.text).join('\n');
    if (/Pin (Configuration and )?Functions?/i.test(txt) || (/\bPIN\b/.test(txt) && /\bDESCRIPTION\b/i.test(txt))) keep.add(pg.page);
    if (/(PACKAGE OUTLINE|MECHANICAL DATA|PACKAGE OPTION ADDENDUM|LAND PATTERN|PLASTIC QUAD|SMALL OUTLINE)/i.test(txt)) keep.add(pg.page);
    if (/(Package Information|Mechanical, Packaging)/i.test(txt)) keep.add(pg.page);
  }
  for (const f of figures) keep.add(f.page);
  return [...keep].sort((a, b) => a - b);
}
