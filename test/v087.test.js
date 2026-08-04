// test/v087.test.js — v0.8.7 反例：空 Patch 持久化 / 资产版本审批 / published 保护 / Figure 文件链 / ZIP 严格等于 Manifest
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { resetObjectStoreForTests } from '../lib/objectstore.js';
import { issueDevSession } from '../lib/auth.js';
import { decodePngStrict } from '../lib/png.js';
import { makePng } from './helpers-png.mjs';

const KEY = 'v087-secret';
const PORT = 3998;
let srv, store, objects, tmpDir;

const sess = (roles = ['reviewer']) => issueDevSession({ sub: 'u1', name: 'R', tenantId: 'smoke-tenant', roles, iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);
const PUB = () => sess(['publisher']);
const call = async (path, body, token = sess()) => {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
};
const extract = async () => call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });

before(async () => {
  process.env.EZPLM_JWT_SECRET = KEY;
  process.env.EZPLM_JWT_ISS = 'https://ezplm.cn';
  process.env.EZPLM_JWT_AUD = 'ds2kicad';
  process.env.AUTH_MODE = 'production';
  process.env.MOCK_MODE = '1';
  process.env.PDF_TOKEN_SECRET = 'v087-pdf';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k87-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  objects = resetObjectStoreForTests();
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

/** 构造一个**非 mock、证据齐全**的作业（mock 数据按设计恒不可晋升，无法用于审批链路测试）。
 *  Job 由 store 直接创建（模拟 extract 产物），后续 patch / lifecycle 全部走真实 HTTP handler。 */
async function makeFullyEvidencedJob() {
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
  const figId = 'fig_1';
  const job = store.create({
    ir: {
      part: { mpn: 'EVI1', manufacturer: 'M', title: 'T', description_zh: 'D' },
      packages: [pkg], pinsets,
      figures: [{ figureId: figId, kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 3, bbox: [0.1, 0.1, 0.9, 0.5], confirmed: true, evidence: A('figure') }],
      mock: false, documentSha256: 'a'.repeat(64), pdfUrl: 'https://example.com/x.pdf'
    },
    tenantId: 'smoke-tenant', ownerId: 'u1', datasheetSha256: 'a'.repeat(64)
  });
  // 走真实 handler 完成一次归一化提交
  const gen = await call('/api/generate', { jobId: job.jobId, patch: {} });
  return { jobId: job.jobId, pkgId: 'pkg_1', figId, gen };
}

test('反例1：空 Patch 下 DB / reviewedIr / Bundle / KiCad / Manifest 的几何与 Hash 一致', async () => {
  const ex = await extract();
  const jobId = ex.data.jobId;
  // 完全空 Patch
  const r = await call('/api/generate', { jobId, patch: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const db = store.get(jobId).job;

  // item 1：几何归一化后的 Final IR **必须已持久化**
  const dbPkg = db.ir.packages[0];
  assert.equal(dbPkg.geometryNormalized, true, '数据库 IR 必须是归一化后的 Final IR');
  const irPkg = r.data.reviewedIr.packages[0];
  assert.deepEqual(
    ['pitch', 'bodyLength', 'bodyWidth', 'height', 'leadSpan', 'leadLength'].map((f) => dbPkg[f]),
    ['pitch', 'bodyLength', 'bodyWidth', 'height', 'leadSpan', 'leadLength'].map((f) => irPkg[f]),
    'DB IR 与 reviewedIr 几何必须一致'
  );
  // Bundle 与 KiCad 同源
  const pbPkg = r.data.partBundle.packages[0];
  for (const f of ['pitch', 'bodyLength', 'bodyWidth', 'height']) assert.equal(pbPkg[f], irPkg[f], `${f} 不一致`);
  const trim = (v) => String(+Number(v).toFixed(2)).replace(/\.0+$/, '');
  const modName = r.data.items[0].names.kicadMod;
  if (irPkg.family !== 'dip') assert.ok(modName.includes(`${trim(irPkg.bodyWidth)}x${trim(irPkg.bodyLength)}mm`), modName);
  // revision / hash 一致
  assert.equal(r.data.revision, db.revision);
  assert.equal(r.data.manifest.revision, r.data.revision);
  assert.equal(r.data.partBundle.job.revision, r.data.revision);
  assert.equal(r.data.manifest.irSha256, createHash('sha256').update(JSON.stringify(r.data.reviewedIr)).digest('hex'));
  // 独立 manifests 表落库
  const m = store.getManifest(jobId, r.data.revision);
  assert.ok(m, 'manifests 表必须有记录');
  assert.equal(m.state, r.data.state);
  assert.equal(m.irSha256, r.data.manifest.irSha256);
  // 再跑一次空 Patch：IR 已稳定，不应无限递增
  const r2 = await call('/api/generate', { jobId, patch: {} });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.revision, r.data.revision, '归一化后的空 Patch 不应再产生新 revision');
});

test('反例2：review → 批准 Symbol → 批准 Footprint → 分别 Publish 全部成功', async () => {
  const { jobId, pkgId, gen } = await makeFullyEvidencedJob();
  assert.equal(gen.status, 200, JSON.stringify(gen.data).slice(0, 300));
  const pinsetId = gen.data.reviewedIr.pinsets[0].id;
  let rev = gen.data.revision;

  const review = await call('/api/lifecycle', { jobId, action: 'review', reason: '已逐项核对手册', expectedRevision: rev });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.equal(review.data.state, 'reviewed');
  rev = review.data.revision;

  // 分批批准：先 symbol
  const apSym = await call('/api/lifecycle', { jobId, action: 'approve', assets: [`symbol:${pinsetId}`], reason: '符号已核对', expectedRevision: rev });
  assert.equal(apSym.status, 200, JSON.stringify(apSym.data).slice(0, 400));
  assert.ok(apSym.data.approvals[`symbol:${pinsetId}`]);
  rev = apSym.data.revision;
  // item 2：Approval 绑定的 revision 必须等于提交后的 Job revision
  assert.equal(apSym.data.approvals[`symbol:${pinsetId}`].revision, rev, 'Approval revision 必须等于提交后的 revision');

  // 再批准 footprint
  const apFp = await call('/api/lifecycle', { jobId, action: 'approve', assets: [`footprint:${pkgId}`], reason: '封装已核对', expectedRevision: rev });
  assert.equal(apFp.status, 200, JSON.stringify(apFp.data).slice(0, 400));
  rev = apFp.data.revision;
  assert.ok(apFp.data.approvals[`symbol:${pinsetId}`], '先前的 symbol 批准不得丢失');
  assert.ok(apFp.data.approvals[`footprint:${pkgId}`]);

  // 分别发布
  const pubSym = await call('/api/lifecycle', { jobId, action: 'publish', assets: [`symbol:${pinsetId}`], reason: '发布符号', expectedRevision: rev }, PUB());
  assert.equal(pubSym.status, 200, JSON.stringify(pubSym.data).slice(0, 400));
  rev = pubSym.data.revision;
  const pubFp = await call('/api/lifecycle', { jobId, action: 'publish', assets: [`footprint:${pkgId}`], reason: '发布封装', expectedRevision: rev }, PUB());
  assert.equal(pubFp.status, 200, JSON.stringify(pubFp.data).slice(0, 400));

  // AssetVersion 落独立表且带资产专属文件
  const avs = store.listAssetVersions(jobId);
  assert.equal(avs.length, 2, JSON.stringify(avs.map((a) => a.assetKey)));
  const fpAv = avs.find((a) => a.assetKey === `footprint:${pkgId}`);
  assert.ok(fpAv.files.length >= 1, 'AssetVersion 必须保存资产专属文件');
  assert.ok(fpAv.files.every((f) => /\.kicad_mod$/.test(f.path)), JSON.stringify(fpAv.files.map((f) => f.path)));
  assert.match(fpAv.versionId, new RegExp(`footprint:${pkgId}@r\\d+`));
});

test('反例3：每次 Lifecycle 后 Manifest 的 state/hash 与数据库 IR 一致', async () => {
  const { jobId, gen } = await makeFullyEvidencedJob();
  let rev = gen.data.revision;
  const review = await call('/api/lifecycle', { jobId, action: 'review', reason: '核对完毕', expectedRevision: rev });
  assert.equal(review.status, 200);
  rev = review.data.revision;
  const db = store.get(jobId).job;
  assert.equal(db.revision, rev);
  assert.equal(db.ir.lifecycle.state, 'reviewed');
  // Manifest 必须来自跃迁**后**的 IR
  const m = store.getManifest(jobId, rev);
  assert.ok(m, 'lifecycle 后必须写 manifest');
  assert.equal(m.state, 'reviewed', 'Manifest state 必须是跃迁后的状态');
  assert.equal(m.manifest.state, 'reviewed');
  assert.equal(m.manifest.revision, rev);
  assert.equal(review.data.manifest.state, 'reviewed');
});

test('反例4：published 后编辑被拒绝，或显式创建新 draft', async () => {
  const { jobId, pkgId, gen } = await makeFullyEvidencedJob();
  let rev = gen.data.revision;
  rev = (await call('/api/lifecycle', { jobId, action: 'review', reason: '核对', expectedRevision: rev })).data.revision;
  rev = (await call('/api/lifecycle', { jobId, action: 'approve', assets: [`footprint:${pkgId}`], reason: '批准', expectedRevision: rev })).data.revision;
  const pub = await call('/api/lifecycle', { jobId, action: 'publish', assets: [`footprint:${pkgId}`], reason: '发布', expectedRevision: rev }, PUB());
  assert.equal(pub.status, 200, JSON.stringify(pub.data).slice(0, 300));
  assert.equal(pub.data.state, 'published');
  rev = pub.data.revision;

  // 直接修改已发布封装 → 拒绝
  const denied = await call('/api/generate', {
    jobId, patch: { expectedRevision: rev, packages: [{ packageId: pkgId, bodyLength: { value: 4.2, reason: '修正' } }] }
  });
  assert.equal(denied.status, 409, JSON.stringify(denied.data).slice(0, 300));
  assert.equal(denied.data.code, 'published_asset_immutable');
  assert.equal(store.get(jobId).job.ir.lifecycle.state, 'published', '被拒绝的修改不得改变状态');

  // 带 allowDraftFork → 创建新 draft，且 state 不得仍为 published
  const forked = await call('/api/generate', {
    jobId, allowDraftFork: true, reason: '需要修正尺寸',
    patch: { expectedRevision: rev, packages: [{ packageId: pkgId, bodyLength: { value: 4.2, reason: '修正' } }] }
  });
  assert.equal(forked.status, 200, JSON.stringify(forked.data).slice(0, 400));
  assert.notEqual(forked.data.state, 'published', '修改成功后 state 不得仍为 published');
  assert.equal(forked.data.state, 'edited');
  const db = store.get(jobId).job;
  assert.equal(db.ir.lifecycle.state, 'edited');
  assert.ok(db.ir.draftOf, '必须记录 draft 来源');
  assert.ok(db.ir.draftOf.publishedSnapshot[`footprint:${pkgId}`], '旧发布记录必须留档');
  assert.equal(Object.keys(db.ir.lifecycle.approvals).length, 0, 'draft 不继承批准');
  // 已发布的 AssetVersion 仍不可变留存
  assert.ok(store.listAssetVersions(jobId).some((a) => a.assetKey === `footprint:${pkgId}`));
});

test('反例5：无理由的人工修改返回 400', async () => {
  const ex = await extract();
  const pkgId = ex.data.packages[0].packageId;
  const psId = ex.data.pinsets[0].id;
  const cases = [
    { packages: [{ packageId: pkgId, landPattern: { padW: 0.3 } }] },   // landPattern 无 reason/evidence
    { pinsets: [{ pinsetId: psId, addPins: [{ number: '900', name: 'X', type: 'input' }] }] },
    { pinsets: [{ pinsetId: psId, removePins: [{ number: '1' }] }] },
    { addFigures: [{ tempId: 't1', kind: 'application', title: 'X', page: 3, bbox: [0.1, 0.1, 0.9, 0.5] }] },
    { removeFigures: [{ figureId: ex.data.figures[0].figureId }] }
  ];
  for (const patch of cases) {
    const r = await call('/api/generate', { jobId: ex.data.jobId, patch });
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 120));
    assert.ok(r.data.errors.some((e) => /reason|理由/.test(e.error)), JSON.stringify(r.data.errors));
  }
  // 带理由则通过
  const ok = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: { pinsets: [{ pinsetId: psId, addPins: [{ number: '900', name: 'X', type: 'input', reason: '手册补充管脚' }] }] }
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data).slice(0, 300));
});

