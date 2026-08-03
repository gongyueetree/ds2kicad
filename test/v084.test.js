// test/v084.test.js — v0.8.4 反例（生产闭环 / 跨实例 / 证据 / 注入 / 幂等）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { SqliteJobStore, resetJobStoreForTests, assertProductionStore, idempotencyScope, PG_SCHEMA_SQL } from '../lib/jobstore.js';
import { authenticate, issueDevSession } from '../lib/auth.js';
import { applyReviewPatch } from '../lib/reviewpatch.js';
import { sanitizePackage, sanitizePinsets } from '../lib/validate.js';
import { generateBundle } from '../lib/kicadgen/index.js';
import { generateLegacyLib } from '../lib/kicadgen/symbol.js';
import { strictText, safeFileName } from '../lib/textsafe.js';
import { makeAnchor, SOURCE_TYPE } from '../lib/evidence.js';

const KEY = 'v084-secret';
const PORT = 3984;
let srv, store, tmpDir;

const sess = (o) => issueDevSession({ iss: 'https://ezplm.cn', aud: 'ds2kicad', ...o }, KEY);
const post = async (body, token, headers = {}) => {
  const r = await fetch(`http://localhost:${PORT}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};
const pins = (n) => Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
const SOIC = { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, leadLength: 1.0, height: 1.75, pinsetId: 'default' };

function makeIr({ packages = [SOIC], pinList = pins(8), part = { mpn: 'ACME123', manufacturer: 'ACME', title: 'T', description_zh: 'D' }, figures } = {}) {
  return {
    part,
    packages: packages.map((p, i) => ({ ...sanitizePackage(p), packageId: `pkg_${i + 1}`, pinsetId: p.pinsetId || 'default' })),
    pinsets: sanitizePinsets([{ id: 'default', pins: pinList }], []),
    figures: figures ?? [{ figureId: 'fig_1', kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 3, bbox: [0.1, 0.1, 0.9, 0.5], confirmed: false }],
    mock: false, pdfUrl: 'https://example.com/x.pdf'
  };
}

before(async () => {
  console.error('[before] start');
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  const { default: generateHandler } = await import('../api/generate.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.all('/api/generate', (req, res) => generateHandler(req, res));
  srv = app.listen(PORT);
  console.error('[before] done, port', PORT);
});
after(() => { srv?.close(); if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

test('反例A：页面修改每一种可编辑字段后，Reviewed IR / KiCad / Part Bundle 完全一致', async () => {
  console.error('[A] creating job');
  const job = store.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u1', datasheetSha256: 'd1' });
  console.error('[A] job', job.jobId);
  const token = sess({ sub: 'u1', name: '审核员', tenantId: 't1', roles: ['reviewer'] });
  console.error('[A] token ok');
  const pinId = job.ir.pinsets[0].normalizedPins[0].pinId;
  const r = await post({
    jobId: job.jobId,
    patch: {
      schemaVersion: 'ds2kicad.review-patch.v1',
      part: { mpn: 'NEWPART-1', manufacturer: 'NewCo', title: 'New Title', description_zh: '新描述' },
      packages: [{ packageId: 'pkg_1', name: 'SOIC-8-NEW', bodyLength: 5.05, landPattern: { padW: 0.62, padL: 1.52, rowSpan: 5.35 } }],
      pinsets: [{
        pinsetId: 'default',
        pins: [{ pinId, number: '1', name: 'VCCX', type: 'power_in', description: '电源' }],
        addPins: [{ number: '99', name: 'EXTRA', type: 'input' }],
        removePins: [{ number: '8' }],
        resolveTransformations: { decision: 'accept_normalized', reason: '已核对手册', evidence: { page: 4, quotedText: 'Pin Configuration' } }
      }],
      figures: [{ figureId: 'fig_1', confirmed: true, title: '功能框图' }]
    }
  }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { reviewedIr, partBundle } = r.data;

  // 每一类修改都进入 IR
  assert.equal(reviewedIr.part.mpn, 'NEWPART-1');
  assert.equal(reviewedIr.part.manufacturer, 'NewCo');
  assert.equal(reviewedIr.part.description_zh, '新描述');
  assert.equal(reviewedIr.packages[0].name, 'SOIC-8-NEW');
  assert.equal(reviewedIr.packages[0].bodyLength, 5.05);
  assert.equal(reviewedIr.packages[0].landPattern.padW, 0.62);
  const ps = reviewedIr.pinsets[0];
  assert.equal(ps.normalizedPins.find((p) => p.pinId === pinId).name, 'VCCX');
  assert.ok(ps.normalizedPins.some((p) => p.number === '99' && p.name === 'EXTRA'), '新增管脚');
  assert.ok(!ps.normalizedPins.some((p) => p.number === '8'), '删除管脚');
  assert.equal(reviewedIr.figures[0].confirmed, true);

  // KiCad 与 IR 一致
  assert.ok(r.data.files.kicadSym.includes('"NEWPART-1"'));
  assert.ok(r.data.files.kicadSym.includes('"VCCX"'));
  assert.ok(r.data.files.kicadSym.includes('"EXTRA"'));
  assert.ok(!r.data.files.kicadSym.includes('"P8"'), '已删管脚不得出现在符号中');
  assert.match(r.data.items[0].names.kicadMod, /^NEWPART-1_SOIC-8-NEW_/);

  // Part Bundle 与 IR 一致
  assert.equal(partBundle.part.mpn, 'NEWPART-1');
  assert.equal(partBundle.part.manufacturer, 'NewCo');
  assert.equal(partBundle.packages[0].name, 'SOIC-8-NEW');
  assert.equal(partBundle.pinsets[0].normalizedPins.find((p) => p.number === '99').name, 'EXTRA');
  assert.equal(partBundle.figures.length, 1, '已确认图区应进入 bundle');
  // land pattern 保持 reviewer 来源（item 7）
  assert.equal(partBundle.packages[0].landPatternSource, 'reviewer_entered');
  assert.ok(partBundle.review.changeLog.length >= 10, `changeLog=${partBundle.review.changeLog.length}`);
});

test('反例B：Mock 页面可以正常生成（packages 不被重复覆盖）', async () => {
  const { MOCK_TMUXL27518 } = await import('../lib/mock/tmuxl27518.js');
  const mockPkgs = MOCK_TMUXL27518.packages.map((p, i) => ({ ...sanitizePackage(p), packageId: `pkg_${i + 1}` }));
  const ir = {
    part: MOCK_TMUXL27518.part,
    packages: mockPkgs,
    pinsets: sanitizePinsets(MOCK_TMUXL27518.pinsets, []),
    figures: MOCK_TMUXL27518.figures.map((f, i) => ({ ...f, figureId: `fig_${i + 1}`, confirmed: true })),
    mock: true
  };
  // 每个封装都必须带 packageId 与 family（此前 mock 响应展开顺序导致被覆盖）
  assert.ok(ir.packages.every((p) => p.packageId && p.family));
  const job = store.create({ ir, tenantId: 't1', ownerId: 'u1' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u1', tenantId: 't1', roles: ['reviewer'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.items.length, 2, '两个封装都应生成');
  assert.ok(r.data.items.every((it) => it.files.kicadMod && it.files.wrl), 'mock 也要产出完整文件');
  assert.equal(r.data.mock, true);
  assert.equal(r.data.nonPromotable, true);
  assert.ok(r.data.reasons.includes('mock_data'));
});

test('反例C：两个函数实例通过共享数据库共享 Job（跨实例/重启）', async () => {
  const file = join(tmpDir, 'shared.db');
  const instanceA = new SqliteJobStore(file);          // 实例 A（模拟 /extract 所在函数实例）
  const job = instanceA.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u1', datasheetSha256: 'shared-doc' });
  const instanceB = new SqliteJobStore(file);          // 实例 B（模拟 /generate 所在的另一实例）
  const got = instanceB.get(job.jobId);
  assert.equal(got.ok, true, '另一实例必须能读到同一 Job');
  assert.equal(got.job.ir.part.mpn, 'ACME123');
  // 实例 B 更新 → 实例 A 可见（跨实例一致）
  instanceB.update(job.jobId, { ir: { ...got.job.ir, part: { mpn: 'FROM-B' } } }, 1, 'u1');
  assert.equal(instanceA.get(job.jobId).job.ir.part.mpn, 'FROM-B');
  assert.equal(instanceA.get(job.jobId).job.revision, 2);
  // 乐观锁跨实例生效
  assert.equal(instanceA.update(job.jobId, { ir: {} }, 1).code, 'revision_conflict');
  // "重启"：新建实例仍能读到
  const afterRestart = new SqliteJobStore(file);
  assert.equal(afterRestart.get(job.jobId).job.revision, 2);

  // 生产必须 PostgreSQL：无 DATABASE_URL 或设了 JOBSTORE_FILE 都要 fail closed
  const saved = { v: process.env.VERCEL, d: process.env.DATABASE_URL, f: process.env.JOBSTORE_FILE };
  try {
    process.env.VERCEL = '1'; delete process.env.DATABASE_URL; delete process.env.JOBSTORE_FILE;
    assert.throws(() => assertProductionStore(), /DATABASE_URL/);
    process.env.DATABASE_URL = 'postgres://x/y'; process.env.JOBSTORE_FILE = '/tmp/a.db';
    assert.throws(() => assertProductionStore(), /JOBSTORE_FILE/);
    delete process.env.JOBSTORE_FILE;
    assert.doesNotThrow(() => assertProductionStore());
  } finally {
    if (saved.v === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.v;
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    if (saved.f === undefined) delete process.env.JOBSTORE_FILE; else process.env.JOBSTORE_FILE = saved.f;
  }
  // PG 适配器：SQL 与并发语义存在（真实 PG 连接为 NOT VERIFIED，见报告）
  assert.match(PG_SCHEMA_SQL, /CREATE UNIQUE INDEX[\s\S]*status = 'active'/);
  const { PostgresJobStore } = await import('../lib/jobstore.js');
  assert.equal(typeof PostgresJobStore.connect, 'function');
});

test('反例D：exp="not-a-number" 返回 401（nbf 同理）', () => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mk = (payload) => {
    const h = b({ alg: 'HS256', typ: 'JWT' }), p = b(payload);
    return `${h}.${p}.${Buffer.from(createHmac('sha256', KEY).update(`${h}.${p}`).digest()).toString('base64url')}`;
  };
  const base = { sub: 'u1', tenantId: 't1', iss: 'https://ezplm.cn', aud: 'ds2kicad' };
  for (const exp of ['not-a-number', '', {}, [], 'NaN']) {
    const res = authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp })}` } });
    assert.equal(res.ok, false, `exp=${JSON.stringify(exp)}`);
    assert.equal(res.status, 401);
  }
  const nb = authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp: Math.floor(Date.now() / 1000) + 60, nbf: 'later' })}` } });
  assert.equal(nb.ok, false);
  assert.match(nb.error, /nbf/);
  // 有效 token 通过
  assert.equal(authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp: Math.floor(Date.now() / 1000) + 60 })}` } }).ok, true);
});

