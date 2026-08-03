// e2e/review-flow.spec.js — v0.8.7 item 12：真实页面 E2E（Playwright）。
// 相较 v0.8.6 的强化：
//   1) PostMessage 测试使用 **embed 模式 + 真实 nonce/jobId 握手**，不再条件跳过；
//   2) 页面确认 Figure 必须断言真实发生了 POST /api/figure-upload；
//   3) 新增/删除 Figure 与可选尺寸置 null 必须直接查数据库确认写入；
//   4) reloadJob 走 ?job=<id> 真实恢复（认证态 /api/job）；
//   5) ZIP 必须**严格等于** Manifest —— 多一个文件即失败。
//
// ⚠ 本仓库沙箱无法下载 Chromium（网络策略），本文件在 v0.8.7 交付时 **未运行**（NOT VERIFIED）。
//   在有外网机器运行：npx playwright install chromium && npm run e2e
import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const DB = process.env.JOBSTORE_FILE || '/tmp/ds2kicad-e2e.db';
const readJob = (jobId) => {
  const db = new DatabaseSync(DB);
  const row = db.prepare('SELECT ir_json, revision FROM jobs WHERE job_id = ?').get(jobId);
  const man = db.prepare('SELECT manifest_json, state FROM manifests WHERE job_id = ? ORDER BY revision DESC LIMIT 1').get(jobId);
  db.close();
  return row ? { ir: JSON.parse(row.ir_json), revision: Number(row.revision), manifest: man ? JSON.parse(man.manifest_json) : null, manifestState: man?.state } : null;
};

/** 捕获 API 响应与请求（用于断言 figure-upload 真实发生） */
function captureApi(page) {
  const seen = { extract: null, generate: null, uploads: [], jobLoads: [] };
  page.on('request', (r) => {
    if (r.url().endsWith('/api/figure-upload') && r.method() === 'POST') seen.uploads.push(JSON.parse(r.postData() || '{}'));
    if (r.url().includes('/api/job?')) seen.jobLoads.push(r.url());
  });
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/extract') && r.ok()) seen.extract = await r.json().catch(() => null);
    if (r.url().endsWith('/api/generate') && r.ok()) seen.generate = await r.json().catch(() => null);
  });
  return seen;
}

/** item 12①：真实 ezPLM 宿主页（embed 模式）——完成 nonce/jobId 握手并回 ACK */
const HOST_HTML = (childUrl, nonce, hostJobId) => `<!doctype html><html><body>
<iframe id="plugin" src="${childUrl}" style="width:1280px;height:900px;border:0"></iframe>
<script>
  window.__received = [];
  const nonce = ${JSON.stringify(nonce)};
  const hostJobId = ${JSON.stringify(hostJobId)};
  const frame = document.getElementById('plugin');
  frame.addEventListener('load', () => {
    // 宿主 → 插件：握手（携带 nonce + jobId）
    frame.contentWindow.postMessage({ type: 'ezplm:ds2kicad:handshake', nonce, jobId: hostJobId }, '*');
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'ezplm:ds2kicad:result') {
      window.__received.push(d);
      e.source.postMessage({ type: 'ezplm:ds2kicad:ack', jobId: d.jobId, nonce: d.nonce, receivedFiles: d.files?.entries?.length ?? 0 }, e.origin);
    }
  });
</script></body></html>`;

const MODES = [
  { name: 'Mock', env: { MOCK_MODE: '1' } },
  {
    name: 'Live-stub',
    env: {
      MOCK_MODE: '', GEMINI_API_KEY: 'stub',
      GEMINI_STUB: JSON.stringify({
        part: { mpn: 'LIVESTUB', manufacturer: 'StubCo', title: 'T', description_zh: 'D' },
        packages: [{ name: 'SOIC-8', type: 'SOIC', pinsetId: 'default', pinCount: 8, pitch: 1.27, bodyLength: 4.9, bodyWidth: 3.9, height: 1.75, leadSpan: 6, leadLength: 1, sourcePages: [12] }],
        recommendedPackageIndex: 0,
        pinsets: [{ id: 'default', pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `S${i + 1}`, type: 'passive', description: '' })) }],
        figures: [{ kind: 'block_diagram', title: 'Figure 1. Block Diagram', page: 2, bbox: [0.1, 0.1, 0.9, 0.5] }]
      })
    }
  },
  { name: 'Degraded', env: { MOCK_MODE: '', GEMINI_API_KEY: 'stub', GEMINI_STUB: 'throw:stubbed AI outage' } }
];

