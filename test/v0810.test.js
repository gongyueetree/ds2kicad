// test/v0810.test.js — v0.8.10 图区选中态 / 「重新框选」跳转回归
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newFigureTempId, withFigureIds, resolveActiveIndex,
  shouldConsumeFocus, nextActiveAfterRemoval
} from '../src/figstate.js';

const F = (id, kind = 'application') => ({ figureId: id, kind, title: id, page: 1, bbox: [0.1, 0.1, 0.9, 0.5] });

test('newFigureTempId：连续调用不重复', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newFigureTempId()));
  assert.equal(ids.size, 200);
});

test('withFigureIds：补齐缺失 ID，且不改动已有 ID', () => {
  const out = withFigureIds([{ kind: 'application' }, F('fig_a'), { kind: 'block_diagram' }]);
  assert.equal(out[1].figureId, 'fig_a', '已有 ID 必须原样保留');
  assert.ok(out[0].figureId && out[2].figureId, '缺失 ID 必须补齐');
  assert.notEqual(out[0].figureId, out[2].figureId, '补齐的 ID 之间不得重复');
  assert.equal(new Set(out.map((f) => f.figureId)).size, 3);
});

test('withFigureIds：缺 ID 的图不会再被审核补丁静默丢弃', () => {
  // App 的补丁构造逻辑是 `for (const f of figures) if (!f.figureId) continue;`
  const raw = [{ kind: 'application', page: 3 }];
  assert.equal(raw.filter((f) => f.figureId).length, 0, '修复前：0 张能进入补丁');
  assert.equal(withFigureIds(raw).filter((f) => f.figureId).length, 1, '修复后：全部能进入补丁');
});

/* ── 选中态：ID 主键而非数组下标 ────────────────────────── */

test('resolveActiveIndex：按 figureId 定位，数组重排后仍指向同一张图', () => {
  const before = [F('a'), F('b'), F('c')];
  assert.equal(resolveActiveIndex(before, 'c'), 2);
  // 服务端回写导致顺序变化（旧实现用下标 2 会指到 'a'）
  const after = [F('c'), F('b'), F('a')];
  assert.equal(resolveActiveIndex(after, 'c'), 0, '仍应指向 c');
});

test('resolveActiveIndex：当前图被丢弃后回落到第一张，空数组返回 -1', () => {
  assert.equal(resolveActiveIndex([F('a'), F('b')], 'gone'), 0);
  assert.equal(resolveActiveIndex([], 'a'), -1);
  assert.equal(resolveActiveIndex(null, 'a'), -1);
});

/* ── 跳转令牌：一次性，且不被无关变更反复触发 ──────────── */

test('shouldConsumeFocus：对同一张图连续点「重新框选」仍会触发（seq 递增）', () => {
  const figures = [F('a'), F('b')];
  let handled = null;
  const req1 = { figureId: 'b', seq: 1 };
  assert.equal(shouldConsumeFocus(req1, handled, figures), true);
  handled = req1.seq;
  // 旧实现：常驻 focusFigureId 不变 → effect 不触发 → 停在上次的图
  const req2 = { figureId: 'b', seq: 2 };
  assert.equal(shouldConsumeFocus(req2, handled, figures), true, '同一张图的第二次请求必须仍然生效');
});

test('shouldConsumeFocus：同一请求只消费一次，figures 变更不得反复拽回', () => {
  const req = { figureId: 'b', seq: 7 };
  let figures = [F('a'), F('b')];
  assert.equal(shouldConsumeFocus(req, null, figures), true);
  const handled = req.seq;
  // 自动贴合写回 / 确认 / 改标题 → figures 换了新身份
  figures = figures.map((f) => ({ ...f, fitMethod: 'caption_up' }));
  assert.equal(shouldConsumeFocus(req, handled, figures), false, '不得因 figures 变更再次跳转');
});

test('shouldConsumeFocus：figures 尚未就绪时不消费，待就绪后仍可跳转', () => {
  const req = { figureId: 'z', seq: 3 };
  assert.equal(shouldConsumeFocus(req, null, [F('a')]), false, '目标不在列表中时先不消费');
  assert.equal(shouldConsumeFocus(req, null, [F('a'), F('z')]), true, '就绪后应可消费');
});

test('shouldConsumeFocus：空请求 / 无 figureId 一律不消费', () => {
  assert.equal(shouldConsumeFocus(null, null, [F('a')]), false);
  assert.equal(shouldConsumeFocus({ seq: 1 }, null, [F('a')]), false);
  assert.equal(shouldConsumeFocus({ figureId: undefined, seq: 1 }, null, [{ kind: 'x' }]), false,
    'figureId 为 undefined 时不得匹配到同样缺 ID 的图');
});

/* ── 删除后的落点 ──────────────────────────────────────── */

test('nextActiveAfterRemoval：优先前一张，首张被删则选新首张，空则 null', () => {
  assert.equal(nextActiveAfterRemoval([F('a'), F('c')], 1), 'a');   // 删中间的 b
  assert.equal(nextActiveAfterRemoval([F('b'), F('c')], 0), 'b');   // 删首张 a
  assert.equal(nextActiveAfterRemoval([F('a')], 1), 'a');           // 删末张
  assert.equal(nextActiveAfterRemoval([], 0), null);
});
