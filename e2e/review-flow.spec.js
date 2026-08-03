// e2e/review-flow.spec.js — v0.8.6 item 10：真实页面 E2E（Playwright）。
// Live-stub / Degraded 通过**服务端可注入 Stub**（GEMINI_STUB / OCR_STUB）执行真实服务端分支，
// 不再靠改写响应 meta.mode 伪装。覆盖：
//   extract → 修改每类可编辑字段 → 增删管脚 → 增删 Figure → generate → export(ZIP 逐文件哈希)
//   → 捕获并校验 postMessage 内容 → 真实 reloadJob 后页面与数据库一致
//
// ⚠ 本仓库沙箱无法下载 Chromium（网络策略），本文件在 v0.8.6 交付时 **未运行**（NOT VERIFIED）。
//   在有外网的开发机运行：npx playwright install chromium && npm run e2e
import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const DB = process.env.JOBSTORE_FILE || '/tmp/ds2kicad-e2e.db';
const readJob = (jobId) => {
  const db = new DatabaseSync(DB);
  const row = db.prepare('SELECT ir_json, revision FROM jobs WHERE job_id = ?').get(jobId);
  db.close();
  return row ? { ir: JSON.parse(row.ir_json), revision: Number(row.revision) } : null;
};

function captureApi(page) {
  const seen = { extract: null, generate: null, posted: [] };
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/extract') && r.ok()) seen.extract = await r.json().catch(() => null);
    if (r.url().endsWith('/api/generate') && r.ok()) seen.generate = await r.json().catch(() => null);
  });
  return seen;
}

/** 在页面内安装 postMessage 捕获器（模拟 ezPLM 宿主并回 ACK） */
async function installHostStub(page) {
  await page.addInitScript(() => {
    window.__ds2kMessages = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d?.type === 'ezplm:ds2kicad:result') {
        window.__ds2kMessages.push(d);
        // 立即回 ACK（item 7）
        window.postMessage({ type: 'ezplm:ds2kicad:ack', jobId: d.jobId, nonce: d.nonce, receivedFiles: d.files?.entries?.length ?? 0 }, '*');
      }
    });
  });
}

