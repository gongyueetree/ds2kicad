// lib/figfilter.js — 图区关键词过滤（唯一入口，解析器与 AI 的输出都必须过这里）。
// 原则：只认标题关键词命中的图，宁缺勿滥；"长得像图"不是入选理由。
//   block_diagram     : 标题必须含 "block diagram"（可带 functional/internal/simplified 前缀）→ 仅 1 张
//   application       : 标题必须含 typical application / application circuit|schematic / simplified schematic
//                       且不得含曲线/波形类词（curve/waveform/response/vs/characteristic…）→ 最多 2 张
//   pin_configuration : 标题必须含 (Top View) 或 Pin Configuration/Connections → 最多每封装 1 张

const WHITELIST = {
  block_diagram: /\bblock\s+diagram\b|功能框图|内部框图|方框图|结构框图|框图/i,
  application: /\b(typical\s+application|application\s+(circuit|schematic|diagram)|simplified\s+schematic)\b|典型应用|应用电路|应用示例|应用原理图|简化原理图/i,
  pin_configuration: /top\s+view|pin\s+(configuration|connections?|assignment)|引脚配置|引脚排列|管脚排列|引脚分配|顶视图|俯视图/i,
  // 封装机械图 / 封装信息表
  package_outline: /package\s+(outline|drawing|information|dimensions)|mechanical\s+(data|drawing)|land\s+pattern|封装信息|封装图|封装外形|机械(图|数据)|推荐焊盘/i
};

// DSK-012：标记/丝印图。SHT3x-DIS 的 "Top view of the SHT3x-DIS illustrating the laser
// marking." 命中了 pin_configuration 白名单里的 "top view"，被错标为引脚排布图。
// 这类图讲的是器件顶面激光标记/丝印规则，属封装信息而非引脚配置，必须先于 top view 判定。
const MARKING = /\b(laser\s+)?marking\b|\bmarking\s+(information|code|diagram|drawing)\b|\btop\s+mark\b|激光标记|丝印|打标|标识规则/i;

// 曲线/波形/表格类：即使标题带 "application"（如 Application Curves）也一律排除
const BLACKLIST = /\b(curve|curves|waveform|response|characteristic|performance|graph|plot|measurement|histogram|distribution|vs\.?|versus|table)\b|曲线|波形|特性|性能|测量|直方图|流程图|时序图|对比/i;

/**
 * DSK-012：按标题语义做确定性重分类。AI 只给一个 kind，没有交叉校验；
 * 这里在过滤之前用规则纠正明显错分，并留下审计记录。
 */
export function reclassifyByTitle(figs, log = []) {
  return (Array.isArray(figs) ? figs : []).map((f) => {
    const title = String(f?.title || '');
    if (!title) return f;
    // 标记图：无论 AI 给的是什么，都归入封装信息类
    if (MARKING.test(title) && f.kind !== 'package_outline') {
      log.push({ ...f, rejectReason: `reclassified:${f.kind}->package_outline (title_marking)` });
      return { ...f, kind: 'package_outline', kindReclassified: { from: f.kind, rule: 'title_marking' } };
    }
    // 明确的封装机械图被标成引脚排布图
    if (f.kind === 'pin_configuration' && /package\s+(outline|drawing|dimensions)|mechanical\s+(data|drawing)/i.test(title)) {
      log.push({ ...f, rejectReason: `reclassified:${f.kind}->package_outline (title_outline)` });
      return { ...f, kind: 'package_outline', kindReclassified: { from: f.kind, rule: 'title_outline' } };
    }
    // 明确的框图被标成别的
    if (f.kind !== 'block_diagram' && /\bfunctional\s+block\s+diagram\b|功能框图/i.test(title)) {
      log.push({ ...f, rejectReason: `reclassified:${f.kind}->block_diagram (title_block)` });
      return { ...f, kind: 'block_diagram', kindReclassified: { from: f.kind, rule: 'title_block' } };
    }
    return f;
  });
}

const CAPS = { block_diagram: 1, application: 3, package_outline: 2 };   // 应用图最多 3 张

/**
 * @param {Array} figs   sanitizeFigures 之后的图区数组
 * @param {object} opts  { pkgCount } 用于 pin_configuration 上限
 */
/** 详细版：返回入选与被拒候选（含拒绝原因），被拒候选保留供审核界面复活（审计 Agent4 要求） */
export function filterFiguresDetailed(figs, { pkgCount = 1 } = {}) {
  const rejected = [];
  figs = reclassifyByTitle(figs, rejected);
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
    ...pick('package_outline', Math.max(1, Math.min(pkgCount, CAPS.package_outline))),
    ...pick('application', CAPS.application)
  ].sort((a, b) => a.page - b.page || a.bbox[1] - b.bbox[1]);
}

/**
 * DSK-013：合并解析器与 AI 的图区候选（此前是二选一，导致同一 PDF 结果不稳定）。
 *
 * 稳定性策略：
 *   · 解析器结果是确定性的、可复现的 → 永远保留，且排在前面；
 *   · AI 结果只用于**补充**解析器没找到的图；
 *   · 去重键为 `页码 + 类型`，同页同类型只保留解析器那一份；
 *   · 输出按 (页码, 类型) 稳定排序，消除上游数组顺序带来的抖动。
 *
 * @param {Array} parserFigs 解析器（heuristics）产出
 * @param {Array} aiFigs     Gemini 产出
 */
export function mergeFigureCandidates(parserFigs, aiFigs) {
  const KIND_ORDER = { block_diagram: 0, pin_configuration: 1, package_outline: 2, application: 3 };
  const out = [];
  const seen = new Set();
  const key = (f) => `${f.page}|${f.kind}`;

  for (const f of Array.isArray(parserFigs) ? parserFigs : []) {
    if (seen.has(key(f))) continue;
    seen.add(key(f));
    out.push({ ...f, candidateSource: 'parser' });
  }
  for (const f of Array.isArray(aiFigs) ? aiFigs : []) {
    if (seen.has(key(f))) continue;          // 同页同类型以解析器为准
    seen.add(key(f));
    out.push({ ...f, candidateSource: 'gemini' });
  }
  return out.sort((a, b) =>
    (a.page - b.page) ||
    ((KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)) ||
    String(a.title || '').localeCompare(String(b.title || ''), 'en'));
}
