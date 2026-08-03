// test/v082.test.js — v0.8.2 反例回归：以下全部必须 nonPromotable=true
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateBundle } from '../lib/kicadgen/index.js';
import { generateFootprint } from '../lib/kicadgen/footprint.js';
import { sanitizePackage, sanitizePinsDetailed, resolveFamily } from '../lib/validate.js';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { authenticate, issueDevSession } from '../lib/auth.js';
import { MOCK_TMUXL27518 } from '../lib/mock/tmuxl27518.js';

process.env.JOB_SECRET = process.env.JOB_SECRET || 'test-job-secret';
const pins = (n) => Array.from({ length: n }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
const SOIC = { name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6.0, leadLength: 1.0, height: 1.75 };
const withLp = (p) => ({ ...p, landPattern: { padW: 0.6, padL: 1.55, rowSpan: 5.4, sourcePage: 63 } });
const gen = (pkgRaw, pinList = pins(8), extra = {}) =>
  generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: sanitizePackage(pkgRaw), pins: pinList }], ...extra });

test('反例1：Mock 数据删除 mock 字段仍不可晋升（服务端 JobStore 恢复）', () => {
  const store = resetJobStoreForTests();
  const job = store.create({ ir: { part: MOCK_TMUXL27518.part, packages: MOCK_TMUXL27518.packages, pinsets: MOCK_TMUXL27518.pinsets, mock: true }, tenantId: 't1', ownerId: 'u1' });
  // v0.8.3：jobId 是不透明 UUID，客户端无法解码/篡改载荷
  assert.match(job.jobId, /^[0-9a-f]{8}-/);
  const opened = store.get(job.jobId);
  assert.equal(opened.ok, true);
  assert.equal(opened.job.ir.mock, true, 'mock 存服务端，客户端删不掉');
  const r = generateBundle({
    part: opened.job.ir.part, mock: opened.job.ir.mock,
    sessionAuthenticated: true, pinsReviewRequired: false,
    items: [{ pkg: sanitizePackage(withLp(SOIC)), pins: pins(8) }]
  });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('mock_data'));
  // 伪造 jobId 无法命中
  assert.equal(store.get('00000000-0000-0000-0000-000000000000').ok, false);
});

test('反例2：DSBGA 且客户端声称 family=dual → 服务端判定 bga、不可晋升', () => {
  const p = sanitizePackage({ ...SOIC, name: 'DSBGA-8', type: 'DSBGA', family: 'dual' });
  assert.equal(p.family, 'bga', '客户端 family 必须被忽略');
  assert.equal(p.familySupported, false);
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: p, pins: pins(8) }] });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('unsupported_package_family'));
  assert.equal(r.items[0].files.kicadMod, undefined, '不得产出封装文件');
});

test('反例3：LCCC / PLCC 不可晋升且不按 QFN 近似', () => {
  for (const type of ['LCCC', 'PLCC']) {
    const p = sanitizePackage({ ...SOIC, name: `${type}-20`, type, pinCount: 20, pitch: 1.27, bodyLength: 8.89, bodyWidth: 8.89 });
    assert.equal(p.family, 'lcc', `${type} 不应映射为 qfn`);
    assert.equal(p.familySupported, false);
    const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: p, pins: pins(20) }] });
    assert.equal(r.nonPromotable, true, type);
    assert.equal(r.items[0].files.kicadMod, undefined, `${type} 不得产出封装`);
  }
});

test('反例4：8 脚列表附加重复 7 脚 → 转换留痕且不可晋升', () => {
  const det = sanitizePinsDetailed([...pins(8), { number: '7', name: 'DUP', type: 'input' }]);
  assert.equal(det.pins.length, 8);
  assert.equal(det.reviewRequired, true);
  assert.ok(det.transformationLog.some((l) => l.op === 'duplicate_number_dropped' && l.number === '7'));
  assert.equal(det.rawPins.length, 9, 'rawPins 必须完整保留');
  const r = generateBundle({
    part: { mpn: 'T' }, pinsReviewRequired: det.reviewRequired,
    items: [{ pkg: sanitizePackage(withLp(SOIC)), pins: det.pins }]
  });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('pin_data_transformed_requires_review'));
});

