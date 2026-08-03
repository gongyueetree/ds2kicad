// playwright.config.js — v0.8.5 item 12：真实浏览器 E2E 配置。
// 运行：npx playwright install chromium && npm run e2e
// 注意：本仓库的 CI 沙箱无法下载浏览器（网络策略），因此这些用例在本轮 **未被执行**，
// 报告中标记为 NOT VERIFIED。请在有网络的开发机上运行以获得真实结论。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    timeout: 120_000,
    reuseExistingServer: true,
    env: {
      MOCK_MODE: '1', AUTH_MODE: 'dev',
      PDF_TOKEN_SECRET: 'e2e-pdf', ASSET_TOKEN_SECRET: 'e2e-asset',
      JOBSTORE_FILE: '/tmp/ds2kicad-e2e.db',
      VITE_EZPLM_ORIGINS: 'http://localhost:5173'
    }
  }
});