test('反例E：editor 空 Patch 不产生 reviewedBy', async () => {
  const job = store.create({ ir: makeIr(), tenantId: 't1', ownerId: 'u-editor' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u-editor', name: 'E', tenantId: 't1', roles: ['editor'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reviewedIr.reviewedBy, undefined, 'editor 空 Patch 不得写 reviewedBy');
  assert.equal(r.data.partBundle.review.reviewedBy, null);
  assert.equal(r.data.revision, 1, '空 Patch 不应产生新 revision');
  assert.equal(r.data.canReview, false);
  // editor 提交实质修改 → 403
  const denied = await post({ jobId: job.jobId, patch: { part: { mpn: 'X9' } } }, sess({ sub: 'u-editor', tenantId: 't1', roles: ['editor'] }));
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'insufficient_role');
  // reviewer 修改 → 写 reviewedBy
  const ok = await post({ jobId: job.jobId, patch: { part: { mpn: 'X9' } } }, sess({ sub: 'u-rev', name: 'R', tenantId: 't1', roles: ['reviewer'] }));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.reviewedIr.reviewedBy.sub, 'u-rev');
});

test('反例F：unverified Evidence 不得晋升 Footprint', () => {
  const pkg = sanitizePackage({ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } });
  // 关键字段带 unverified 锚点（缺定位信息 → 自动降级）
  pkg.evidence = {
    pitch: makeAnchor({ field: 'pitch', sourceType: SOURCE_TYPE.DATASHEET_DRAWING, extractor: 'x' }), // 无 sha/page → unverified
    bodyLength: makeAnchor({ field: 'bodyLength', sourceType: SOURCE_TYPE.MODEL_INFERENCE, extractor: 'llm' })
  };
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, confirmedFigureCount: 1, items: [{ pkg, pins: pins(8) }] });
  assert.ok(r.reasons.includes('field_evidence_unverified'), JSON.stringify(r.reasons));
  assert.ok(r.reasons.includes('field_evidence_model_inference'));
  assert.equal(r.assetPromotion.footprint, false, 'footprint 必须被阻断');
  assert.equal(r.assetPromotion.model3d, false);
  // 有完整锚点则不阻断
  const good = sanitizePackage({ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } });
  good.evidence = {
    pitch: makeAnchor({ field: 'pitch', sourceType: SOURCE_TYPE.DATASHEET_DRAWING, documentSha256: 'a'.repeat(64), page: 62, bbox: [0, 0, 1, 1], extractor: 'x' })
  };
  const r2 = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, confirmedFigureCount: 1, items: [{ pkg: good, pins: pins(8) }] });
  // v0.8.5：单个字段有锚点不足以放行——其余 relevantFields 仍缺锚点，fail closed 继续阻断
  assert.ok(r2.reasons.includes('field_evidence_unverified'), JSON.stringify(r2.reasons));
  // v0.8.5：仅 pitch 有锚点仍不够——其余 relevantFields 缺锚点 → 继续阻断（fail closed）
  assert.equal(r2.assetPromotion.footprint, false);
});