for (const mode of MODES) {
  test(`${mode.name}：全流程（真实服务端分支 + 数据库断言）`, async ({ page, request }) => {
    await request.post('/api/__test-env', { data: mode.env });
    const api = captureApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: /开始提取/ }).click();
    await expect(page.getByText(/器件信息确认/)).toBeVisible({ timeout: 60_000 });
    const jobId = api.extract.jobId;
    expect(jobId).toBeTruthy();
    if (mode.name === 'Live-stub') expect(api.extract.part.mpn).toBe('LIVESTUB');
    if (mode.name === 'Degraded') expect(api.extract.meta.mode).toBe('degraded');

    // 统一审核理由（item 6：服务端强制）
    await page.getByPlaceholder(/对照手册/).fill('E2E：对照手册 p.63 机械图核对');

    // ── 每类可编辑字段 ──
    await page.locator('.part-grid input').nth(0).fill('E2E-MPN');
    await page.locator('.part-grid input').nth(1).fill('E2E-Vendor');
    await page.locator('.part-grid input').nth(2).fill('E2E Title');
    await page.locator('.part-grid input').nth(3).fill('E2E 中文描述');

    await page.getByRole('button', { name: /② 管脚表/ }).click();
    await page.locator('.pin-table input').nth(1).fill('E2E_PIN');
    await page.locator('.pin-table input').nth(0).fill('101');
    await page.locator('.pin-table input').nth(3).fill('E2E 描述');
    await page.getByRole('button', { name: /添加管脚/ }).click();
    const lastRow = page.locator('.pin-table tbody tr').last();
    await lastRow.locator('input').nth(0).fill('900');
    await lastRow.locator('input').nth(1).fill('E2E_ADDED');
    await page.locator('.pin-table tbody tr').nth(1).getByRole('button', { name: '✕' }).click();

    // item 12③：可选尺寸置 null
    await page.getByRole('button', { name: /③ 封装/ }).click();
    await page.locator('.pkg-grid input').nth(2).fill('4.85');
    const leadWidth = page.locator('.pkg-grid input').nth(7);
    await leadWidth.fill('');

    // item 12②：确认 Figure 必须触发真实 figure-upload
    await page.getByRole('button', { name: /④ 图区截取/ }).click();
    const confirmBtn = page.getByRole('button', { name: /确认此图/ }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
    await confirmBtn.click();
    await expect.poll(() => api.uploads.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const up = api.uploads[api.uploads.length - 1];
    expect(up.jobId).toBe(jobId);
    expect(typeof up.pngBase64).toBe('string');
    expect(up.expectedRevision).toBeGreaterThan(0);

    // ── generate ──
    await page.getByRole('button', { name: /确认无误/ }).click();
    await expect(page.getByText(/在线预览/)).toBeVisible({ timeout: 60_000 });
    const gen = api.generate;
    expect(gen).toBeTruthy();

    // ── item 12③：数据库断言 ──
    const db = readJob(jobId);
    expect(db.revision).toBe(gen.revision);
    expect(db.ir.lifecycle.state).toBe(gen.state);
    expect(db.manifestState).toBe(gen.state);
    expect(db.manifest.revision).toBe(gen.revision);
    expect(db.ir.part.mpn).toBe('E2E-MPN');
    const dbPkg = db.ir.packages[0];
    expect(dbPkg.leadWidth).toBeNull();                       // 置 null 已写库
    expect(dbPkg.geometryNormalized).toBe(true);
    const dbPins = db.ir.pinsets[0].normalizedPins;
    expect(dbPins.some((p) => p.number === '900' && p.name === 'E2E_ADDED')).toBeTruthy();
    expect(dbPins.find((p) => p.number === '101')?.evidence?.number?.sourceType).toBe('reviewer');
    const dbFig = db.ir.figures.find((f) => f.confirmed);
    expect(dbFig.image?.objectKey).toBeTruthy();              // PNG 走对象存储
    expect(dbFig.imageBase64).toBeUndefined();                // IR 不得存 base64

    // ── item 12⑤：ZIP 严格等于 Manifest ──
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /打包下载 ZIP/ }).click();
    const zip = await JSZip.loadAsync(readFileSync(await (await dl).path()));
    const zipPaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir).sort();
    const expected = gen.assetFiles.map((f) => f.path).sort();
    expect(zipPaths).toEqual(expected);                       // 多一个文件即失败
    for (const f of gen.manifest.files) {
      const buf = Buffer.from(await zip.file(f.path).async('nodebuffer'));
      expect(createHash('sha256').update(buf).digest('hex')).toBe(f.sha256);
    }

    // ── item 12④：reloadJob 真实恢复 ──
    await page.goto(`/?job=${jobId}`);
    await expect(page.locator('.part-grid input').first()).toHaveValue('E2E-MPN', { timeout: 30_000 });
    expect(api.jobLoads.some((u) => u.includes(jobId))).toBeTruthy();
    const after = readJob(jobId);
    expect(after.revision).toBe(db.revision);
  });
}

