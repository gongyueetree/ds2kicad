// lib/kicadgen/geometry.js — 确定性几何校验层。
// AI 提取的封装尺寸在进入焊盘/3D 引擎前必须通过本层：
//   1. 方向纠正：dual/dip 的 bodyLength（沿引脚排布）必须容得下引脚行，颠倒则交换
//   2. 派生兜底：尺寸缺失或明显失真时按 pinCount×pitch 派生并告警
//   3. 关系约束：leadSpan>bodyWidth（鸥翼）、EP<本体、QFN 每边引脚放得下
// 原则：宁可用可证明自洽的派生值 + 告警，也不让失真尺寸生成废封装。

const f1 = (n) => Number(n.toFixed(2));

// JEDEC/行业标准公称尺寸先验（确定性兜底）：AI 提取值偏离先验 [0.55x, 1.7x] 区间即替换并告警。
// bodyLength 与引脚数相关的封装（SOIC/TSSOP/…）不设长度先验，由后续关系校验派生。
const PKG_PRIORS = [
  { re: /SC[- ]?70|SOT[- ]?353|SOT[- ]?363/i, pitch: 0.65, bodyLength: 2.0, bodyWidth: 1.25, leadSpan: 2.1, height: 1.1 },
  { re: /TSOT[- ]?23|SOT[- ]?23[- ]?[56]/i, pitch: 0.95, bodyLength: 2.9, bodyWidth: 1.6, leadSpan: 2.8, height: 1.45 },
  { re: /SOT[- ]?23(?![-\d])/i, pitch: 0.95, bodyLength: 2.9, bodyWidth: 1.3, leadSpan: 2.4, height: 1.12 },
  { re: /\bMSOP|VSSOP/i, pitch: 0.65, bodyWidth: 3.0, leadSpan: 4.9, height: 1.1 },
  { re: /\bTSSOP/i, pitch: 0.65, bodyWidth: 4.4, leadSpan: 6.4, height: 1.2 },
  { re: /\bSSOP/i, pitch: 0.65, bodyWidth: 5.3, leadSpan: 7.8, height: 2.0 },
  { re: /\bSOIC|\bSO[- ]?8\b|\bSOP\b/i, pitch: 1.27, bodyWidth: 3.9, leadSpan: 6.0, height: 1.75 }
];

// 各字段相对 JEDEC 公称值的允许偏差。height 放宽 —— 同封装常有薄型变体（如 SOT-23 vs TSOT-23）。
const TOLERANCE = { pitch: 0.15, bodyLength: 0.30, bodyWidth: 0.30, leadSpan: 0.30, height: 0.55 };

function applyPriors(p, warn, rec = () => {}) {
  if (p.family !== 'dual' && p.family !== 'sot23') return;
  const key = `${p.type || ''} ${p.name || ''}`;
  const prior = PKG_PRIORS.find((e) => e.re.test(key));
  if (!prior) return;
  const fixed = [];
  for (const k of ['pitch', 'bodyLength', 'bodyWidth', 'leadSpan', 'height']) {
    if (prior[k] === undefined) continue;
    const v = Number(p[k]);
    // DSK-015：容差 ±70% 太松。SOT23-5 的 bodyLength 先验 2.9mm，AI 给 4.9mm（+69%）
    // 恰好卡在 prior*1.7=4.93 之下溜过，导致符号/封装/3D 全部按 4.9mm 生成，比例失真。
    // JEDEC 公称尺寸的实际公差在 ±5% 量级，这里取 ±30% 已足够宽松，
    // 既能容纳同族变体（如 SOT-23-5 vs TSOT-23-5 的 height 差异）又能挡住量级错误。
    const tol = TOLERANCE[k] ?? 0.30;
    if (!v || v < prior[k] * (1 - tol) || v > prior[k] * (1 + tol)) {
      fixed.push(`${k} ${v || '缺失'}→${prior[k]}`);
      rec('jedec_prior_substitution', { field: k, from: v || null, to: prior[k], reason: 'value_outside_standard_nominal_range' });
      p[k] = prior[k];
    }
  }
  if (fixed.length) warn(`${p.name}: 尺寸偏离该封装类型的标准公称值，已按 JEDEC 先验替换（${fixed.join('，')}），请对照机械图复核`);
}