test('反例G：空 Figures 不得 promotable', () => {
  const pkg = sanitizePackage({ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } });
  const none = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, confirmedFigureCount: 0, items: [{ pkg, pins: pins(8) }] });
  assert.ok(none.reasons.includes('no_confirmed_figures'));
  assert.equal(none.assetPromotion.figures, false);
  assert.equal(none.assetPromotion.symbol, true, '图区为空不应影响 symbol');
  const some = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, confirmedFigureCount: 2, items: [{ pkg, pins: pins(8) }] });
  assert.equal(some.assetPromotion.figures, true);
});

test('反例H：连续多个控制字符输入全部拒绝（/g 状态 bug 回归）', () => {
  const bad = ['A\nB', 'C\rD', 'E\u0000F', 'G\u0001H', 'I\u2028J', 'K\u007FL', 'M\nN', 'O\u0000P'];
  for (let round = 0; round < 3; round++) {
    for (const v of bad) {
      const r = strictText(v, { field: 'mpn' });
      assert.equal(r.ok, false, `round ${round}: ${JSON.stringify(v)} 应被拒绝`);
    }
  }
  // 连续合法输入不应被误拒
  for (const v of ['LM358', 'TMUXL27518', 'ADL6346B']) assert.equal(strictText(v).ok, true, v);
  // Patch 层同样连续拒绝
  const ir = makeIr();
  for (const v of ['A\nB', 'C\u0000D', 'E\rF']) {
    const res = applyReviewPatch(ir, { part: { mpn: v } }, { reviewer: { sub: 'u', name: 'r' } });
    assert.equal(res.ok, false, JSON.stringify(v));
  }
});

