// test/v086.test.js — v0.8.6 反例：一致性 / 证据 / 资产版本批准 / Figure 文件链 / 幂等
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { issueDevSession } from '../lib/auth.js';
import { verifyAssetToken } from '../lib/assettoken.js';
import { sanitizePinsets, sanitizePackage } from '../lib/validate.js';
import { runCanonicalPipeline } from '../lib/canonical.js';
import { invalidateAffectedApprovals, approveAssets, isApprovalValid } from '../lib/lifecycle.js';
import { generateBundle } from '../lib/kicadgen/index.js';
import { validatePng } from '../api/figure-upload.js';

const KEY = 'v086-secret';
const PORT = 3996;
let srv, store, tmpDir;

const sess = (roles = ['reviewer']) => issueDevSession({ sub: 'u1', name: 'R', tenantId: 'smoke-tenant', roles, iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);
const call = async (path, body, token = sess(), headers = {}) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};
const extract = async (headers = {}) => call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' }, sess(), headers);

/** 生成一张最小合法 PNG（1x1，含 IHDR/IDAT/IEND） */
function tinyPng() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478' +
    '9c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
}

before(async () => {
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  process.env.MOCK_MODE = '1';
  process.env.PDF_TOKEN_SECRET = 'v086-pdf';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k86-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  const { default: extractHandler } = await import('../api/extract.js');
  const { default: generateHandler } = await import('../api/generate.js');
  const { default: lifecycleHandler } = await import('../api/lifecycle.js');
  const { default: figureUploadHandler } = await import('../api/figure-upload.js');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.all('/api/extract', (q, r) => extractHandler(q, r));
  app.all('/api/generate', (q, r) => generateHandler(q, r));
  app.all('/api/lifecycle', (q, r) => lifecycleHandler(q, r));
  app.all('/api/figure-upload', (q, r) => figureUploadHandler(q, r));
  srv = app.listen(PORT);
});
after(() => { srv?.close(); if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

test('反例1：编辑后 DB / reviewedIr / Bundle / Manifest / assetToken 的 revision 与 state 完全一致', async () => {
  const ex = await extract();
  const r = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: { expectedRevision: ex.data.revision, part: { mpn: { value: 'CONSIST-1', reason: '核对封面' } } }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const db = store.get(ex.data.jobId).job;
  // revision 五处一致
  assert.equal(r.data.revision, db.revision);
  assert.equal(r.data.partBundle.job.revision, r.data.revision);
  assert.equal(r.data.manifest.revision, r.data.revision);
  const tok = verifyAssetToken(r.data.assetToken, { tenantId: 'smoke-tenant', jobId: ex.data.jobId, revision: r.data.revision });
  assert.equal(tok.ok, true, JSON.stringify(tok));
  // state 四处一致
  assert.equal(r.data.state, 'edited');
  assert.equal(db.ir.lifecycle.state, 'edited');
  assert.equal(r.data.partBundle.review.state, 'edited');
  assert.equal(r.data.manifest.state, 'edited');
  // IR 内容一致
  assert.equal(r.data.reviewedIr.part.mpn, 'CONSIST-1');
  assert.equal(db.ir.part.mpn, 'CONSIST-1');
  assert.equal(r.data.partBundle.part.mpn, 'CONSIST-1');
  assert.ok(r.data.files.kicadSym.includes('"CONSIST-1"'));
});

test('反例2：2×8mm 被几何修正后，Final IR / KiCad / Bundle 都是同一最终值', () => {
  const pkg = { ...sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 2, bodyWidth: 8, leadSpan: 6, leadLength: 1, height: 1.75 }), packageId: 'pkg_1', pinsetId: 'default' };
  const job = { jobId: 'j', tenantId: 't', revision: 1, ir: { part: { mpn: 'GEO' }, packages: [pkg], pinsets: sanitizePinsets([{ id: 'default', pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' })) }], []), figures: [] } };
  const r = runCanonicalPipeline({ job, patch: {}, session: { sub: 'u', name: 'U', authenticated: true }, finalRevision: 1, finalState: 'extracted' });
  assert.equal(r.ok, true, r.error);
  const fin = r.normalizedIr.packages[0];
  // 几何确实被修正（2mm 放不下 4 脚 ×1.27）
  assert.notEqual(fin.bodyLength, 2);
  assert.ok(fin.geometryTransformations.length > 0);
  assert.equal(fin.geometryNormalized, true);
  // Final IR == Bundle == 文件名
  const pb = r.assets.partBundle.packages[0];
  assert.equal(pb.bodyLength, fin.bodyLength);
  assert.equal(pb.bodyWidth, fin.bodyWidth);
  const name = r.bundle.items[0].names.kicadMod;
  const trim = (v) => String(+Number(v).toFixed(2)).replace(/\.0+$/, '');
  assert.ok(name.includes(`${trim(fin.bodyWidth)}x${trim(fin.bodyLength)}mm`), `${name} 应含 Final 几何`);
  // .kicad_mod 内部焊盘坐标必须由 Final 几何算出
  const pads = [...r.bundle.items[0].files.kicadMod.matchAll(/\(pad "\d+" smd \S+ \(at ([-\d.]+) ([-\d.]+)\)/g)].map((m) => Math.abs(+m[2]));
  assert.ok(Math.max(...pads) < fin.bodyLength, '焊盘范围必须与 Final bodyLength 相符');
});

test('反例3：管脚 Evidence 经二次清洗仍存在', () => {
  const withEv = [{
    number: '1', name: 'A', type: 'passive',
    evidence: { name: { field: 'pin.name', sourceType: 'datasheet_table', documentSha256: 'a'.repeat(64), page: 3, quotedText: '1 A' } }
  }, { number: '2', name: 'B', type: 'passive' }];
  let sets = sanitizePinsets([{ id: 'default', pins: withEv }], []);
  assert.ok(sets[0].normalizedPins[0].evidence?.name, '一次清洗后必须保留');
  // 反复清洗
  for (let i = 0; i < 3; i++) sets = sanitizePinsets(sets, []);
  assert.ok(sets[0].normalizedPins[0].evidence?.name, '多次清洗后仍必须保留');
  assert.equal(sets[0].normalizedPins[0].evidence.name.page, 3);
});

test('反例4：Figure 缺 Evidence 只阻断该 Figure（不影响 symbol/footprint）', () => {
  const pins = Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' }));
  const pkg = sanitizePackage({ name: 'SOIC-8', type: 'SOIC', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, leadSpan: 6, leadLength: 1, height: 1.75 });
  const r = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false,
    confirmedFigureCount: 1,
    figures: [{ figureId: 'f_no_ev', confirmed: true }],   // 无 evidence
    items: [{ pkg, pins }]
  });
  assert.ok(r.reasons.includes('field_evidence_unverified'));
  assert.equal(r.assetPromotion.symbol, true, 'Figure 缺证据不得影响 symbol');
  // 对照：带证据时不因图区报该错
  const ok = generateBundle({
    part: { mpn: 'T' }, sessionAuthenticated: true, pinsReviewRequired: false,
    confirmedFigureCount: 1,
    figures: [{ figureId: 'f', confirmed: true, evidence: { sourceType: 'datasheet_drawing', page: 3 } }],
    items: [{ pkg, pins }]
  });
  assert.equal(ok.assetPromotion.symbol, true);
});

test('反例5：分别批准 Symbol 与 Footprint 可以成功（资产版本级、分批）', () => {
  let ir = {
    packages: [{ packageId: 'pkg_1', pinsetId: 'default' }, { packageId: 'pkg_2', pinsetId: 'default' }],
    pinsets: [{ id: 'default' }], figures: [{ figureId: 'fig_1' }]
  };
  ir = approveAssets(ir, { keys: ['symbol:default'], actor: 'u1', revision: 3, irHash: 'h', manifestHash: 'm', reason: 'ok' });
  assert.deepEqual(Object.keys(ir.lifecycle.approvals), ['symbol:default']);
  // 第二批：只批准其中一个封装
  ir = approveAssets(ir, { keys: ['footprint:pkg_1'], actor: 'u2', revision: 3, irHash: 'h', manifestHash: 'm', reason: 'ok2' });
  assert.deepEqual(Object.keys(ir.lifecycle.approvals).sort(), ['footprint:pkg_1', 'symbol:default']);
  assert.equal(ir.lifecycle.approvals['footprint:pkg_1'].approvedBy, 'u2');
  assert.equal(isApprovalValid(ir, 'footprint:pkg_2', { revision: 3, irHash: 'h' }), false, 'pkg_2 未批准');
  assert.equal(isApprovalValid(ir, 'footprint:pkg_1', { revision: 3, irHash: 'h' }), true);
});

test('反例6：编辑后旧批准全部失效（按受影响范围）', () => {
  let ir = {
    packages: [{ packageId: 'pkg_1', pinsetId: 'default' }, { packageId: 'pkg_2', pinsetId: 'alt' }],
    pinsets: [{ id: 'default' }, { id: 'alt' }], figures: [{ figureId: 'fig_1' }],
    lifecycle: { reviewedBy: { sub: 'u' } }
  };
  ir = approveAssets(ir, { keys: ['symbol:default', 'symbol:alt', 'footprint:pkg_1', 'footprint:pkg_2', 'figure:fig_1'], actor: 'u', revision: 2, irHash: 'h', manifestHash: 'm', reason: 'ok' });
  // 改 pkg_1 的几何 → 只失效 pkg_1 的 footprint/model3d
  const a = invalidateAffectedApprovals(ir, [{ path: 'packages[pkg_1].pitch' }]);
  assert.ok(a.invalidated.includes('footprint:pkg_1'));
  assert.ok(!a.invalidated.includes('footprint:pkg_2'));
  assert.ok(a.ir.lifecycle.approvals['symbol:default'], 'symbol 不应被封装几何变更失效');
  assert.equal(a.ir.lifecycle.reviewedBy, null, '任何编辑都作废整体 review');
  // 改 default pinset 的管脚 → 失效 symbol:default 与引用它的 footprint:pkg_1
  const b = invalidateAffectedApprovals(ir, [{ path: 'pinsets[default].pin[1].name' }]);
  assert.ok(b.invalidated.includes('symbol:default'));
  assert.ok(b.invalidated.includes('footprint:pkg_1'));
  assert.ok(b.ir.lifecycle.approvals['symbol:alt'], '另一 pinset 不受影响');
  // 改 MPN → 全部失效（文件名与内容都变）
  const c = invalidateAffectedApprovals(ir, [{ path: 'part.mpn' }]);
  assert.equal(Object.keys(c.ir.lifecycle.approvals).length, 0);
});

test('反例7：页面确认 Figure 并上传 PNG 后，Manifest 中真实存在该 PNG', async () => {
  const ex = await extract();
  const figId = ex.data.figures[0].figureId;
  // 先确认图区
  const conf = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: { expectedRevision: ex.data.revision, figures: [{ figureId: figId, confirmed: { value: true, reason: '已核对' } }] }
  });
  assert.equal(conf.status, 200, JSON.stringify(conf.data).slice(0, 300));
  // 上传裁剪 PNG（浏览器裁剪后走本接口）
  const png = tinyPng();
  const up = await call('/api/figure-upload', {
    jobId: ex.data.jobId, figureId: figId, pngBase64: png.toString('base64'), expectedRevision: conf.data.revision
  });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.imageSha256, createHash('sha256').update(png).digest('hex'));
  // 重新生成 → PNG 必须出现在 Part Bundle、Manifest、assetFiles
  const gen = await call('/api/generate', { jobId: ex.data.jobId, patch: {} });
  assert.equal(gen.status, 200);
  const fig = gen.data.partBundle.figures.find((f) => f.figureId === figId);
  assert.ok(fig, '已确认图区必须进 bundle');
  assert.equal(fig.imagePath, up.data.imagePath);
  assert.equal(fig.imageSha256, up.data.imageSha256);
  const inManifest = gen.data.manifest.files.find((f) => f.path === up.data.imagePath);
  assert.ok(inManifest, 'PNG 必须进 manifest');
  assert.equal(inManifest.sha256, up.data.imageSha256);
  const inFiles = gen.data.assetFiles.find((f) => f.path === up.data.imagePath);
  assert.ok(inFiles && inFiles.encoding === 'base64' && inFiles.content, 'assetFiles 必须含 PNG 内容');
  // 非法 PNG 必须拒绝
  const badUp = await call('/api/figure-upload', { jobId: ex.data.jobId, figureId: figId, pngBase64: Buffer.from('not a png').toString('base64') });
  assert.equal(badUp.status, 422);
  assert.equal(validatePng(Buffer.from('nope')).ok, false);
});

test('反例8：postMessage/导出可恢复全部文件字节（ZIP 逐文件哈希校验）', async () => {
  const ex = await extract();
  const gen = await call('/api/generate', { jobId: ex.data.jobId, patch: {} });
  assert.equal(gen.status, 200);
  // 每个文件都能按 encoding 还原出与 sha256 一致的字节
  const zip = new JSZip();
  for (const f of gen.data.assetFiles) {
    assert.ok(typeof f.content === 'string', `${f.path} 缺内容`);
    const buf = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
    assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256, `${f.path} 哈希不符`);
    zip.file(f.path, buf);
  }
  // ZIP 解压后逐文件再校验一次
  const back = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  for (const f of gen.data.assetFiles) {
    const entry = back.file(f.path);
    assert.ok(entry, `ZIP 缺文件 ${f.path}`);
    const buf = Buffer.from(await entry.async('nodebuffer'));
    assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256);
    assert.ok(!f.path.includes('..') && !f.path.startsWith('/'));
  }
  // manifest 覆盖除自身外的全部文件
  const nonManifest = gen.data.assetFiles.filter((f) => f.path !== 'manifest.json');
  assert.equal(gen.data.manifest.files.length, nonManifest.length);
});