test('反例6：新增管脚与编号/类型修改都建立 Evidence 且经 sanitize 保留', async () => {
  const ex = await extract();
  const psId = ex.data.pinsets[0].id;
  const pinId = ex.data.pinsets[0].normalizedPins[0].pinId;
  const r = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: {
      expectedRevision: ex.data.revision,
      pinsets: [{
        pinsetId: psId,
        pins: [{ pinId, number: { value: '77', reason: '手册编号更正' }, type: { value: 'input', reason: '类型更正' }, name: { value: 'NEWNAME', reason: '名称更正' } }],
        addPins: [{ number: '901', name: 'ADDED', type: 'output', reason: '手册补充' }]
      }]
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
  const ps = r.data.reviewedIr.pinsets[0];
  const edited = ps.normalizedPins.find((p) => p.pinId === pinId);
  assert.equal(edited.number, '77');
  for (const f of ['number', 'type', 'name']) {
    assert.ok(edited.evidence?.[f], `修改的 ${f} 必须有 EvidenceAnchor`);
    assert.equal(edited.evidence[f].sourceType, 'reviewer');
    assert.ok(edited.evidence[f].reviewer?.sub);
  }
  const added = ps.normalizedPins.find((p) => p.number === '901');
  assert.ok(added, '新增管脚必须存在');
  assert.equal(added.reviewerAdded, true);
  // 数据库中经 sanitize 后仍保留
  const dbPs = store.get(ex.data.jobId).job.ir.pinsets[0];
  const dbPin = dbPs.normalizedPins.find((p) => p.pinId === pinId);
  assert.ok(dbPin.evidence?.number, 'sanitize 后必须保留 pin.evidence');
  assert.ok(dbPs.normalizedPins.find((p) => p.number === '901')?.reviewerAdded, 'sanitize 后必须保留 reviewerAdded');
  // Part Bundle 也带证据
  assert.ok(r.data.partBundle.pinsets[0].normalizedPins.find((p) => p.pinId === pinId).evidence?.number);
});

test('反例7：页面确认 Figure → 真实上传 → 进入 Manifest 与 ZIP', async () => {
  const { jobId, figId, gen } = await makeFullyEvidencedJob();
  const png = makePng(8, 6);
  const up = await call('/api/figure-upload', {
    jobId, figureId: figId, pngBase64: png.toString('base64'),
    expectedRevision: gen.data.revision, page: 3, bbox: [0.1, 0.2, 0.9, 0.7], documentSha256: 'd'.repeat(64)
  });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.width, 8);
  assert.equal(up.data.height, 6);
  assert.equal(up.data.imageSha256, createHash('sha256').update(png).digest('hex'));
  assert.ok(up.data.objectKey, '必须返回对象存储键');

  // item 8：IR 中不得存 base64
  const dbFig = store.get(jobId).job.ir.figures.find((f) => f.figureId === figId);
  assert.equal(dbFig.imageBase64, undefined, 'IR 不得存 PNG base64');
  assert.equal(dbFig.image.objectKey, up.data.objectKey);
  assert.equal(dbFig.image.page, 3);
  assert.deepEqual(dbFig.image.bbox, [0.1, 0.2, 0.9, 0.7]);
  assert.equal(dbFig.image.documentSha256, 'd'.repeat(64));

  // 重新 generate → PNG 进 Manifest + assetFiles
  const g = await call('/api/generate', { jobId, patch: {} });
  assert.equal(g.status, 200, JSON.stringify(g.data).slice(0, 300));
  const inManifest = g.data.manifest.files.find((f) => f.sha256 === up.data.imageSha256);
  assert.ok(inManifest, 'PNG 必须进入 Manifest');
  const inFiles = g.data.assetFiles.find((f) => f.path === inManifest.path);
  assert.equal(inFiles.encoding, 'base64');
  assert.equal(createHash('sha256').update(Buffer.from(inFiles.content, 'base64')).digest('hex'), up.data.imageSha256);
});