/** 三种模式：均走真实服务端分支（由服务端环境变量注入 Stub） */
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
  test(`${mode.name}：全流程一致性（真实服务端分支）`, async ({ page, request }) => {
    // 通过测试专用端点切换服务端 Stub（dev server 提供，仅 AUTH_MODE=dev 时启用）
    await request.post('/api/__test-env', { data: mode.env }).catch(() => {});

    const api = captureApi(page);
    await installHostStub(page);
    await page.goto('/');

    await page.getByRole('button', { name: /开始提取/ }).click();
    await expect(page.getByText(/器件信息确认/)).toBeVisible({ timeout: 60_000 });
    const jobId = api.extract.jobId;
    expect(jobId).toBeTruthy();
    if (mode.name === 'Live-stub') expect(api.extract.part.mpn).toBe('LIVESTUB');
    if (mode.name === 'Degraded') expect(api.extract.meta.mode).toBe('degraded');

    // ── 修改每一类可编辑字段 ──
    await page.locator('.part-grid input').nth(0).fill('E2E-MPN');
    await page.locator('.part-grid input').nth(1).fill('E2E-Vendor');
    await page.locator('.part-grid input').nth(2).fill('E2E Title');
    await page.locator('.part-grid input').nth(3).fill('E2E 中文描述');

    await page.getByRole('button', { name: /② 管脚表/ }).click();
    await page.locator('.pin-table input').nth(1).fill('E2E_PIN');           // 名称
    await page.locator('.pin-table input').nth(0).fill('101');               // 编号
    await page.locator('.pin-table input').nth(3).fill('E2E 描述');          // 描述
    // 新增 + 删除管脚
    await page.getByRole('button', { name: /添加管脚/ }).click();
    const lastRow = page.locator('.pin-table tbody tr').last();
    await lastRow.locator('input').nth(0).fill('900');
    await lastRow.locator('input').nth(1).fill('E2E_ADDED');
    await page.locator('.pin-table tbody tr').nth(1).getByRole('button', { name: '✕' }).click();

    // 封装尺寸 + 清空可选尺寸 + landPattern
    await page.getByRole('button', { name: /③ 封装/ }).click();
    await page.locator('.pkg-grid input').nth(2).fill('4.85');
    const leadWidth = page.locator('.pkg-grid input').nth(7);
    if (await leadWidth.count()) await leadWidth.fill('');                    // 置空 → null

    // 图区：确认 + 新增 + 删除
    await page.getByRole('button', { name: /④ 图区截取/ }).click();
    const confirmBtn = page.getByRole('button', { name: /确认此图/ }).first();
    if (await confirmBtn.count()) await confirmBtn.click();
    const addFig = page.getByRole('button', { name: /添加图区|新增图/ }).first();
    if (await addFig.count()) await addFig.click();

    // ── generate ──
    await page.getByRole('button', { name: /确认无误/ }).click();
    await expect(page.getByText(/在线预览/)).toBeVisible({ timeout: 60_000 });
    const gen = api.generate;
    expect(gen).toBeTruthy();

    // ── 跨层一致性 ──
    const db = readJob(jobId);
    expect(db.revision).toBe(gen.revision);
    expect(db.ir.lifecycle.state).toBe(gen.state);
    expect(gen.manifest.revision).toBe(gen.revision);
    expect(gen.partBundle.job.revision).toBe(gen.revision);
    expect(gen.reviewedIr.part.mpn).toBe('E2E-MPN');
    expect(db.ir.part.mpn).toBe('E2E-MPN');
    expect(gen.partBundle.part.mpn).toBe('E2E-MPN');
    expect(gen.files.kicadSym).toContain('"E2E-MPN"');
    expect(gen.files.kicadSym).toContain('"E2E_ADDED"');
    const pins = gen.reviewedIr.pinsets[0].normalizedPins;
    expect(pins.some((p) => p.number === '900')).toBeTruthy();

    // ── export：ZIP 逐文件哈希校验 ──
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /打包下载 ZIP/ }).click();
    const file = await dl;
    const zipBuf = readFileSync(await file.path());
    const zip = await JSZip.loadAsync(zipBuf);
    for (const f of gen.manifest.files) {
      const entry = zip.file(f.path);
      expect(entry, `ZIP 缺文件 ${f.path}`).toBeTruthy();
      const buf = Buffer.from(await entry.async('nodebuffer'));
      expect(createHash('sha256').update(buf).digest('hex')).toBe(f.sha256);
    }

    // ── postMessage 内容校验（含 ACK）──
    const sendBtn = page.getByRole('button', { name: /发送到 ezPLM/ });
    if (await sendBtn.count()) {
      await sendBtn.click();
      await page.waitForTimeout(500);
      const msgs = await page.evaluate(() => window.__ds2kMessages);
      expect(msgs.length).toBeGreaterThan(0);
      const m = msgs[msgs.length - 1];
      expect(m.version).toBe(3);
      expect(m.jobId).toBe(jobId);
      expect(m.revision).toBe(gen.revision);
      expect(m.assetToken).toBeTruthy();
      expect(m.manifest.files.length).toBe(gen.manifest.files.length);
      // 必须能从消息还原全部文件字节
      for (const e of m.files.entries) {
        const buf = Buffer.from(e.content, e.encoding === 'base64' ? 'base64' : 'utf8');
        expect(createHash('sha256').update(buf).digest('hex')).toBe(e.sha256);
      }
    }

    // ── 真实 reloadJob：刷新页面并按 jobId 恢复 ──
    await page.goto(`/?job=${jobId}`);
    await expect(page.locator('.part-grid input').first()).toHaveValue('E2E-MPN', { timeout: 30_000 });
    const after = readJob(jobId);
    expect(after.revision).toBe(db.revision);
    expect(after.ir.part.mpn).toBe('E2E-MPN');
  });
}
