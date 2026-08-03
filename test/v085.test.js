// test/v085.test.js — v0.8.5 反例：真实 Handler 请求形状（不手工构造 IR 冒充 E2E）
// 所有 Job 都由 **真实 /api/extract handler** 创建，随后用真实 HTTP 请求走 /api/generate 与 /api/lifecycle。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { issueDevSession } from '../lib/auth.js';
import { verifyAssetToken } from '../lib/assettoken.js';

const KEY = 'v085-secret';
const PORT = 3995;
let srv, store, tmpDir;

const sess = (o) => issueDevSession({ iss: 'https://ezplm.cn', aud: 'ds2kicad', ...o }, KEY);
const REVIEWER = () => sess({ sub: 'u1', name: '审核员', tenantId: 'smoke-tenant', roles: ['reviewer'] });
const PUBLISHER = () => sess({ sub: 'u1', name: '发布员', tenantId: 'smoke-tenant', roles: ['publisher'] });

const call = async (path, body, token, headers = {}) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};

/** 通过**真实 extract handler**（mock 模式）建立 Job —— 这是浏览器实际会发出的请求形状 */
const extractViaHandler = async (token = REVIEWER(), headers = {}) =>
  call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' }, token, headers);

before(async () => {
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  process.env.MOCK_MODE = '1';
  process.env.PDF_TOKEN_SECRET = 'v085-pdf';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k85-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  const { default: extractHandler } = await import('../api/extract.js');
  const { default: generateHandler } = await import('../api/generate.js');
  const { default: lifecycleHandler } = await import('../api/lifecycle.js');
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.all('/api/extract', (q, r) => extractHandler(q, r));
  app.all('/api/generate', (q, r) => generateHandler(q, r));
  app.all('/api/lifecycle', (q, r) => lifecycleHandler(q, r));
  srv = app.listen(PORT);
});
after(() => { srv?.close(); if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

test('反例1：extract(mock) 真实 handler —— 单一 packages 字段且与库内 Job IR 完全一致', async () => {
  const r = await extractViaHandler();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.ok(d.jobId && d.revision === 1);
  assert.ok(Array.isArray(d.packages) && d.packages.length === 2);
  // 稳定 ID 必须存在（此前被第二个 packages 字段覆盖后丢失）
  assert.ok(d.packages.every((p) => p.packageId), JSON.stringify(d.packages.map((p) => p.packageId)));
  assert.ok(d.packages.every((p) => p.family && p.fieldProvenance));
  // 与库内 IR 逐字段一致
  const job = store.get(d.jobId).job;
  assert.deepEqual(d.packages, job.ir.packages);
  assert.deepEqual(d.pinsets, job.ir.pinsets);
  assert.deepEqual(d.figures, job.ir.figures);
  assert.equal(d.part.mpn, job.ir.part.mpn);
});

test('反例2：生成后 reviewedIr / 数据库 IR / Part Bundle / KiCad 完全一致', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  const pkgId = ex.data.packages[0].packageId;
  const pinId = ex.data.pinsets[0].normalizedPins[0].pinId;
  const figId = ex.data.figures[0].figureId;
  const r = await call('/api/generate', {
    jobId,
    patch: {
      schemaVersion: 'ds2kicad.review-patch.v1',
      expectedRevision: ex.data.revision,
      part: { mpn: 'CANON-1', manufacturer: 'CanonCo' },
      packages: [{ packageId: pkgId, bodyLength: 4.2 }],
      pinsets: [{ pinsetId: ex.data.pinsets[0].id, pins: [{ pinId, name: 'RENAMED' }] }],
      figures: [{ figureId: figId, confirmed: true }]
    }
  }, REVIEWER());
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
  const d = r.data;
  const dbIr = store.get(jobId).job.ir;
  // reviewedIr == 数据库 IR
  assert.equal(d.reviewedIr.part.mpn, dbIr.part.mpn);
  assert.equal(dbIr.part.mpn, 'CANON-1');
  assert.equal(d.revision, store.get(jobId).job.revision);
  // Part Bundle == IR
  assert.equal(d.partBundle.part.mpn, 'CANON-1');
  assert.equal(d.partBundle.packages.find((p) => p.packageId === pkgId).bodyLength, 4.2);
  assert.equal(d.partBundle.pinsets[0].normalizedPins.find((p) => p.pinId === pinId).name, 'RENAMED');
  // KiCad == IR
  assert.ok(d.files.kicadSym.includes('"CANON-1"'));
  assert.ok(d.files.kicadSym.includes('"RENAMED"'));
  // 状态机推进
  assert.equal(d.state, 'edited');
  // item 8：Part Bundle 含完整 normalized package 与审批状态
  const pb = d.partBundle.packages[0];
  for (const f of ['pitch', 'bodyLength', 'bodyWidth', 'height', 'landPatternSource', 'fieldProvenance', 'relevantFields']) {
    assert.ok(pb[f] !== undefined, `part-bundle 缺字段 ${f}`);
  }
  assert.ok(d.partBundle.review.state && d.partBundle.review.approvals !== undefined);
});

test('反例3：生成失败不得修改 Job', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  const before = store.get(jobId).job;
  // 越界数值 → 400，Job 必须原样
  const bad = await call('/api/generate', {
    jobId, patch: { packages: [{ packageId: ex.data.packages[0].packageId, pitch: 99 }] }
  }, REVIEWER());
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.ok(bad.data.errors.some((e) => /超出允许范围/.test(e.error)));
  const after = store.get(jobId).job;
  assert.equal(after.revision, before.revision, 'revision 不得变化');
  assert.deepEqual(after.ir, before.ir, 'IR 不得变化');
});

