// src/figstate.js — v0.8.10 图区选中态的纯逻辑（不依赖 React/DOM，可单测）
//
// 背景：④ 编辑器原先用**数组下标**记录"当前图"，并用一个**常驻值** focusFigureId 接收
// 图集的「重新框选」跳转。两者叠加产生了"跳到某个固定页面、必须再点一次类型页签"的缺陷：
//   1) 下标会在图区被丢弃 / 服务端回写重排后指向另一张图；
//   2) 常驻值对"同一张图再次点击"不产生 props 变化 → 跳转 effect 不触发；
//   3) 反过来，任何 figures 变更（自动贴合写回、确认、改标题）都会重新触发跳转 effect，
//      把用户强行拽回上一次的跳转目标。
// 本模块把选中态改为 figureId 主键 + 一次性请求令牌（seq）。

let tmpSeq = 0;

/** 页面内新增图区的稳定临时 ID */
export function newFigureTempId() {
  return `fig_tmp_${Date.now().toString(36)}_${++tmpSeq}`;
}

/**
 * 保证每张图都带 figureId。
 * 缺 ID 的图有两个致命后果：无法被「重新框选」定位；且会被审核补丁的
 * `if (!f.figureId) continue` 静默丢弃（页面新增的图永远存不进 IR）。
 */
export function withFigureIds(list) {
  return (list || []).map((f) => (f && f.figureId ? f : { ...f, figureId: newFigureTempId() }));
}

/** 按 figureId 解析当前图下标；找不到时回落到 0（空数组返回 -1） */
export function resolveActiveIndex(figures, activeId) {
  if (!figures || !figures.length) return -1;
  const i = figures.findIndex((f) => f.figureId === activeId);
  return i >= 0 ? i : 0;
}

/**
 * 是否应当消费这次跳转请求。
 * @param {object|null} req  {figureId, seq}
 * @param {number|null} handledSeq  已消费过的 seq
 * @param {Array} figures
 */
export function shouldConsumeFocus(req, handledSeq, figures) {
  if (!req || !req.figureId) return false;
  if (handledSeq === req.seq) return false;                 // 同一请求只消费一次
  return (figures || []).some((f) => f.figureId === req.figureId); // figures 未就绪则等下次
}

/** 删除当前图后应选中的 figureId（优先前一张，否则第一张，空则 null） */
export function nextActiveAfterRemoval(figures, removedIndex) {
  if (!figures || !figures.length) return null;
  return figures[Math.max(0, Math.min(figures.length - 1, removedIndex - 1))]?.figureId ?? null;
}
