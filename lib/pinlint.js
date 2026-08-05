// lib/pinlint.js — 管脚名规则校验（DSK-005 / DSK-006）
//
// 定位：AI 负责读出管脚名，本模块负责用**确定性规则**挑出它读错或读丢的地方。
//
// 原则：只自动修正在字面上不可能有歧义的 OCR 混淆（字母 O 被认成数字 0，且
// 修正后是一个真实存在的信号名前缀）；其余一律**只标记不改写** —— 我们无法
// 从字面判断 `NC1/Vpp2` 里的 1 和 2 是脚注还是编号，也无法判断两个同名
// `SUSPEND` 里哪一个才该带低有效标记。猜错比不猜更危险。
//
// 每条命中都写入 transformationLog 并置 reviewRequired，下游晋升闸门据此阻断。

/** 字母 O 被 OCR 成数字 0 的确定性修正表：键为错误 token，值为正确 token。
 *  只收录"修正后必然是标准信号名"的条目，且要求整词或带纯数字后缀匹配。 */
const O_ZERO_FIX = {
  GPI0: 'GPIO', '0UT': 'OUT', V0UT: 'VOUT', A0UT: 'AOUT', D0UT: 'DOUT',
  '0SC': 'OSC', X0SC: 'XOSC', C0M: 'COM', C0MP: 'COMP', '0E': 'OE',
  P0RT: 'PORT', C0NF: 'CONF', M0SI: 'MOSI', M0DE: 'MODE', C0L: 'COL'
};

/** 曝光焊盘别名 —— 名称语义常与手册不符（手册多标 GND，提取常给 EP/EPAD） */
const EP_NAME = /^(EP|EPAD|PAD|THERMAL(_?PAD)?|DAP|TAB)$/i;

/** 低有效标记：上划线、前缀 n/N、后缀 _N / # / 斜杠 */
const ACTIVE_LOW = /^[~\/#]|[~#]$|^n(?=[A-Z])|_N$|\bB$/;

/**
 * @param {Array} pins sanitizePinsDetailed 产出的管脚数组（会被就地修改 name）
 * @returns {{issues: Array, fixed: number}}
 */
export function lintPinNames(pins) {
  const issues = [];
  const list = Array.isArray(pins) ? pins : [];
  let fixed = 0;

  // ── 1. OCR 字母/数字混淆：唯一允许自动修正的一类 ──
  for (const p of list) {
    const before = String(p.name || '');
    const after = fixOZero(before);
    if (after !== before) {
      p.name = after;
      fixed++;
      issues.push({ op: 'pin_name_ocr_corrected', number: p.number, from: before, to: after, rule: 'letter_O_read_as_zero' });
    }
  }

  // ── 2. 重名：低有效标记丢失的典型表现（CP2102 的 11/12 脚均为 SUSPEND）──
  const byName = new Map();
  for (const p of list) {
    const k = String(p.name || '').toUpperCase();
    if (!k || k === 'NC' || k === 'DNC' || isPowerRail(k)) continue;   // 电源/地/NC 天然可重复
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p.number);
  }
  for (const [name, numbers] of byName) {
    if (numbers.length < 2) continue;
    issues.push({
      op: 'duplicate_pin_name', name, numbers,
      reason: ACTIVE_LOW.test(name) ? 'duplicate_with_active_low_marker' : 'possible_lost_active_low_marker',
      hint: '手册中这些管脚通常有一个带低有效标记（上划线 / 前缀 n / 后缀 #），提取时可能丢失，请人工核对'
    });
  }

  // ── 3. 脚注上标混入名称：只检测不改写 ──
  for (const p of list) {
    const n = String(p.name || '');
    if (looksLikeFootnote(n)) {
      issues.push({
        op: 'possible_footnote_in_pin_name', number: p.number, name: n,
        hint: '名称末尾的数字可能是手册脚注上标而非信号编号，请对照手册确认'
      });
    }
  }

  // ── 4. 曝光焊盘语义：手册常标 GND，提取常给 EP ──
  for (const p of list) {
    if (EP_NAME.test(String(p.name || ''))) {
      issues.push({
        op: 'exposed_pad_name_unverified', number: p.number, name: p.name,
        hint: '曝光焊盘的手册标称常为 GND 或具体电位，请确认是否应改名并连接到对应网络'
      });
    }
  }

  return { issues, fixed };
}

/** 仅当"词 + 纯数字后缀"命中修正表时才改写。
 *  注意必须从**最长的词**开始试：`GPI046` 的正确切分是 `GPI0` + `46`，
 *  若按最短切分会得到 `GPI` + `046`，修正表命不中。 */
export function fixOZero(name) {
  const s = String(name || '');
  if (!s) return s;
  // 逐个 / 分隔的子名单独处理（如 "GPI046/XTAL"）
  return s.split('/').map((raw) => {
    const seg = raw.trim();
    if (!/^[A-Za-z0-9]+$/.test(seg)) return raw;
    for (let cut = seg.length; cut >= 2; cut--) {
      const word = seg.slice(0, cut);
      const rest = seg.slice(cut);
      if (rest && !/^\d+$/.test(rest)) continue;
      const hit = O_ZERO_FIX[word.toUpperCase()];
      if (hit) return hit + rest;
    }
    return raw;
  }).join('/');
}

function isPowerRail(k) {
  return /^(V(DD|SS|CC|EE|BAT|IN|OUT|REF|DDIO|DDA)|GND|AGND|DGND|PGND|VBUS|\+?\d*V\d*)$/i.test(k);
}

/** `NC1/Vpp2` 这类：斜杠两侧都以孤立数字结尾，很像脚注上标被并进了名称 */
export function looksLikeFootnote(name) {
  const s = String(name || '').trim();
  if (!s.includes('/')) return false;
  const segs = s.split('/').map((x) => x.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  const endsWithLoneDigit = (x) => /^[A-Za-z]{2,}[1-9]$/.test(x);
  return segs.filter(endsWithLoneDigit).length >= 2;
}