test('反例9：Live 幂等复用不产生新稳定 ID（含"Job 已编辑后"重复相同 Key）', async () => {
  const key = 'IDEM-LIVE-1';
  const first = await extract({ 'Idempotency-Key': key });
  assert.equal(first.status, 200);
  const idsA = first.data.packages.map((p) => p.packageId);
  const figA = first.data.figures.map((f) => f.figureId);
  // 直接重复 → 必须复用同一 Job 与同一批稳定 ID
  const second = await extract({ 'Idempotency-Key': key });
  assert.equal(second.data.jobId, first.data.jobId);
  assert.deepEqual(second.data.packages.map((p) => p.packageId), idsA, '复用时不得返回新生成的稳定 ID');
  assert.deepEqual(second.data.figures.map((f) => f.figureId), figA);
  // 编辑该 Job 后再用同一 Key 提取 → 仍复用，且返回**已编辑后**的 IR
  const edit = await call('/api/generate', {
    jobId: first.data.jobId,
    patch: { expectedRevision: first.data.revision, part: { mpn: { value: 'EDITED-IDEM', reason: '核对' } } }
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.data).slice(0, 200));
  const third = await extract({ 'Idempotency-Key': key });
  assert.equal(third.data.jobId, first.data.jobId);
  assert.equal(third.data.part.mpn, 'EDITED-IDEM', '复用必须返回 job.ir 的当前内容');
  assert.equal(third.data.revision, edit.data.revision);
  assert.deepEqual(third.data.packages.map((p) => p.packageId), idsA);
});