// ── item 12①：PostMessage 必须在 embed + 真实握手下测，不允许条件跳过 ──
test('PostMessage v3：embed 模式真实握手 + 全文件字节可还原 + 宿主 ACK', async ({ page, request, baseURL }) => {
  await request.post('/api/__test-env', { data: { MOCK_MODE: '1' } });
  const nonce = `e2e-nonce-${Date.now()}`;
  const hostJobId = `host-${Date.now()}`;
  const childUrl = `${baseURL}/?embed=1`;
  await page.setContent(HOST_HTML(childUrl, nonce, hostJobId));

  const frame = page.frameLocator('#plugin');
  await frame.getByRole('button', { name: /开始提取/ }).click();
  await expect(frame.getByText(/器件信息确认/)).toBeVisible({ timeout: 60_000 });
  await frame.getByPlaceholder(/对照手册/).fill('E2E postMessage');
  await frame.getByRole('button', { name: /确认无误/ }).click();
  await expect(frame.getByText(/在线预览/)).toBeVisible({ timeout: 60_000 });

  // embed 模式下必须出现"发送到 ezPLM"，不允许跳过
  const sendBtn = frame.getByRole('button', { name: /发送到 ezPLM/ });
  await expect(sendBtn).toBeVisible();
  await sendBtn.click();

  await expect.poll(async () => (await page.evaluate(() => window.__received.length)), { timeout: 30_000 }).toBeGreaterThan(0);
  const msg = (await page.evaluate(() => window.__received))[0];
  expect(msg.version).toBe(3);
  expect(msg.nonce).toBe(nonce);                 // 真实握手 nonce 回传
  expect(msg.hostJobId).toBe(hostJobId);
  expect(msg.assetToken).toBeTruthy();
  expect(msg.manifest.files.length).toBe(msg.files.entries.length - 1);   // manifest.json 自身不入清单
  for (const e of msg.files.entries) {
    const buf = Buffer.from(e.content, e.encoding === 'base64' ? 'base64' : 'utf8');
    expect(createHash('sha256').update(buf).digest('hex')).toBe(e.sha256);
  }
  // 宿主 ACK 已被插件收到（UI 提示）
  await expect(frame.getByText(/收到宿主 ACK/)).toBeVisible({ timeout: 10_000 });
});