test('反例4：expectedRevision 过期 → 409，且不修改 Job', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  const ok = await call('/api/generate', {
    jobId, patch: { expectedRevision: 1, part: { mpn: 'FIRST' } }
  }, REVIEWER());
  assert.equal(ok.status, 200);
  assert.equal(ok.data.revision, 2);
  const stale = await call('/api/generate', {
    jobId, patch: { expectedRevision: 1, part: { mpn: 'STALE' } }
  }, REVIEWER());
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'revision_conflict');
  assert.equal(store.get(jobId).job.ir.part.mpn, 'FIRST', '冲突请求不得写入');
});

test('反例5：状态机 —— review/approve/publish 为独立 API 且权限分离', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  // publisher 直接 publish（未 approve）→ 409
  const early = await call('/api/lifecycle', { jobId, action: 'publish', assets: [`symbol:${ex.data.pinsets[0].id}`], reason: '尝试', expectedRevision: ex.data.revision }, PUBLISHER());
  assert.equal(early.status, 409, JSON.stringify(early.data));
  // reviewer 执行 review
  const rev = await call('/api/lifecycle', { jobId, action: 'review', reason: '已核对手册', expectedRevision: ex.data.revision }, REVIEWER());
  assert.equal(rev.status, 200, JSON.stringify(rev.data));
  assert.equal(rev.data.state, 'reviewed');
  assert.equal(rev.data.lifecycle.reviewedBy.sub, 'u1');
  // publisher 无 reviewer 权限时不能 approve（publisher 隐含 reviewer，故此处用纯 editor 验证）
  const editorApprove = await call('/api/lifecycle', { jobId, action: 'approve', assets: [`symbol:${ex.data.pinsets[0].id}`], reason: 'x', expectedRevision: rev.data.revision },
    sess({ sub: 'u1', tenantId: 'smoke-tenant', roles: ['editor'] }));
  assert.equal(editorApprove.status, 403);
  // mock 数据全局阻断 → approve 任何资产都应 409（闸门未通过）
  const approveMock = await call('/api/lifecycle', { jobId, action: 'approve', assets: [`symbol:${ex.data.pinsets[0].id}`], reason: '批准', expectedRevision: rev.data.revision }, REVIEWER());
  assert.equal(approveMock.status, 409, JSON.stringify(approveMock.data));
  assert.equal(approveMock.data.code, 'asset_not_promotable');
});