test('反例8：24 字节伪 PNG 被拒绝（完整解码校验）', async () => {
  const ex = await extract();
  const figId = ex.data.figures[0].figureId;
  const fake24 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);
  assert.equal(fake24.length, 24);
  assert.equal(decodePngStrict(fake24).ok, false);
  const r = await call('/api/figure-upload', { jobId: ex.data.jobId, figureId: figId, pngBase64: fake24.toString('base64'), expectedRevision: ex.data.revision });
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.equal(r.data.code, 'invalid_png');
  // 头正确但 IDAT 被破坏
  const good = makePng(4, 4);
  const broken = Buffer.from(good);
  broken[45] ^= 0xff;                                   // 破坏 IDAT 内容 → CRC 失败
  assert.equal(decodePngStrict(broken).ok, false);
  const r2 = await call('/api/figure-upload', { jobId: ex.data.jobId, figureId: figId, pngBase64: broken.toString('base64'), expectedRevision: ex.data.revision });
  assert.equal(r2.status, 422);
  // 缺 expectedRevision → 400
  const r3 = await call('/api/figure-upload', { jobId: ex.data.jobId, figureId: figId, pngBase64: good.toString('base64') });
  assert.equal(r3.status, 400);
  assert.equal(r3.data.code, 'expected_revision_required');
});