/** item 7：返回 { normalizedPackage, transformations }。每次交换/推导/收缩/先验替换
 *  都产生结构化记录（op/field/from/to/reason），全部阻断晋升。 */
export function normalizeGeometryDetailed(pkg) {
  const transformations = [];
  const warnings = [];
  const rec = (op, detail) => { transformations.push({ op, ...detail }); };
  const p = normalizeGeometry(pkg, warnings, rec);
  return { normalizedPackage: p, transformations, warnings };
}

export function normalizeGeometry(pkg, warnings = [], rec = () => {}) {
  const p = { ...pkg };
  const warn = (msg) => warnings.push(`[几何校验] ${msg}`);
  const n = p.pinCount;

  applyPriors(p, warn, rec); // JEDEC 先验先行，之后再跑关系校验

  // 数据手册推荐 land pattern 自洽校验：与本体/间距矛盾则弃用（回退派生）而非将错就错
  if (p.landPattern) {
    const lp = p.landPattern;
    const bad =
      lp.padW >= p.pitch - 0.05 ||                                    // 相邻焊盘必然短路
      (p.family === 'dual' && lp.rowSpan + lp.padL * 2 < p.bodyWidth) || // 焊盘外沿够不到本体外
      (p.family === 'dip' && (lp.rowSpan < p.bodyWidth * 0.7 || !lp.holeDia && lp.padW < 1.0));
    if (bad) {
      rec('land_pattern_discarded', { from: { padW: lp.padW, padL: lp.padL, rowSpan: lp.rowSpan }, to: null, reason: 'inconsistent_with_package_geometry' });
      warn(`${p.name}: 推荐 land pattern（${lp.padW}×${lp.padL}, row ${lp.rowSpan}）与封装几何矛盾，弃用并回退派生焊盘`);
      p.landPattern = null;
      p.landPatternSource = 'derived_by_rules';
    }
  }

  if (p.family === 'dual' || p.family === 'dip') {
    const half = Math.ceil(n / 2);
    const rowLen = (half - 1) * p.pitch;               // 引脚行必需长度
    const minLen = rowLen + Math.max(0.4, p.pitch * 0.3); // 含端部裕量
    // 方向纠正：沿引脚方向的 bodyLength 放不下引脚行（含端距）、而 bodyWidth 放得下 → 长宽颠倒
    if (p.bodyLength < minLen && p.bodyWidth >= minLen && p.bodyWidth > p.bodyLength) {
      rec('body_dimensions_swapped', { from: [pkg.bodyLength, pkg.bodyWidth], to: [p.bodyWidth, p.bodyLength], reason: 'pin_row_does_not_fit_along_bodyLength' });
      [p.bodyLength, p.bodyWidth] = [p.bodyWidth, p.bodyLength];
      warn(`${p.name}: 本体长宽疑似颠倒（沿引脚方向 ${pkg.bodyLength}mm 放不下 ${half} 脚 × ${p.pitch}mm），已交换为 ${p.bodyLength}×${p.bodyWidth}`);
    }
    // 长度合理性：必须 ≥ 引脚行 + 端部裕量，且不离谱地长。
    // DSK-015：上限此前是 rowLen + max(4, pitch*3)。那个 4mm 是**绝对**裕量，
    // 对 SOT23-5 这类小封装意味着允许本体比引脚行长 4mm（+210%），形同虚设。
    // 改为随 pitch 缩放：细间距封装的端部裕量本就随 pitch 收窄。
    const maxLen = rowLen + Math.max(p.pitch * 3, Math.min(4, p.pitch * 3 + 1.2));
    if (p.bodyLength < minLen || p.bodyLength > maxLen) {
      const derived = f1(rowLen + p.pitch * 1.2);
      rec('dimension_derived', { field: 'bodyLength', from: p.bodyLength, to: derived, reason: 'inconsistent_with_pin_count_and_pitch' });
      warn(`${p.name}: 本体长 ${p.bodyLength}mm 与 ${half} 脚 × ${p.pitch}mm 不符，按派生值 ${derived}mm 生成，请核对机械图`);
      p.bodyLength = derived;
    }
    if (p.family === 'dual') {
      // 鸥翼：引脚外沿跨距必须明显大于本体宽
      if (!(p.leadSpan > p.bodyWidth + 0.6)) {
        const derived = f1(p.bodyWidth + 2.0);
        rec('dimension_derived', { field: 'leadSpan', from: p.leadSpan, to: derived, reason: 'leadSpan_not_greater_than_bodyWidth' });
        warn(`${p.name}: leadSpan ${p.leadSpan}mm 未超出本体宽 ${p.bodyWidth}mm（鸥翼引脚必须外伸），按派生值 ${derived}mm 生成`);
        p.leadSpan = derived;
      }
      if (p.leadSpan > p.bodyWidth + 8) {
        const derived = f1(p.bodyWidth + 2.4);
        rec('dimension_derived', { field: 'leadSpan', from: p.leadSpan, to: derived, reason: 'leadSpan_implausible' });
        warn(`${p.name}: leadSpan ${p.leadSpan}mm 失真，按派生值 ${derived}mm 生成`);
        p.leadSpan = derived;
      }
    } else {
      // DIP：孔距不得小于本体宽（引脚从本体两侧引出）
      if (p.rowSpan < p.bodyWidth * 0.85) {
        const derived = p.bodyWidth <= 7 ? 7.62 : p.bodyWidth <= 13 ? 15.24 : f1(p.bodyWidth + 2.5);
        rec('dimension_derived', { field: 'rowSpan', from: p.rowSpan, to: derived, reason: 'dip_rowSpan_smaller_than_body' });
        warn(`${p.name}: DIP 孔距 ${p.rowSpan}mm 小于本体宽 ${p.bodyWidth}mm，按标准值 ${derived}mm 生成`);
        p.rowSpan = derived;
      }
    }
  }

  if (p.family === 'qfn') {
    const perSide = n / 4;
    if (Number.isInteger(perSide)) {
      const minB = (perSide - 1) * p.pitch + Math.max(0.8, p.pitch);
      for (const k of ['bodyLength', 'bodyWidth']) {
        if (p[k] < minB) {
          rec('dimension_derived', { field: k, from: p[k], to: f1(minB), reason: 'qfn_side_cannot_fit_pins' });
          warn(`${p.name}: 本体 ${k === 'bodyLength' ? '长' : '宽'} ${p[k]}mm 放不下每边 ${perSide} 脚 × ${p.pitch}mm，按派生值 ${f1(minB)}mm 生成`);
          p[k] = f1(minB);
        }
      }
      // v0.8.2 item 7：删除矩形 QFN/DFN 的静默长宽交换。
      // 焊盘引擎已分轴（X←bodyWidth / Y←bodyLength），矩形输入按原值使用，不再重排。
      if (p.epLength && p.epLength > p.bodyLength - 1.2) {
        const fromEp = [p.epLength, p.epWidth];
        p.epLength = f1(p.bodyLength - 1.4);
        p.epWidth = Math.min(p.epWidth || p.epLength, f1(p.bodyWidth - 1.4));
        rec('ep_shrunk', { from: fromEp, to: [p.epLength, p.epWidth], reason: 'ep_exceeds_body' });
        warn(`${p.name}: EP 尺寸过大，收缩至 ${p.epLength}×${p.epWidth}mm`);
      }
    }
  }

  return p;
}