test('反例5：leadWidth=99 → clamped 留痕且不可晋升', () => {
  const p = sanitizePackage({ ...withLp(SOIC), leadWidth: 99 });
  assert.equal(p.fieldProvenance.leadWidth.source, 'clamped');
  assert.equal(p.fieldProvenance.leadWidth.rawValue, 99);
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: p, pins: pins(8) }] });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('value_out_of_range_clamped'));
});

test('反例6：landPattern.padW=99 → 整份推荐焊盘弃用、留痕、不可晋升', () => {
  const p = sanitizePackage({ ...SOIC, landPattern: { padW: 99, padL: 1.55, rowSpan: 5.4 } });
  assert.equal(p.fieldProvenance['landPattern.padW'].source, 'clamped');
  assert.equal(p.fieldProvenance['landPattern.padW'].rawValue, 99);
  assert.equal(p.landPattern, null, '非法推荐焊盘必须弃用');
  assert.equal(p.landPatternSource, 'derived_by_rules');
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: p, pins: pins(8) }] });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('value_out_of_range_clamped'));
  assert.ok(r.reasons.includes('land_pattern_derived_not_from_datasheet'));
});

test('反例7：pinCount=8.6 → validation error、不四舍五入掩盖、不可晋升', () => {
  const p = sanitizePackage({ ...withLp(SOIC), pinCount: 8.6 });
  assert.ok(p.validationErrors.some((e) => e.field === 'pinCount' && e.error === 'must_be_integer'));
  assert.equal(p.fieldProvenance.pinCount.source, 'invalid');
  assert.equal(p.fieldProvenance.pinCount.rawValue, 8.6);
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false, items: [{ pkg: p, pins: pins(8) }] });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('validation_error'));
});

test('反例8：无 Datasheet Land Pattern → derived 标记且不可晋升', () => {
  const p = sanitizePackage(SOIC); // 无 landPattern
  assert.equal(p.landPatternSource, 'derived_by_rules');
  const r = gen(SOIC);
  assert.equal(r.items[0].assetFlags.footprintPadSource, 'derived_by_rules');
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('land_pattern_derived_not_from_datasheet'));
});

test('反例9：参数化近似 WRL 不得冒充正式 3D 资产', () => {
  const r = gen(withLp(SOIC));
  assert.equal(r.items[0].assetFlags.model3dKind, 'approximate_3d');
  assert.equal(r.items[0].assetFlags.model3dAuthoritative, false);
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('approximate_parametric_3d_not_vendor_step'));
});