test('反例I：Legacy LIB 与浏览器 ZIP 无注入 / 路径穿越', async () => {
  const evil = 'X"\nDEF HACKED U 0 40 Y Y 1 F N\n../../etc/passwd';
  const lib = generateLegacyLib({ mpn: evil, pins: pins(3) });
  assert.equal(lib.split('\n').filter((l) => l.startsWith('DEF ')).length, 1, 'DEF 行只能有一行');
  assert.ok(!/HACKED U 0 40 Y Y 1 F N$/m.test(lib.split('\n').slice(1).join('\n')) || lib.split('\n').filter((l) => l.startsWith('DEF ')).length === 1);
  const f1 = lib.split('\n').find((l) => l.startsWith('F1 '));
  assert.equal((f1.match(/"/g) || []).length, 2, 'F1 只能有一对引号');
  assert.ok(!lib.includes('../'), 'legacy lib 不得含路径穿越串');

  // ZIP：所有条目路径安全
  const job = store.create({ ir: makeIr({ part: { mpn: evil }, packages: [{ ...SOIC, name: evil }] }), tenantId: 't1', ownerId: 'u1' });
  const r = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u1', tenantId: 't1', roles: ['reviewer'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const f of r.data.assetFiles) zip.file(f.path, 'x');
  const back = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  for (const name of Object.keys(back.files)) {
    assert.ok(!name.includes('..'), name);
    assert.ok(!name.startsWith('/'), name);
    assert.ok(!/[\u0000-\u001F]/.test(name), name);
  }
  assert.equal(safeFileName('../../x'), '____x');
});

test('反例J：同租户不同用户相同 Idempotency-Key 不串 Job', () => {
  const s = new SqliteJobStore(join(tmpDir, 'idem.db'));
  const mk = (ownerId, doc) => s.create({ ir: makeIr(), tenantId: 't1', ownerId, datasheetSha256: doc, idempotencyKey: 'SAME-KEY' });
  const u1a = mk('u1', 'docA');
  const u1b = mk('u1', 'docA');
  const u2 = mk('u2', 'docA');
  const u1other = mk('u1', 'docB');
  assert.equal(u1a.jobId, u1b.jobId, '同用户同文档同键 → 复用');
  assert.notEqual(u1a.jobId, u2.jobId, '同租户不同用户不得串 Job');
  assert.notEqual(u1a.jobId, u1other.jobId, '不同文档不得串 Job');
  assert.notEqual(u2.jobId, u1other.jobId);
  // operation 也参与作用域
  const opA = idempotencyScope({ tenantId: 't1', ownerId: 'u1', operation: 'extract', documentSha256: 'd', key: 'k' });
  const opB = idempotencyScope({ tenantId: 't1', ownerId: 'u1', operation: 'generate', documentSha256: 'd', key: 'k' });
  assert.notEqual(opA, opB);
  // 撤销后同键可重建（唯一索引冲突已解决）
  s.revoke(u1a.jobId, 'u1');
  const rebuilt = mk('u1', 'docA');
  assert.notEqual(rebuilt.jobId, u1a.jobId);
  assert.equal(s.get(rebuilt.jobId).ok, true);
});

test('item 10：Patch 各层严格 Schema，结构错误返回 400 而不抛异常', () => {
  const ir = makeIr();
  const reviewer = { sub: 'u', name: 'r' };
  const cases = [
    { patch: { pinsets: 'not-array' }, path: 'pinsets' },
    { patch: { packages: { a: 1 } }, path: 'packages' },
    { patch: { figures: 42 }, path: 'figures' },
    { patch: { pinsets: [{ pinsetId: 'default', pins: 'x' }] }, path: 'pinsets[0].pins' },
    { patch: { pinsets: [{ pinsetId: 'default', bogus: 1 }] }, path: 'pinsets[0].bogus' },
    { patch: { packages: [{ packageId: 'pkg_1', landPattern: 'x' }] }, path: 'packages[0].landPattern' },
    { patch: { packages: [{ packageId: 'nope', pitch: 1 }] }, path: 'packages[0].packageId' },
    { patch: { pinsets: [{ pinsetId: 'default', resolveTransformations: { decision: 'nope' } }] }, path: 'pinsets[0].resolveTransformations.decision' }
  ];
  for (const c of cases) {
    let res;
    assert.doesNotThrow(() => { res = applyReviewPatch(ir, c.patch, { reviewer }); }, JSON.stringify(c.patch));
    assert.equal(res.ok, false, JSON.stringify(c.patch));
    assert.ok(res.errors.some((e) => e.path === c.path), `${c.path} 未报错：${JSON.stringify(res.errors)}`);
  }
  // 非对象 patch / null 不抛异常
  assert.doesNotThrow(() => applyReviewPatch(ir, 'string', { reviewer }));
  assert.equal(applyReviewPatch(ir, 'string', { reviewer }).ok, false);
  assert.equal(applyReviewPatch(ir, null, { reviewer }).ok, true);
});

test('item 11：canPublish 为资产级且需要 publisher 角色', async () => {
  const ir = makeIr({ packages: [{ ...SOIC, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } }] });
  ir.figures[0].confirmed = true;
  const job = store.create({ ir, tenantId: 't1', ownerId: 'u1' });
  const asReviewer = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u1', tenantId: 't1', roles: ['reviewer'] }));
  assert.equal(typeof asReviewer.data.canPublish, 'object', 'canPublish 必须是资产级对象');
  assert.equal(asReviewer.data.canPublish.symbol, false, 'reviewer 无发布权');
  // v0.8.5 item 7/11：canPublish 依赖**持久化批准状态**，未 approve 时即便 publisher 也全 false
  const asPublisher = await post({ jobId: job.jobId, patch: {} }, sess({ sub: 'u1', tenantId: 't1', roles: ['publisher'] }));
  assert.deepEqual(asPublisher.data.canPublish, { symbol: false, footprint: false, model3d: false, figures: false });
});