test('反例6：canPublish 依赖持久化批准状态，不只看角色', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  const r = await call('/api/generate', { jobId, patch: {} }, PUBLISHER());
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.canPublish, 'object');
  // v0.8.6：资产版本键；未 approve → 即便 publisher 也全 false
  assert.ok(Object.keys(r.data.canPublish).every((k) => k.includes(':')));
  assert.ok(Object.values(r.data.canPublish).every((v) => v === false));
});

test('反例7：删除 Evidence 不得反而可晋升（EvidenceGate fail closed）', async () => {
  const { generateBundle } = await import('../lib/kicadgen/index.js');
  const { sanitizePackage } = await import('../lib/validate.js');
  const { makeAnchor, SOURCE_TYPE } = await import('../lib/evidence.js');
  const pins = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const base = { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6, leadLength: 1, height: 1.75, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } };
  const full = (extra = {}) => {
    const p = sanitizePackage(base);
    const anchor = (f) => makeAnchor({ field: f, sourceType: SOURCE_TYPE.DATASHEET_DRAWING, documentSha256: 'a'.repeat(64), page: 62, bbox: [0, 0, 1, 1], extractor: 'x' });
    p.evidence = Object.fromEntries([...p.relevantFields, 'landPattern.padW', 'landPattern.padL', 'landPattern.rowSpan'].map((f) => [f, anchor(f)]));
    return { ...p, ...extra };
  };
  const gen = (pkg) => generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false,
    confirmedFigureCount: 1, figures: [{ figureId: 'f', confirmed: true, evidence: { sourceType: 'datasheet_drawing' } }],
    items: [{ pkg, pins }]
  });
  // 完整证据 → footprint 可晋升
  const good = gen(full());
  assert.equal(good.assetPromotion.footprint, true, JSON.stringify(good.reasons));
  // 删除全部 evidence → 必须阻断（不能"删了反而过"）
  const stripped = gen({ ...full(), evidence: {} });
  assert.equal(stripped.assetPromotion.footprint, false);
  assert.ok(stripped.reasons.includes('field_evidence_unverified'));
  // evidence 设为 null → 同样阻断
  const nulled = gen({ ...full(), evidence: null });
  assert.equal(nulled.assetPromotion.footprint, false);
  // 只删 landPattern 的证据 → 也必须阻断
  const noLp = full();
  delete noLp.evidence['landPattern.padW'];
  assert.equal(gen(noLp).assetPromotion.footprint, false, '缺 landPattern 证据必须阻断');
});

test('反例8：资产阻断范围 —— 几何问题不影响 symbol，管脚问题影响 symbol，图区问题只影响 figures', async () => {
  const { generateBundle } = await import('../lib/kicadgen/index.js');
  const { sanitizePackage } = await import('../lib/validate.js');
  const pins = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const base = { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6, leadLength: 1, height: 1.75 };
  // 几何证据缺失（无 landPattern、无 evidence）→ symbol 仍可晋升
  const geo = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false,
    confirmedFigureCount: 1, figures: [{ figureId: 'f', confirmed: true, evidence: {} }],
    items: [{ pkg: sanitizePackage(base), pins }]
  });
  assert.equal(geo.assetPromotion.symbol, true, JSON.stringify(geo.reasons));
  assert.equal(geo.assetPromotion.footprint, false);
  assert.equal(geo.assetPromotion.figures, true, '几何问题不得影响 figures');
  // 管脚问题 → symbol 被阻断
  const pin = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: true,
    confirmedFigureCount: 1, figures: [{ figureId: 'f', confirmed: true, evidence: {} }],
    items: [{ pkg: sanitizePackage(base), pins }]
  });
  assert.equal(pin.assetPromotion.symbol, false);
  assert.equal(pin.assetPromotion.figures, true, '管脚问题不得影响 figures');
  // 图区问题 → 只影响 figures
  const fig = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false,
    confirmedFigureCount: 0, figures: [],
    items: [{ pkg: sanitizePackage(base), pins }]
  });
  assert.equal(fig.assetPromotion.figures, false);
  assert.equal(fig.assetPromotion.symbol, true, '图区问题不得影响 symbol');
});