test('2×3mm DFN 回归：文件名 == 内部 footprint 名 == WRL 引用名', () => {
  const pkg = sanitizePackage({ name: 'DFN-8', type: 'DFN', pinCount: 8, pitch: 0.5, bodyLength: 3.0, bodyWidth: 2.0, leadLength: 0.4, height: 0.75 });
  assert.equal(pkg.family, 'qfn');
  const r = generateBundle({ part: { mpn: 'ACME1' }, items: [{ pkg, pins: pins(8) }] });
  const it = r.items[0];
  const internal = /\(footprint "([^"]+)"/.exec(it.files.kicadMod)[1];
  const modelRef = /\(model "[^"]*?([^/"]+)\.wrl"/.exec(it.files.kicadMod)[1];
  const fileBase = it.names.kicadMod.replace(/\.kicad_mod$/, '');
  const wrlBase = it.names.wrl.replace(/\.wrl$/, '');
  assert.equal(internal, fileBase, `内部名 ${internal} != 文件名 ${fileBase}`);
  assert.equal(modelRef, wrlBase, `model 引用 ${modelRef} != WRL 文件名 ${wrlBase}`);
  assert.equal(fileBase, wrlBase);
  assert.match(fileBase, /2x3mm_P0\.5mm/, `名称应含 2x3mm：${fileBase}`);
  // 矩形分轴仍成立
  const pads = [...it.files.kicadMod.matchAll(/\(pad "\d+" smd \S+ \(at ([-\d.]+) ([-\d.]+)\)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  assert.notEqual(Math.max(...pads.map((p) => Math.abs(p.x))), Math.max(...pads.map((p) => Math.abs(p.y))));
});

test('item 1：/api/generate 拒绝客户端提交权威字段，只认 jobId + patch', async () => {
  // v0.8.3：作业访问必须已认证会话（dev 匿名不可操作作业）
  const KEY = 'v082-key';
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.AUTH_MODE = 'production';
  delete process.env.EZPLM_JWT_ISS; delete process.env.EZPLM_JWT_AUD;
  const { issueDevSession } = await import('../lib/auth.js');
  const TOKEN = issueDevSession({ sub: 'u1', name: 'T', tenantId: 't1', roles: ['reviewer'] }, KEY);
  const { default: generateHandler } = await import('../api/generate.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.all('/api/generate', (req, res) => generateHandler(req, res));
  const srv = app.listen(3971);
  const post = async (b) => {
    const r = await fetch('http://localhost:3971/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json() };
  };
  try {
    const store = resetJobStoreForTests();
    const sealed = store.create({
      ir: {
        part: { mpn: 'T' },
        packages: [{ ...sanitizePackage(withLp(SOIC)), packageId: 'pkg_1', pinsetId: 'default' }],
        pinsets: [{ id: 'default', pins: pins(8), normalizedPins: pins(8), rawPins: pins(8), transformationLog: [], reviewRequired: false }],
        mock: true
      },
      tenantId: 't1', ownerId: 'u1'
    });
    // 提交 part/items/mock → 拒绝
    for (const bad of [{ jobId: sealed.jobId, part: { mpn: 'FAKE' } }, { jobId: sealed.jobId, items: [] }, { jobId: sealed.jobId, mock: false }, { jobId: sealed.jobId, reviewer: 'attacker' }]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.data.code, 'client_authoritative_fields_rejected');
    }
    // 无 jobId → 拒绝
    assert.equal((await post({ patch: {} })).status, 400);
    // 伪造 jobId → 拒绝
    assert.equal((await post({ jobId: 'forged-not-a-uuid' })).status, 400);
    // 合法：jobId + patch，mock 由服务端恢复
    const ok = await post({ jobId: sealed.jobId, patch: { includePackageIds: ['pkg_1'] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.mock, true, 'mock 必须由服务端恢复');
    assert.equal(ok.data.nonPromotable, true);
    assert.ok(ok.data.reasons.includes('mock_data'));
  } finally {
    srv.close();
  }
});

test('item 2/10：reviewer 来自已认证会话；无会话时不可晋升', () => {
  const key = 'sess-secret';
  const prev = { s: process.env.EZPLM_JWT_SECRET, m: process.env.AUTH_MODE };
  process.env.EZPLM_JWT_SECRET = key;
  process.env.AUTH_MODE = 'production';
  try {
    const token = issueDevSession({ sub: 'u-42', name: '龚工', tenantId: 'eetree' }, key);
    const okAuth = authenticate({ headers: { authorization: `Bearer ${token}` } });
    assert.equal(okAuth.ok, true);
    assert.equal(okAuth.session.sub, 'u-42');
    assert.equal(okAuth.session.authenticated, true);
    // 无 token → 401
    assert.equal(authenticate({ headers: {} }).ok, false);
    // 伪造签名 → 401
    assert.equal(authenticate({ headers: { authorization: `Bearer ${token.slice(0, -3)}xxx` } }).ok, false);
    // Cookie 形式（BFF，浏览器不持密钥）
    assert.equal(authenticate({ headers: { cookie: `ezplm_session=${token}` } }).ok, true);
  } finally {
    process.env.EZPLM_JWT_SECRET = prev.s; process.env.AUTH_MODE = prev.m;
    if (prev.s === undefined) delete process.env.EZPLM_JWT_SECRET;
  }
  // 未认证会话 → 闸门阻断
  const r = generateBundle({ part: { mpn: 'T' }, sessionAuthenticated: false, pinsReviewRequired: false, items: [{ pkg: sanitizePackage(withLp(SOIC)), pins: pins(8) }] });
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('no_authenticated_ezplm_session'));
});

test('item 7：几何变换结构化留痕并阻断晋升；矩形 QFN 不再静默交换长宽', async () => {
  const { normalizeGeometryDetailed } = await import('../lib/kicadgen/geometry.js');
  const rect = normalizeGeometryDetailed({ name: 'DFN-8', type: 'DFN', family: 'qfn', pinCount: 8, pitch: 0.5, bodyLength: 2.0, bodyWidth: 3.0, leadLength: 0.4, height: 0.75 });
  assert.equal(rect.normalizedPackage.bodyLength, 2.0, '不得交换');
  assert.equal(rect.normalizedPackage.bodyWidth, 3.0);
  const junk = normalizeGeometryDetailed({ name: 'SOT-23-5', type: 'SOT-23-5', family: 'dual', pinCount: 5, pitch: 0.5, bodyLength: 0.5, bodyWidth: 0.5, leadSpan: 0.5, height: 0.5 });
  assert.ok(junk.transformations.length > 0);
  assert.ok(junk.transformations.every((t) => t.op && t.reason));
  const r = gen({ ...withLp(SOIC), name: 'SOT-23-5', type: 'SOT-23-5', pinCount: 5, bodyLength: 0.5, bodyWidth: 0.5, leadSpan: 0.5, height: 0.5 }, pins(5));
  assert.equal(r.nonPromotable, true);
  assert.ok(r.reasons.includes('geometry_transformation_applied'));
});

test('item 11/12：旧 EXTRACT_PROMPT 路径已删除；OCR 需求页不被丢弃', async () => {
  const { extractWithGemini } = await import('../lib/gemini.js');
  await assert.rejects(() => extractWithGemini({ pdfBase64: 'x', apiKey: 'k' }), /need 参数/);
  const { routeOcr, OCR_STATUS } = await import('../lib/ocr/router.js');
  const noWorker = await routeOcr(Buffer.from('x'), { profile: { pagesNeedingOcr: [7, 11] }, textPages: [{ page: 1, lines: [] }] });
  assert.equal(noWorker.status, OCR_STATUS.PENDING_NO_WORKER);
  assert.deepEqual(noWorker.mustKeepPages, [7, 11], '需 OCR 的机械图页必须保留');
  const worker = { available: true, recognize: async () => [{ page: 7, lines: [{ text: 'MECH', x: 1, y: 1, x1: 2, h: 8 }] }] };
  const done = await routeOcr(Buffer.from('x'), { profile: { pagesNeedingOcr: [7] }, textPages: [{ page: 1, lines: [] }], worker });
  assert.equal(done.status, OCR_STATUS.DONE);
  assert.ok(done.mergedPages.find((p) => p.page === 7));
});

test('对照：完全合规输入（手册 LP + 无变换 + 已认证 + 忽略 3D）不因闸门恒真而误判', () => {
  const r = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true,
    pinsReviewRequired: false,
    items: [{ pkg: sanitizePackage(withLp(SOIC)), pins: pins(8) }]
  });
  // 仅剩 approximate_3d 一条（本项目暂无厂商 STEP，这是真实且必要的阻断）
  // v0.8.5 item 5：缺字段级证据锚点 fail closed（仅 3D + 证据两条，无其他误报）
  assert.deepEqual(r.reasons.sort(), ['approximate_parametric_3d_not_vendor_step', 'package_field_evidence_unverified'].sort(), JSON.stringify(r.reasons));
});