test('反例9：ZIP 文件集合严格等于 Manifest（不得多、不得少）', async () => {
  const { jobId, figId, gen } = await makeFullyEvidencedJob();
  await call('/api/figure-upload', { jobId, figureId: figId, pngBase64: makePng(6, 6).toString('base64'), expectedRevision: gen.data.revision, page: 3, bbox: [0.1, 0.1, 0.9, 0.6] });
  const g = await call('/api/generate', { jobId, patch: {} });
  assert.equal(g.status, 200);

  // 严格按服务端 assetFiles 打包（前端行为）
  const zip = new JSZip();
  for (const f of g.data.assetFiles) {
    zip.file(f.path, Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  const back = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  const zipPaths = Object.keys(back.files).filter((p) => !back.files[p].dir).sort();
  const expected = g.data.assetFiles.map((f) => f.path).sort();
  assert.deepEqual(zipPaths, expected, 'ZIP 集合必须与 assetFiles 严格相等');
  // manifest 覆盖除 manifest.json 自身外的全部文件
  const manifestPaths = g.data.manifest.files.map((f) => f.path).sort();
  assert.deepEqual(manifestPaths, expected.filter((p) => p !== 'manifest.json'), 'Manifest 必须严格覆盖其余文件');
  // 每个文件哈希一致
  for (const f of g.data.manifest.files) {
    const buf = Buffer.from(await back.file(f.path).async('nodebuffer'));
    assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256, f.path);
  }
  // 图区 PNG 确实在其中
  assert.ok(expected.some((p) => p.startsWith('figures/') && p.endsWith('.png')));
});

test('反例10：可选尺寸置 null 与 Figure 增删都写入数据库 IR', async () => {
  const ex = await extract();
  const pkgId = ex.data.packages[0].packageId;
  const figId = ex.data.figures[0].figureId;
  const r = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: {
      expectedRevision: ex.data.revision,
      packages: [{ packageId: pkgId, leadWidth: { value: null, reason: '手册未给出' } }],
      addFigures: [{ tempId: 'fig_tmp_x', kind: 'application', title: '新图', page: 9, bbox: [0.2, 0.3, 0.8, 0.8], confirmed: false, reason: '页面新增' }],
      removeFigures: [{ figureId: figId, reason: '定位错误' }]
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
  const db = store.get(ex.data.jobId).job.ir;
  assert.equal(db.packages.find((p) => p.packageId === pkgId).leadWidth, null);
  assert.ok(!db.figures.some((f) => f.figureId === figId));
  const added = db.figures.find((f) => f.tempId === 'fig_tmp_x');
  assert.ok(added && added.figureId !== 'fig_tmp_x', '临时 ID 必须换成服务端正式 ID');
  assert.equal(added.page, 9);
  // 二次 sanitize 后 null 仍保持
  const g2 = await call('/api/generate', { jobId: ex.data.jobId, patch: {} });
  assert.equal(g2.data.reviewedIr.packages.find((p) => p.packageId === pkgId).leadWidth, null);
});

test('反例11：reloadJob API 认证态恢复（?job= 场景）', async () => {
  const { default: jobHandler } = await import('../api/job.js');
  const app2 = express();
  app2.use(express.json());
  app2.all('/api/job', (q, r) => jobHandler(q, r));
  const s2 = app2.listen(4023);
  try {
    const ex = await extract();
    const edit = await call('/api/generate', { jobId: ex.data.jobId, patch: { expectedRevision: ex.data.revision, part: { mpn: { value: 'RELOADED', reason: '核对' } } } });
    assert.equal(edit.status, 200);
    const r = await fetch(`http://localhost:4023/api/job?jobId=${ex.data.jobId}`, { headers: { Authorization: `Bearer ${sess()}` } });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.part.mpn, 'RELOADED', '必须恢复最新 IR');
    assert.equal(d.revision, edit.data.revision);
    assert.equal(d.state, edit.data.state);
    assert.ok(d.packages.every((p) => p.packageId));
    // 未鉴权 401、跨租户 403
    assert.equal((await fetch(`http://localhost:4023/api/job?jobId=${ex.data.jobId}`)).status, 401);
    const other = issueDevSession({ sub: 'x', tenantId: 'other', roles: ['reviewer'], iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);
    assert.equal((await fetch(`http://localhost:4023/api/job?jobId=${ex.data.jobId}`, { headers: { Authorization: `Bearer ${other}` } })).status, 403);
  } finally {
    s2.close();
  }
});

test('反例12：Figure 上传使该 Figure 的旧批准失效', async () => {
  const { jobId, figId, pkgId, gen } = await makeFullyEvidencedJob();
  let rev = gen.data.revision;
  const up1 = await call('/api/figure-upload', { jobId, figureId: figId, pngBase64: makePng(5, 5).toString('base64'), expectedRevision: rev, page: 3, bbox: [0.1, 0.1, 0.9, 0.6] });
  assert.equal(up1.status, 200);
  rev = up1.data.revision;
  rev = (await call('/api/lifecycle', { jobId, action: 'review', reason: '核对', expectedRevision: rev })).data.revision;
  const ap = await call('/api/lifecycle', { jobId, action: 'approve', assets: [`figure:${figId}`, `footprint:${pkgId}`], reason: '批准图与封装', expectedRevision: rev });
  assert.equal(ap.status, 200, JSON.stringify(ap.data).slice(0, 400));
  rev = ap.data.revision;
  assert.ok(ap.data.approvals[`figure:${figId}`]);
  // 重新上传该 Figure 的 PNG → 其批准必须失效，另一资产不受影响
  const up2 = await call('/api/figure-upload', { jobId, figureId: figId, pngBase64: makePng(7, 7).toString('base64'), expectedRevision: rev, page: 3, bbox: [0.1, 0.1, 0.9, 0.6] });
  assert.equal(up2.status, 200, JSON.stringify(up2.data));
  const db = store.get(jobId).job.ir;
  assert.ok(!db.lifecycle.approvals[`figure:${figId}`], '重新上传必须使该 Figure 批准失效');
  assert.ok(db.lifecycle.approvals[`footprint:${pkgId}`], '不得波及其他资产的批准');
});

test('v0.8.8：新增 package_outline 图类型，且图区外扩留白避免裁切', async () => {
  const { filterFigures } = await import('../lib/figfilter.js');
  const { sanitizeFigures } = await import('../lib/validate.js');
  const { applyReviewPatch } = await import('../lib/reviewpatch.js');
  // 四类共存且各自入选
  const out = filterFigures([
    { kind: 'block_diagram', title: '图 7-2. 功能方框图', page: 23, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'pin_configuration', title: '图4-1. RTW 封装 24 引脚 WQFN 顶视图', page: 3, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'package_outline', title: 'PACKAGE OUTLINE / 封装外形图', page: 40, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'application', title: '典型应用', page: 1, bbox: [0.1, 0.1, 0.9, 0.5] },
    { kind: 'application', title: '图 9-2. 典型应用电路', page: 18, bbox: [0.1, 0.1, 0.9, 0.5] }
  ], { pkgCount: 2 });
  const kinds = out.map((f) => f.kind);
  for (const k of ['block_diagram', 'pin_configuration', 'package_outline', 'application']) {
    assert.ok(kinds.includes(k), `${k} 必须入选：${JSON.stringify(kinds)}`);
  }
  assert.equal(out.filter((f) => f.kind === 'application').length, 2, '应用图允许多张');
  // sanitize 保留新类型
  assert.equal(sanitizeFigures([{ kind: 'package_outline', page: 40, bbox: [0.1, 0.1, 0.9, 0.5] }])[0].kind, 'package_outline');
  // Patch 接受新类型
  const ir = { part: { mpn: 'A' }, packages: [], pinsets: [], figures: [{ figureId: 'f1', kind: 'application', page: 1, bbox: [0, 0, 1, 1], confirmed: false }] };
  const r = applyReviewPatch(ir, { figures: [{ figureId: 'f1', kind: { value: 'package_outline', reason: '实为封装图' } }] }, { reviewer: { sub: 'u', name: 'R' } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.ir.figures[0].kind, 'package_outline');
  // 非法类型仍拒绝
  assert.equal(applyReviewPatch(ir, { figures: [{ figureId: 'f1', kind: { value: 'nonsense', reason: 'x' } }] }, { reviewer: { sub: 'u', name: 'R' } }).ok, false);

  // 程序化定位的 bbox 必须带外扩留白
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const { extractTextPages } = await import('../lib/pdftext.js');
  const { findFigures } = await import('../lib/heuristics.js');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([612, 792]);
  pg.drawText('Figure 12. Functional Block Diagram', { x: 200, y: 420, size: 9, font });
  const { pages } = await extractTextPages(Buffer.from(await doc.save()));
  const figs = findFigures(pages);
  assert.ok(figs.length > 0);
  assert.ok(figs[0].bbox[0] <= 0.035, `左边界应外扩：${figs[0].bbox[0]}`);
  assert.ok(figs[0].bbox[2] >= 0.965, `右边界应外扩：${figs[0].bbox[2]}`);
  assert.ok(figs[0].bbox[0] >= 0 && figs[0].bbox[3] <= 1, 'bbox 必须仍在 [0,1]');
});

test('v0.8.8：倒序/退化 bbox 必须交换或扩为可用区域（原实现会裁出空白窄条）', async () => {
  const { sanitizeFigures } = await import('../lib/validate.js');
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  // y 轴倒序（AI 混淆左上/左下原点的典型形态）→ 交换，而不是外推成页底窄缝
  const inv = sanitizeFigures([{ kind: 'block_diagram', page: 23, bbox: [0.1, 0.9, 0.9, 0.1] }])[0].bbox;
  assert.deepEqual(inv, [0.1, 0.1, 0.9, 0.9]);
  assert.ok(area(inv) > 0.5, `倒序修复后面积过小：${area(inv)}`);
  // x 轴倒序
  const invX = sanitizeFigures([{ kind: 'application', page: 1, bbox: [0.9, 0.1, 0.1, 0.6] }])[0].bbox;
  assert.deepEqual(invX, [0.1, 0.1, 0.9, 0.6]);
  // 完全退化（零面积）→ 给可用最小区域
  const deg = sanitizeFigures([{ kind: 'application', page: 1, bbox: [0.5, 0.5, 0.5, 0.5] }])[0].bbox;
  assert.ok(deg[2] - deg[0] >= 0.4 && deg[3] - deg[1] >= 0.3, JSON.stringify(deg));
  assert.ok(deg.every((v) => v >= 0 && v <= 1));
  // 正常 bbox 不被改动
  assert.deepEqual(sanitizeFigures([{ kind: 'application', page: 1, bbox: [0.1, 0.1, 0.9, 0.6] }])[0].bbox, [0.1, 0.1, 0.9, 0.6]);
});