test('反例9：postMessage/导出获得真实文件内容 + 绑定 tenant/job/revision 的短期令牌', async () => {
  const ex = await extractViaHandler();
  const r = await call('/api/generate', { jobId: ex.data.jobId, patch: {} }, REVIEWER());
  assert.equal(r.status, 200);
  // item 9：不能只有 path/hash/bytes —— 必须带真实内容
  assert.ok(r.data.assetFiles.length > 0);
  for (const f of r.data.assetFiles) {
    assert.equal(typeof f.content, 'string', `${f.path} 缺少真实内容`);
    assert.ok(f.content.length > 0);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  // 令牌与 tenant/job/revision 绑定
  assert.equal(typeof r.data.assetToken, 'string');
  const v = verifyAssetToken(r.data.assetToken, { tenantId: 'smoke-tenant', jobId: ex.data.jobId, revision: r.data.revision });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(verifyAssetToken(r.data.assetToken, { jobId: '00000000-0000-0000-0000-000000000000' }).ok, false);
  assert.equal(verifyAssetToken(r.data.assetToken, { revision: 999 }).ok, false);
  assert.equal(verifyAssetToken(r.data.assetToken, { tenantId: 'other' }).ok, false);
});

test('反例10：Patch 数值越界直接拒绝（不 clamp）；figure/pin/evidence 各层严格校验', async () => {
  const ex = await extractViaHandler();
  const jobId = ex.data.jobId;
  const pkgId = ex.data.packages[0].packageId;
  const figId = ex.data.figures[0].figureId;
  const psId = ex.data.pinsets[0].id;
  const bad = [
    [{ packages: [{ packageId: pkgId, pitch: 99 }] }, /超出允许范围/],
    [{ packages: [{ packageId: pkgId, pinCount: 8.5 }] }, /整数/],
    [{ packages: [{ packageId: pkgId, family: 'qfn' }] }, /只读/],
    [{ figures: [{ figureId: figId, confirmed: 'yes' }] }, /boolean/],
    [{ figures: [{ figureId: figId, page: 0 }] }, /正整数/],
    [{ figures: [{ figureId: figId, bbox: [0.9, 0.1, 0.2, 0.5] }] }, /bbox/],
    [{ figures: [{ figureId: figId, bbox: [0, 0, 1.2, 1] }] }, /bbox/],
    [{ pinsets: [{ pinsetId: psId, addPins: [{ number: '99', name: 'X', evil: 1 }] }] }, /未知字段/],
    [{ pinsets: [{ pinsetId: psId, removePins: [{ number: '1', bogus: 1 }] }] }, /未知字段/],
    [{ pinsets: [{ pinsetId: psId, resolveTransformations: { decision: 'accept_normalized' } }] }, /理由/],
    [{ packages: [{ packageId: pkgId, pitch: { value: 1.0, evidence: { hack: 1 } } }] }, /evidence 未知字段/]
  ];
  for (const [patch, re] of bad) {
    const r = await call('/api/generate', { jobId, patch }, REVIEWER());
    assert.equal(r.status, 400, `${JSON.stringify(patch)} → ${r.status}`);
    assert.ok(r.data.errors.some((e) => re.test(e.error)), `${JSON.stringify(patch)} → ${JSON.stringify(r.data.errors)}`);
  }
  // Job 未被任何一次非法请求修改
  assert.equal(store.get(jobId).job.revision, 1);
});

test('反例11：畸形 Cookie 不得抛异常，exp/nbf 只接受有限整数', async () => {
  const { authenticate } = await import('../lib/auth.js');
  const malformed = ['ezplm_session', '=v', 'a=%E0%A4%A', '; ; ;', 'x'.repeat(9000), 'ezplm_session=', 'ezplm_session=%%%'];
  for (const cookie of malformed) {
    let r;
    assert.doesNotThrow(() => { r = authenticate({ headers: { cookie } }); }, JSON.stringify(cookie.slice(0, 20)));
    assert.equal(r.ok, false);
  }
  const { createHmac } = await import('node:crypto');
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mk = (p) => { const h = b({ alg: 'HS256', typ: 'JWT' }), pl = b(p); return `${h}.${pl}.${Buffer.from(createHmac('sha256', KEY).update(`${h}.${pl}`).digest()).toString('base64url')}`; };
  const base = { sub: 'u', tenantId: 't', iss: 'https://ezplm.cn', aud: 'ds2kicad' };
  const now = Math.floor(Date.now() / 1000);
  for (const exp of ['not-a-number', String(now + 60), now + 60.5, Infinity, null]) {
    const r = authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp })}` } });
    assert.equal(r.ok, false, `exp=${JSON.stringify(exp)} 应被拒绝`);
  }
  assert.equal(authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp: now + 60 })}` } }).ok, true);
  assert.equal(authenticate({ headers: { authorization: `Bearer ${mk({ ...base, exp: now + 60, nbf: '123' })}` } }).ok, false);
});

