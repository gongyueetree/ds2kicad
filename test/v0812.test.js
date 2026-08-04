// test/v0812.test.js — v0.8.12 复核面板：generate 必须提供面板所需字段；approve → publish 全链路
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { resetObjectStoreForTests } from '../lib/objectstore.js';
import { issueDevSession } from '../lib/auth.js';
import { REASON_HELP } from '../src/promotionHelp.js';
import { BLOCK } from '../lib/promotion.js';

const KEY = 'v0812-secret';
const PORT = 3993;
let srv, store, tmpDir;

const sess = (roles = ['reviewer']) => issueDevSession(
  { sub: 'u1', name: 'R', tenantId: 'smoke-tenant', roles, iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);
const PUB = () => sess(['reviewer', 'publisher']);
const call = async (path, body, token = sess()) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};

before(async () => {
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  process.env.MOCK_MODE = '1';
  process.env.PDF_TOKEN_SECRET = 'v0812-pdf';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k812-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  resetObjectStoreForTests();
  const { default: extractHandler } = await import('../api/extract.js');
  const { default: generateHandler } = await import('../api/generate.js');
  const { default: lifecycleHandler } = await import('../api/lifecycle.js');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.all('/api/extract', (q, r) => extractHandler(q, r));
  app.all('/api/generate', (q, r) => generateHandler(q, r));
  app.all('/api/lifecycle', (q, r) => lifecycleHandler(q, r));
  srv = app.listen(PORT);
});
after(() => { srv?.close(); if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

/** 证据齐全的非 mock 作业（mock 数据按设计恒不可晋升，无法用于审批链路） */
async function makePromotableJob() {
  const { sanitizePackage, sanitizePinsets } = await import('../lib/validate.js');
  const { makeAnchor, SOURCE_TYPE } = await import('../lib/evidence.js');
  const A = (f) => makeAnchor({ field: f, sourceType: SOURCE_TYPE.DATASHEET_DRAWING, documentSha256: 'a'.repeat(64), page: 62, bbox: [0, 0, 1, 1], extractor: 'test', extractorVersion: '1' });
  const pkg = sanitizePackage({
    name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9,
    leadSpan: 6, leadLength: 1, height: 1.75,
    landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 }
  });
  pkg.packageId = 'pkg_1';
  pkg.pinsetId = 'default';
  pkg.evidence = Object.fromEntries([...pkg.relevantFields, 'landPattern.padW', 'landPattern.padL', 'landPattern.rowSpan'].map((f) => [f, A(f)]));
  const pinsets = sanitizePinsets([{ id: 'default', pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' })) }], []);
  const job = store.create({
    ir: {
      part: { mpn: 'RVW1', manufacturer: 'M', title: 'T', description_zh: 'D' },
      packages: [pkg], pinsets,
      figures: [{ figureId: 'fig_1', kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 3, bbox: [0.1, 0.1, 0.9, 0.5], confirmed: true, evidence: A('figure') }],
      mock: false, documentSha256: 'a'.repeat(64), pdfUrl: 'https://example.com/x.pdf'
    },
    tenantId: 'smoke-tenant', ownerId: 'u1', datasheetSha256: 'a'.repeat(64)
  });
  const gen = await call('/api/generate', { jobId: job.jobId, patch: {} }, PUB());
  return { jobId: job.jobId, gen };
}

/** 状态机要求 approve 之前先 review；返回 review 之后的 revision */
async function markReviewed(jobId, expectedRevision) {
  const r = await call('/api/lifecycle', { jobId, action: 'review', reason: '页面复核', expectedRevision }, PUB());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state, 'reviewed');
  return r.data.revision;
}

/* ── generate 必须提供面板渲染所需的全部字段 ── */

test('generate 返回资产键级闸门结论与角色标记（面板的数据源）', async () => {
  const { gen } = await makePromotableJob();
  assert.equal(gen.status, 200, JSON.stringify(gen.data).slice(0, 400));
  const d = gen.data;
  assert.ok(d.assetKeyPromotion && Object.keys(d.assetKeyPromotion).length, '必须有资产键级结论');
  for (const [k, v] of Object.entries(d.assetKeyPromotion)) {
    assert.match(k, /^(symbol|footprint|model3d|figure):/, `资产键格式非法：${k}`);
    assert.equal(typeof v.promotable, 'boolean');
    assert.ok(Array.isArray(v.reasons));
  }
  assert.equal(typeof d.canReview, 'boolean');
  assert.equal(d.canPublishRole, true, '面板需要区分"无 publisher 角色"与"尚未批准"');
  assert.equal(d.sessionAuthenticated, true);
  assert.ok('lifecycle' in d, '面板需要 lifecycle.approvals / published 来显示状态');
});

test('未认证会话下所有资产键都被阻断（面板应全灰）', async () => {
  const ex = await call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });
  const gen = await call('/api/generate', { jobId: ex.data.jobId, patch: {} });
  const byKey = gen.data.assetKeyPromotion || {};
  assert.ok(Object.keys(byKey).length);
  for (const [k, v] of Object.entries(byKey)) {
    assert.equal(v.promotable, false, `${k} 在 mock 作业里不应可晋升`);
  }
});

/* ── approve → publish 全链路 ── */

test('状态机：extracted 下直接 approve 被拒，必须先 review', async () => {
  const { jobId, gen } = await makePromotableJob();
  assert.equal(gen.data.state, 'extracted');
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  const early = await call('/api/lifecycle', {
    jobId, action: 'approve', assets: [key], reason: '越过 review', expectedRevision: gen.data.revision
  }, PUB());
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'invalid_transition');
  assert.equal(early.data.from, 'extracted');
});

