// test/v0811.test.js — v0.8.11 反例：figure-upload 递增 revision 导致后续写操作恒 409
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetJobStoreForTests } from '../lib/jobstore.js';
import { resetObjectStoreForTests } from '../lib/objectstore.js';
import { issueDevSession } from '../lib/auth.js';
import { makePng } from './helpers-png.mjs';

const KEY = 'v0811-secret';
const PORT = 3994;
let srv, store, tmpDir;

const sess = (roles = ['reviewer']) => issueDevSession(
  { sub: 'u1', name: 'R', tenantId: 'smoke-tenant', roles, iss: 'https://ezplm.cn', aud: 'ds2kicad' }, KEY);
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
  process.env.PDF_TOKEN_SECRET = 'v0811-pdf';
  delete process.env.VERCEL; delete process.env.DATABASE_URL; delete process.env.NODE_ENV;
  tmpDir = mkdtempSync(join(tmpdir(), 'ds2k811-'));
  store = resetJobStoreForTests(join(tmpDir, 'jobs.db'));
  resetObjectStoreForTests();
  const { default: extractHandler } = await import('../api/extract.js');
  const { default: generateHandler } = await import('../api/generate.js');
  const { default: figureUploadHandler } = await import('../api/figure-upload.js');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.all('/api/extract', (q, r) => extractHandler(q, r));
  app.all('/api/generate', (q, r) => generateHandler(q, r));
  app.all('/api/figure-upload', (q, r) => figureUploadHandler(q, r));
  srv = app.listen(PORT);
});
after(() => { srv?.close(); if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

const extract = () => call('/api/extract', { pdfUrl: 'https://www.ti.com/lit/ds/symlink/x.pdf' });

/* ── 服务端契约：上传必然递增 revision，且必须把新版本号交还客户端 ── */

test('figure-upload 成功后 revision 递增，并在响应中返回新版本号', async () => {
  const ex = await extract();
  assert.equal(ex.status, 200, JSON.stringify(ex.data));
  const r0 = ex.data.revision;
  const figId = ex.data.figures[0].figureId;
  assert.ok(figId, 'mock 图区也必须带 figureId');

  const up = await call('/api/figure-upload', {
    jobId: ex.data.jobId, figureId: figId,
    pngBase64: makePng(8, 6).toString('base64'),
    expectedRevision: r0, page: 1, bbox: [0.1, 0.2, 0.9, 0.7]
  });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.revision, r0 + 1, '上传必然产生新 revision');
  assert.equal(store.get(ex.data.jobId).job.revision, r0 + 1);
});

test('复现缺陷：沿用上传前的 revision 再次写入 → 409 revision_conflict', async () => {
  const ex = await extract();
  const r0 = ex.data.revision;
  const figs = ex.data.figures;
  assert.ok(figs.length >= 2, '本用例需要至少两张图');

  const up1 = await call('/api/figure-upload', {
    jobId: ex.data.jobId, figureId: figs[0].figureId,
    pngBase64: makePng(4, 4).toString('base64'), expectedRevision: r0
  });
  assert.equal(up1.status, 200);

  // 页面若丢弃 up1.revision，继续用 r0 提交第二张图 —— 正是现场表现
  const up2 = await call('/api/figure-upload', {
    jobId: ex.data.jobId, figureId: figs[1].figureId,
    pngBase64: makePng(4, 4).toString('base64'), expectedRevision: r0
  });
  assert.equal(up2.status, 409);
  assert.equal(up2.data.code, 'revision_conflict');
  assert.equal(up2.data.currentRevision, up1.data.revision, '必须回传当前版本号供客户端自愈');

  // 生成同样被卡住（"点最下面的按钮没反应"）
  const gen = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: { schemaVersion: 'ds2kicad.review-patch.v1', expectedRevision: r0, includePackageIds: [ex.data.packages[0].packageId] }
  });
  assert.equal(gen.status, 409);
  assert.equal(gen.data.code, 'revision_conflict');
  assert.equal(gen.data.currentRevision, up1.data.revision);
});

test('修复后行为：沿用响应里的 revision，连续上传与生成均成功', async () => {
  const ex = await extract();
  let rev = ex.data.revision;
  for (const f of ex.data.figures.slice(0, 3)) {
    const up = await call('/api/figure-upload', {
      jobId: ex.data.jobId, figureId: f.figureId,
      pngBase64: makePng(5, 5).toString('base64'), expectedRevision: rev
    });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    rev = up.data.revision;                       // ← 客户端必须回写
  }
  const gen = await call('/api/generate', {
    jobId: ex.data.jobId,
    patch: { schemaVersion: 'ds2kicad.review-patch.v1', expectedRevision: rev, includePackageIds: [ex.data.packages[0].packageId] }
  });
  assert.equal(gen.status, 200, JSON.stringify(gen.data));
  assert.ok(Number.isInteger(gen.data.revision));
});

/* ── 客户端契约：结构化错误必须穿透 api.js ── */

test('api.js：409 的 code / currentRevision 必须挂到 Error 上（此前只剩 message）', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: '版本冲突：当前 2', code: 'revision_conflict', currentRevision: 2 }),
    { status: 409, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    const { apiGenerate } = await import('../src/api.js');
    await assert.rejects(
      () => apiGenerate({ jobId: 'j' }),
      (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, 'revision_conflict', '错误码必须穿透，否则客户端无法自愈');
        assert.equal(e.currentRevision, 2, 'currentRevision 必须穿透');
        assert.match(e.message, /版本冲突/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