test('反例12：degraded 形状的响应与 Job IR 一致（真实 handler 契约）', async () => {
  // 用真实 extract handler 走 mock 路径后，校验响应中每个必备键都来自 Job IR（无手工构造）
  const ex = await extractViaHandler();
  const job = store.get(ex.data.jobId).job;
  for (const key of ['packages', 'pinsets', 'figures']) {
    assert.deepEqual(ex.data[key], job.ir[key], `${key} 与 Job IR 不一致`);
  }
  assert.equal(ex.data.revision, job.revision);
  // 响应体中不得出现重复键导致的覆盖（JSON 解析后只剩最后一个，此处校验其确实带 packageId）
  assert.ok(ex.data.packages.every((p) => p.packageId && p.fieldProvenance));
});

test('v0.8.6 修复：EZPLM_JWT_SECRET 已配 + AUTH_MODE=dev 时，无 token 必须回退匿名并可访问作业', async () => {
  const { authenticate, authorizeJobAccess } = await import('../lib/auth.js');
  const saved = process.env.AUTH_MODE;
  try {
    // 关键回归：此前 dev 分支写在 `if (!key)` 内，两者同时配置时 dev 完全失效
    process.env.AUTH_MODE = 'dev';
    const r = authenticate({ headers: {} });
    assert.equal(r.ok, true, '配了密钥也应在 dev 模式放行匿名');
    assert.equal(r.session.authenticated, false);
    assert.equal(r.session.devMode, true);
    // 匿名会话必须能访问自己的作业（否则只能 extract 不能 generate）
    const az = authorizeJobAccess(r.session, { tenantId: 'dev', ownerId: 'dev-anonymous' });
    assert.equal(az.ok, true, JSON.stringify(az));
    // 但仍必须被闸门标记为不可晋升
    const { generateBundle } = await import('../lib/kicadgen/index.js');
    const { sanitizePackage } = await import('../lib/validate.js');
    const g = generateBundle({
      part: { mpn: 'T' }, sessionAuthenticated: r.session.authenticated === true, pinsReviewRequired: false,
      confirmedFigureCount: 1, figures: [{ figureId: 'f', confirmed: true, evidence: {} }],
      items: [{ pkg: sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6, leadLength: 1, height: 1.75 }), pins: [{ number: '1', name: 'A', type: 'passive' }] }]
    });
    assert.ok(g.reasons.includes('no_authenticated_ezplm_session'), 'dev 匿名结果必须不可晋升');
    // production 模式无 token 仍必须 401
    process.env.AUTH_MODE = 'production';
    assert.equal(authenticate({ headers: {} }).status, 401);
    // dev 模式下带了 token 仍走正常验签（伪造 token 必须拒绝）
    process.env.AUTH_MODE = 'dev';
    assert.equal(authenticate({ headers: { authorization: 'Bearer forged.token.here' } }).ok, false);
  } finally {
    process.env.AUTH_MODE = saved;
  }
});