test('approve 成功：revision +1，approvals 落库', async () => {
  const { jobId, gen } = await makePromotableJob();
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  assert.ok(key, `至少要有一个可晋升资产，实际：${JSON.stringify(gen.data.assetKeyPromotion)}`);
  const rev = await markReviewed(jobId, gen.data.revision);

  const ap = await call('/api/lifecycle', {
    jobId, action: 'approve', assets: [key], reason: '已对照机械图复核', expectedRevision: rev
  }, PUB());
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data.revision, rev + 1, 'lifecycle 动作必然使 revision +1');
  assert.ok(ap.data.approvals[key], '批准记录必须落库');
  assert.ok(ap.data.lifecycle, '响应必须带回 lifecycle 供面板刷新');
});

test('publish 需 publisher 角色，且必须先 approve', async () => {
  const { jobId, gen } = await makePromotableJob();
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  const rev = await markReviewed(jobId, gen.data.revision);

  // 未 approve 直接 publish → 拒绝
  const early = await call('/api/lifecycle', {
    jobId, action: 'publish', assets: [key], reason: '直接发布', expectedRevision: rev
  }, PUB());
  assert.equal(early.status, 409);

  // approve 后再 publish
  const ap = await call('/api/lifecycle', {
    jobId, action: 'approve', assets: [key], reason: '复核通过', expectedRevision: rev
  }, PUB());
  assert.equal(ap.status, 200);
  const pb = await call('/api/lifecycle', {
    jobId, action: 'publish', assets: [key], reason: '发布', expectedRevision: ap.data.revision
  }, PUB());
  assert.equal(pb.status, 200, JSON.stringify(pb.data));
  assert.ok(pb.data.published[key], '发布记录必须落库');
});

test('沿用过期 revision 复核 → 409 revision_conflict（面板据此自愈）', async () => {
  const { jobId, gen } = await makePromotableJob();
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  const r0 = await markReviewed(jobId, gen.data.revision);
  const ap = await call('/api/lifecycle', { jobId, action: 'approve', assets: [key], reason: '第一次', expectedRevision: r0 }, PUB());
  assert.equal(ap.status, 200);
  const again = await call('/api/lifecycle', { jobId, action: 'approve', assets: [key], reason: '沿用旧版本号', expectedRevision: r0 }, PUB());
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'revision_conflict');
  assert.equal(again.data.currentRevision, ap.data.revision);
});

test('approve 被阻断资产 → 409 asset_not_promotable（面板不得绕过闸门）', async () => {
  const ex = await call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });
  const gen = await call('/api/generate', { jobId: ex.data.jobId, patch: {} }, PUB());
  const key = Object.keys(gen.data.assetKeyPromotion)[0];
  const rev = await markReviewed(ex.data.jobId, gen.data.revision);
  const ap = await call('/api/lifecycle', {
    jobId: ex.data.jobId, action: 'approve', assets: [key], reason: '强行批准', expectedRevision: rev
  }, PUB());
  assert.equal(ap.status, 409);
  assert.equal(ap.data.code, 'asset_not_promotable');
});

test('approve 必须携带理由', async () => {
  const { jobId, gen } = await makePromotableJob();
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  const rev = await markReviewed(jobId, gen.data.revision);
  const r = await call('/api/lifecycle', { jobId, action: 'approve', assets: [key], reason: '', expectedRevision: rev }, PUB());
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'reason_required');
});

/* ── 面板文案覆盖率 ── */

test('每个阻断原因枚举值在面板里都有中文说明与处理位置', () => {
  const missing = Object.values(BLOCK).filter((code) => !REASON_HELP[code]);
  assert.deepEqual(missing, [], `以下阻断原因缺少面板说明：${missing.join(', ')}`);
  for (const [code, v] of Object.entries(REASON_HELP)) {
    assert.equal(v.length, 2, `${code} 必须同时给出"是什么"与"去哪处理"`);
    assert.ok(v[0].length > 2 && v[1].length > 4, `${code} 说明过短`);
  }
});

/* ── 已认证但缺角色：面板必须能解释清楚 ── */