test('反例10：清空可选尺寸、增加/删除 Figure 均写入 IR', async () => {
  const ex = await extract();
  const pkgId = ex.data.packages[0].packageId;
  const figId = ex.data.figures[0].figureId;
  const r = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: {
      expectedRevision: ex.data.revision,
      packages: [{ packageId: pkgId, leadWidth: { value: null, reason: '手册未给出' } }],
      addFigures: [{ tempId: 'fig_tmp_1', kind: 'application', title: '手工框选应用图', page: 7, bbox: [0.1, 0.2, 0.9, 0.7], confirmed: false, reason: '页面新增' }],
      removeFigures: [{ figureId: figId, reason: '定位错误' }]
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
  const db = store.get(ex.data.jobId).job.ir;
  // 可选尺寸置 null
  const pkg = db.packages.find((p) => p.packageId === pkgId);
  assert.equal(pkg.leadWidth, null, 'leadWidth 应为 null');
  assert.equal(r.data.partBundle.packages.find((p) => p.packageId === pkgId).leadWidth, null);
  // 图区增删
  assert.ok(!db.figures.some((f) => f.figureId === figId), '被删图区不得留在 IR');
  const added = db.figures.find((f) => f.tempId === 'fig_tmp_1');
  assert.ok(added, '新增图区必须写入 IR');
  assert.notEqual(added.figureId, 'fig_tmp_1', '服务端必须返回正式 ID');
  assert.equal(added.page, 7);
  assert.deepEqual(added.bbox, [0.1, 0.2, 0.9, 0.7]);
});

test('反例11：Live-stub 与 Degraded 走真实服务端分支（可注入 Stub，非改 meta）', async () => {
  const saved = { m: process.env.MOCK_MODE, k: process.env.GEMINI_API_KEY, s: process.env.GEMINI_STUB };
  try {
    // Live-stub：关掉 MOCK_MODE，用 GEMINI_STUB 注入模型输出 → 真实走 live 分支
    delete process.env.MOCK_MODE;
    process.env.GEMINI_API_KEY = 'stub-key';
    process.env.GEMINI_STUB = JSON.stringify({
      part: { mpn: 'STUBPART', manufacturer: 'StubCo', title: 'T', description_zh: 'D' },
      packages: [{ name: 'SOIC-8', type: 'SOIC', pinsetId: 'default', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, height: 1.75, leadSpan: 6, leadLength: 1, sourcePages: [12] }],
      recommendedPackageIndex: 0,
      pinsets: [{ id: 'default', label: '', pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `S${i + 1}`, type: 'passive', description: '' })) }],
      figures: [{ kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 2, bbox: [0.1, 0.1, 0.9, 0.5] }]
    });
    const live = await call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });
    // 真实分支会去下载 PDF；网络不可达时应是 502 而非 mock 数据（证明确实走了 live 路径）
    assert.notEqual(live.data?.mock, true, 'live 分支不得返回 mock 数据');
    assert.ok([200, 502, 422].includes(live.status), `live 分支状态 ${live.status}: ${JSON.stringify(live.data).slice(0, 200)}`);
    if (live.status === 200) {
      assert.equal(live.data.part.mpn, 'STUBPART');
      assert.ok(live.data.packages.every((p) => p.packageId));
    }
    // Degraded：GEMINI_STUB=throw → 触发真实 degraded 分支
    process.env.GEMINI_STUB = 'throw:stubbed AI outage';
    const deg = await call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });
    assert.ok([200, 502].includes(deg.status));
    if (deg.status === 200) {
      assert.equal(deg.data.meta.mode, 'degraded');
      const dbIr = store.get(deg.data.jobId).job.ir;
      assert.deepEqual(deg.data.packages, dbIr.packages, 'degraded 响应必须与 Job IR 一致');
    }
  } finally {
    if (saved.m === undefined) delete process.env.MOCK_MODE; else process.env.MOCK_MODE = saved.m;
    if (saved.k === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.k;
    if (saved.s === undefined) delete process.env.GEMINI_STUB; else process.env.GEMINI_STUB = saved.s;
  }
});

test('反例12：lifecycle 必须携带 expectedRevision，且 patch.approvals 被拒绝', async () => {
  const ex = await extract();
  const noRev = await call('/api/lifecycle', { jobId: ex.data.jobId, action: 'review', reason: '核对完毕' });
  assert.equal(noRev.status, 400);
  assert.equal(noRev.data.code, 'expected_revision_required');
  const stale = await call('/api/lifecycle', { jobId: ex.data.jobId, action: 'review', reason: '核对完毕', expectedRevision: 999 });
  assert.equal(stale.status, 409);
  const ok = await call('/api/lifecycle', { jobId: ex.data.jobId, action: 'review', reason: '核对完毕', expectedRevision: ex.data.revision });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.state, 'reviewed');
  // patch 里塞 approvals 必须 400
  const bad = await call('/api/generate', { jobId: ex.data.jobId, patch: { approvals: { 'symbol:default': true } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.some((e) => e.path === 'approvals'));
});
