// lib/figfilter.js — 图区关键词过滤（唯一入口，解析器与 AI 的输出都必须过这里）。
// 原则：只认标题关键词命中的图，宁缺勿滥；"长得像图"不是入选理由。
//   block_diagram     : 标题必须含 "block diagram"（可带 functional/internal/simplified 前缀）→ 仅 1 张
//   application       : 标题必须含 typical application / application circuit|schematic / simplified schematic
//                       且不得含曲线/波形类词（curve/waveform/response/vs/characteristic…）→ 最多 2 张
//   pin_configuration : 标题必须含 (Top View) 或 Pin Configuration/Connections → 最多每封装 1 张

const WHITELIST = {
  block_diagram: /\bblock\s+diagram\b|功能框图|内部框图|方框图|结构框图|框图/i,
  application: /\b(typical\s+application|application\s+(circuit|schematic|diagram)|simplified\s+schematic)\b|典型应用|应用电路|应用示例|应用原理图|简化原理图/i,
  pin_configuration: /top\s+view|pin\s+(configuration|connections?|assignment)|引脚配置|引脚排列|管脚排列|引脚分配|顶视图|俯视图/i
};

// 曲线/波形/表格类：即使标题带 "application"（如 Application Curves）也一律排除
const BLACKLIST = /\b(curve|curves|waveform|response|characteristic|performance|graph|plot|measurement|histogram|distribution|vs\.?|versus|table)\b|曲线|波形|特性|性能|测量|直方图|流程图|时序图|对比/i;

const CAPS = { block_diagram: 1, application: 2 };

/**
 * @param {Array} figs   sanitizeFigures 之后的图区数组
 * @param {object} opts  { pkgCount } 用于 pin_configuration 上限
 */
/** 详细版：返回入选与被拒候选（含拒绝原因），被拒候选保留供审核界面复活（审计 Agent4 要求） */
export function filterFiguresDetailed(figs, { pkgCount = 1 } = {}) {
  const rejected = [];
  const accepted = filterFiguresInner(figs, { pkgCount }, rejected);
  return { figures: accepted, rejected: rejected.slice(0, 12) };
}

export function filterFigures(figs, opts) {
  return filterFiguresInner(figs, opts || {}, null);
}

function filterFiguresInner(figs, { pkgCount = 1 } = {}, rejected) {
  const kept = [];
  for (const f of Array.isArray(figs) ? figs : []) {
    const title = String(f.title || '');
    const wl = WHITELIST[f.kind];
    if (BLACKLIST.test(title)) { rejected?.push({ ...f, rejectReason: 'blacklist_curve_plot' }); continue; }
    if (!wl || !wl.test(title)) { rejected?.push({ ...f, rejectReason: 'keyword_not_matched' }); continue; }
    // 同页同类去重（bbox 顶部相近视为重复定位）
    if (kept.some((k) => k.kind === f.kind && k.page === f.page && Math.abs(k.bbox[1] - f.bbox[1]) < 0.05)) continue;
    kept.push(f);
  }
  // 排序：优先带 "Figure N." 编号的正式说明行（定位最准），再按页码
  const score = (f) => (/^figure\s+\d/i.test(f.title) ? 0 : 1);
  kept.sort((a, b) => score(a) - score(b) || a.page - b.page);
  const pick = (kind, cap) => kept.filter((f) => f.kind === kind).slice(0, cap);
  return [
    ...pick('block_diagram', CAPS.block_diagram),
    ...pick('pin_configuration', Math.max(1, pkgCount)),
    ...pick('application', CAPS.application)
  ].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1]);
}