const EDITOR = () => issueDevSession(
  { sub: 'u1', name: 'R', tenantId: 'smoke-tenant', roles: ['editor'], iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);

test('sessionAuthenticated 为 true 不等于有 reviewer 角色', async () => {
  const { jobId } = await makePromotableJob();
  const gen = await call('/api/generate', { jobId, patch: {} }, EDITOR());
  assert.equal(gen.status, 200, JSON.stringify(gen.data).slice(0, 300));
  assert.equal(gen.data.sessionAuthenticated, true, '验签通过');
  assert.equal(gen.data.canReview, false, '但没有 reviewer 角色');
  assert.equal(gen.data.canPublishRole, false);
  // 此时闸门不再报 no_authenticated_ezplm_session（认证是过的），面板必须解释成"缺角色"
  const reasons = new Set(Object.values(gen.data.assetKeyPromotion).flatMap((v) => v.reasons));
  assert.ok(!reasons.has('no_authenticated_ezplm_session'), '认证已通过，不应再报未认证');
});

test('缺 reviewer 角色时 review 被 403 拒绝（面板据此给出 JWT 提示）', async () => {
  const { jobId, gen } = await makePromotableJob();
  const r = await call('/api/lifecycle', { jobId, action: 'review', reason: '页面复核', expectedRevision: gen.data.revision }, EDITOR());
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'insufficient_role');
});

test('缺 publisher 角色时 publish 被 403 拒绝', async () => {
  const { jobId, gen } = await makePromotableJob();
  const key = Object.entries(gen.data.assetKeyPromotion).find(([, v]) => v.promotable)?.[0];
  const rev = await markReviewed(jobId, gen.data.revision);
  const ap = await call('/api/lifecycle', { jobId, action: 'approve', assets: [key], reason: '复核通过', expectedRevision: rev }, sess());
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  // sess() 只有 reviewer，没有 publisher
  const pb = await call('/api/lifecycle', { jobId, action: 'publish', assets: [key], reason: '发布', expectedRevision: ap.data.revision }, sess());
  assert.equal(pb.status, 403);
  assert.equal(pb.data.code, 'insufficient_role');
});

/* ── v0.8.14：认证链路诊断 ── */

test('无令牌 + AUTH_MODE=dev → 静默降级为匿名身份，诊断字段必须如实说明', async () => {
  const prev = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'dev';
  try {
    // 作业本身也由匿名身份创建（与现场一致：全程没有任何令牌）
    const ex = await fetch(`http://localhost:${PORT}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' })
    });
    const jobId = (await ex.json()).jobId;
    const r = await fetch(`http://localhost:${PORT}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },   // 故意不带任何令牌
      body: JSON.stringify({ jobId, patch: {} })
    });
    const d = await r.json();
    assert.equal(r.status, 200, '现场正是这种"看起来正常但其实是匿名"的状态');
    assert.equal(d.sessionAuthenticated, false);
    assert.equal(d.canReview, true, '匿名身份恰好带 reviewer —— 这正是「标记已复核」能点的原因');
    assert.equal(d.canPublishRole, false, '匿名身份没有 publisher');
    const ad = d.authDiagnostics;
    assert.equal(ad.devMode, true);
    assert.equal(ad.tokenPresent, false, '必须如实报告"这次请求没带令牌"');
    assert.equal(ad.secretConfigured, true, 'EZPLM_JWT_SECRET 配了也没用 —— 浏览器没送令牌');
    assert.equal(ad.sessionTenantId, 'dev');
    assert.equal(ad.jobTenantId, 'dev', '匿名身份创建的作业归属 dev 租户');
    // 每个资产都因未认证被阻断
    for (const v of Object.values(d.assetKeyPromotion)) {
      assert.ok(v.reasons.includes('no_authenticated_ezplm_session'), JSON.stringify(v.reasons));
    }
  } finally { process.env.AUTH_MODE = prev; }
});

test('AUTH_MODE=production 下无令牌直接 401，不再静默降级', async () => {
  const prev = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'production';
  try {
    const r = await fetch(`http://localhost:${PORT}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' })
    });
    assert.equal(r.status, 401);
  } finally { process.env.AUTH_MODE = prev; }
});

test('Cookie 通道：ezplm_session 与 Bearer 等效（前端依赖的正是 Cookie）', async () => {
  const token = sess(['reviewer', 'publisher']);
  const r = await fetch(`http://localhost:${PORT}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `ezplm_session=${token}` },
    body: JSON.stringify({ pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' })
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d).slice(0, 200));
  const gen = await fetch(`http://localhost:${PORT}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `ezplm_session=${token}` },
    body: JSON.stringify({ jobId: d.jobId, patch: {} })
  });
  const gd = await gen.json();
  assert.equal(gd.sessionAuthenticated, true, 'Cookie 通道必须产生已认证会话');
  assert.equal(gd.authDiagnostics.tokenPresent, true);
  assert.equal(gd.authDiagnostics.devMode, false);
  assert.equal(gd.canPublishRole, true);
});

test('租户隔离：匿名身份创建的作业，换成真实 JWT 后访问被 403 拒绝', async () => {
  const prevMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'dev';
  let jobId;
  try {
    const r = await fetch(`http://localhost:${PORT}/api/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' })
    });
    jobId = (await r.json()).jobId;
  } finally { process.env.AUTH_MODE = prevMode; }
  // 真实 JWT 的 tenantId 是 smoke-tenant，作业却属于 dev
  const gen = await call('/api/generate', { jobId, patch: {} }, PUB());
  assert.equal(gen.status, 403);
  assert.equal(gen.data.code, 'tenant_mismatch', '换令牌后必须重新提取，旧作业访问不了');
});
