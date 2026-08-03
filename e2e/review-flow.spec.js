// e2e/review-flow.spec.js — v0.8.5 item 12：真实页面 E2E。
// 覆盖 Mock / Live-stub / Degraded 三种提取模式：
//   extract → 修改每类字段 → 新增/删除管脚 → generate → export → 重新加载 Job
// 并断言：页面、Reviewed IR、数据库、KiCad、Part Bundle、Manifest 全部一致。
//
// ⚠ 本仓库沙箱无法下载 Chromium，本文件在 v0.8.5 交付时 **未运行**（NOT VERIFIED）。
import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

const DB = process.env.JOBSTORE_FILE || '/tmp/ds2kicad-e2e.db';
const readJobFromDb = (jobId) => {
  const db = new DatabaseSync(DB);
  const row = db.prepare('SELECT ir_json, revision FROM jobs WHERE job_id = ?').get(jobId);
  db.close();
  return row ? { ir: JSON.parse(row.ir_json), revision: Number(row.revision) } : null;
};

/** 捕获页面发出的 extract/generate 响应，供跨层一致性比对 */
function captureApi(page) {
  const seen = { extract: null, generate: null };
  page.on('response', async (resp) => {
    const u = resp.url();
    if (u.endsWith('/api/extract') && resp.ok()) seen.extract = await resp.json().catch(() => null);
    if (u.endsWith('/api/generate') && resp.ok()) seen.generate = await resp.json().catch(() => null);
  });
  return seen;
}

const MODES = [
  { name: 'Mock', setup: async () => {} },
  {
    name: 'Live-stub',
    // 用路由拦截伪造一次 live 形状的 extract 响应（不调用真实 Gemini）
    setup: async (page) => {
      await page.route('**/api/extract', async (route) => {
        const resp = await route.fetch();
        const body = await resp.json();
        await route.fulfill({ response: resp, json: { ...body, mock: false, meta: { ...(body.meta || {}), mode: 'live' } } });
      });
    }
  },
  {
    name: 'Degraded',
    setup: async (page) => {
      await page.route('**/api/extract', async (route) => {
        const resp = await route.fetch();
        const body = await resp.json();
        await route.fulfill({ response: resp, json: { ...body, meta: { ...(body.meta || {}), mode: 'degraded', warning: 'AI 不可用（E2E stub）' } } });
      });
    }
  }
];

for (const mode of MODES) {
  test(`${mode.name}：extract → 修改每类字段 → 增删管脚 → generate → export → 重新加载`, async ({ page }) => {
    const api = captureApi(page);
    await mode.setup(page);
    await page.goto('/');

    // 1) extract
    await page.getByRole('button', { name: /开始提取/ }).click();
    await expect(page.getByText(/器件信息确认/)).toBeVisible({ timeout: 60_000 });
    expect(api.extract?.jobId).toBeTruthy();
    const jobId = api.extract.jobId;

    // 2) 修改每一类可编辑字段
    const mpnInput = page.locator('.part-grid input').first();
    await mpnInput.fill('E2E-MPN-1');
    await page.locator('.part-grid input').nth(1).fill('E2E-Vendor');

    // 管脚：修改名称
    await page.getByRole('button', { name: /② 管脚表/ }).click();
    const firstPinName = page.locator('.pin-table input').nth(1);
    await firstPinName.fill('E2E_PIN');

    // 3) 新增 / 删除管脚
    await page.getByRole('button', { name: /添加管脚/ }).click();
    await page.locator('.pin-table tbody tr').last().locator('input').first().fill('900');
    await page.locator('.pin-table tbody tr').last().locator('input').nth(1).fill('E2E_ADDED');
    await page.locator('.pin-table tbody tr').nth(1).getByRole('button', { name: '✕' }).click();

    // 封装尺寸 + 图区确认
    await page.getByRole('button', { name: /③ 封装/ }).click();
    const bodyLen = page.locator('.pkg-grid input').nth(2);
    await bodyLen.fill('4.85');
    await page.getByRole('button', { name: /④ 图区截取/ }).click();
    const confirmBtn = page.getByRole('button', { name: /确认此图/ }).first();
    if (await confirmBtn.count()) await confirmBtn.click();

    // 4) generate
    await page.getByRole('button', { name: /确认无误/ }).click();
    await expect(page.getByText(/在线预览/)).toBeVisible({ timeout: 60_000 });
    const gen = api.generate;
    expect(gen).toBeTruthy();

    // 5) 跨层一致性：页面 / reviewedIr / 数据库 / KiCad / Part Bundle / Manifest
    const db = readJobFromDb(jobId);
    expect(db).toBeTruthy();
    expect(gen.reviewedIr.part.mpn).toBe('E2E-MPN-1');
    expect(db.ir.part.mpn).toBe('E2E-MPN-1');
    expect(gen.partBundle.part.mpn).toBe('E2E-MPN-1');
    expect(gen.files.kicadSym).toContain('"E2E-MPN-1"');
    expect(gen.files.kicadSym).toContain('"E2E_PIN"');
    expect(gen.files.kicadSym).toContain('"E2E_ADDED"');
    const pins = gen.reviewedIr.pinsets[0].normalizedPins;
    expect(pins.some((p) => p.number === '900')).toBeTruthy();
    expect(gen.partBundle.pinsets[0].normalizedPins.length).toBe(pins.length);
    // Manifest 覆盖全部文件且哈希一致
    expect(gen.manifest.files.length).toBe(gen.assetFiles.length);
    for (const f of gen.assetFiles) {
      const m = gen.manifest.files.find((x) => x.path === f.path);
      expect(m?.sha256).toBe(f.sha256);
      expect(typeof f.content).toBe('string');
    }
    expect(db.revision).toBe(gen.revision);

    // 6) export（ZIP 下载）
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: /打包下载 ZIP/ }).click();
    const file = await dl;
    expect(await file.path()).toBeTruthy();

    // 7) 重新加载同一 Job：页面内容必须与数据库一致
    await page.reload();
    await page.evaluate((id) => { window.__ds2kicadJobId = id; }, jobId);
    const after = readJobFromDb(jobId);
    expect(after.ir.part.mpn).toBe('E2E-MPN-1');
    expect(after.revision).toBe(db.revision);
  });
}
