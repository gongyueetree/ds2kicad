// lib/kicadgen/geometry.js — 确定性几何校验层。
// AI 提取的封装尺寸在进入焊盘/3D 引擎前必须通过本层：
//   1. 方向纠正：dual/dip 的 bodyLength（沿引脚排布）必须容得下引脚行，颠倒则交换
//   2. 派生兜底：尺寸缺失或明显失真时按 pinCount×pitch 派生并告警
//   3. 关系约束：leadSpan>bodyWidth（鸥翼）、EP<本体、QFN 每边引脚放得下
// 原则：宁可用可证明自洽的派生值 + 告警，也不让失真尺寸生成废封装。

const f1 = (n) => Number(n.toFixed(2));

export function normalizeGeometry(pkg, warnings = []) {
  const p = { ...pkg };
  const warn = (msg) => warnings.push(`[几何校验] ${msg}`);
  const n = p.pinCount;

  if (p.family === 'dual' || p.family === 'dip') {
    const half = Math.ceil(n / 2);
    const rowLen = (half - 1) * p.pitch;               // 引脚行必需长度
    const minLen = rowLen + Math.max(0.4, p.pitch * 0.3); // 含端部裕量
    // 方向纠正：沿引脚方向的 bodyLength 放不下引脚行（含端距）、而 bodyWidth 放得下 → 长宽颠倒
    if (p.bodyLength < minLen && p.bodyWidth >= minLen && p.bodyWidth > p.bodyLength) {
      [p.bodyLength, p.bodyWidth] = [p.bodyWidth, p.bodyLength];
      warn(`${p.name}: 本体长宽疑似颠倒（沿引脚方向 ${pkg.bodyLength}mm 放不下 ${half} 脚 × ${p.pitch}mm），已交换为 ${p.bodyLength}×${p.bodyWidth}`);
    }
    // 长度合理性：必须 ≥ 引脚行 + 端部裕量，且不离谱地长
    const maxLen = rowLen + Math.max(4, p.pitch * 3);
    if (p.bodyLength < minLen || p.bodyLength > maxLen) {
      const derived = f1(rowLen + p.pitch * 1.2);
      warn(`${p.name}: 本体长 ${p.bodyLength}mm 与 ${half} 脚 × ${p.pitch}mm 不符，按派生值 ${derived}mm 生成，请核对机械图`);
      p.bodyLength = derived;
    }
    if (p.family === 'dual') {
      // 鸥翼：引脚外沿跨距必须明显大于本体宽
      if (!(p.leadSpan > p.bodyWidth + 0.6)) {
        const derived = f1(p.bodyWidth + 2.0);
        warn(`${p.name}: leadSpan ${p.leadSpan}mm 未超出本体宽 ${p.bodyWidth}mm（鸥翼引脚必须外伸），按派生值 ${derived}mm 生成`);
        p.leadSpan = derived;
      }
      if (p.leadSpan > p.bodyWidth + 8) {
        const derived = f1(p.bodyWidth + 2.4);
        warn(`${p.name}: leadSpan ${p.leadSpan}mm 失真，按派生值 ${derived}mm 生成`);
        p.leadSpan = derived;
      }
    } else {
      // DIP：孔距不得小于本体宽（引脚从本体两侧引出）
      if (p.rowSpan < p.bodyWidth * 0.85) {
        const derived = p.bodyWidth <= 7 ? 7.62 : p.bodyWidth <= 13 ? 15.24 : f1(p.bodyWidth + 2.5);
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
          warn(`${p.name}: 本体 ${k === 'bodyLength' ? '长' : '宽'} ${p[k]}mm 放不下每边 ${perSide} 脚 × ${p.pitch}mm，按派生值 ${f1(minB)}mm 生成`);
          p[k] = f1(minB);
        }
      }
      // 四边封装以 bodyLength 参与焊盘计算：取两维较大者对齐，避免矩形输入产生越界
      if (Math.abs(p.bodyLength - p.bodyWidth) > 0.01 && p.bodyWidth > p.bodyLength) {
        [p.bodyLength, p.bodyWidth] = [p.bodyWidth, p.bodyLength];
      }
      if (p.epLength && p.epLength > p.bodyLength - 1.2) {
        p.epLength = f1(p.bodyLength - 1.4);
        p.epWidth = Math.min(p.epWidth || p.epLength, f1(p.bodyWidth - 1.4));
        warn(`${p.name}: EP 尺寸过大，收缩至 ${p.epLength}×${p.epWidth}mm`);
      }
    }
  }

  return p;
}
