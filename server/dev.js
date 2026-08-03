// server/dev.js — 本地开发 API 宿主（生产环境由 Vercel 直接托管 /api 目录，本文件不部署）
import express from 'express';
import extractHandler from '../api/extract.js';
import generateHandler from '../api/generate.js';
import lifecycleHandler from '../api/lifecycle.js';
import figureUploadHandler from '../api/figure-upload.js';
import fetchPdfHandler from '../api/fetch-pdf.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

app.all('/api/extract', (req, res) => extractHandler(req, res));
app.all('/api/figure-upload', (req, res) => figureUploadHandler(req, res));
app.all('/api/lifecycle', (req, res) => lifecycleHandler(req, res));
app.all('/api/generate', (req, res) => generateHandler(req, res));

// v0.8.6 item 11：fetch-pdf 自 v0.8.1 起已是 Node 风格 handler（req, res），
// 此前仍按 Edge 的 Request→Response 方式调用，本地 PDF 渲染（图集缩略图）必然失败。
app.all('/api/fetch-pdf', (req, res) => fetchPdfHandler(req, res));

// item 10：测试专用 —— 允许 E2E 切换服务端 Stub（仅 AUTH_MODE=dev 时启用）
if (process.env.AUTH_MODE === 'dev') {
  app.post('/api/__test-env', (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!/^(MOCK_MODE|GEMINI_API_KEY|GEMINI_STUB|OCR_STUB|PDF_PARSER)$/.test(k)) continue;
      if (v === '' || v === null) delete process.env[k]; else process.env[k] = String(v);
    }
    res.json({ ok: true, env: { MOCK_MODE: process.env.MOCK_MODE || null, GEMINI_STUB: process.env.GEMINI_STUB ? 'set' : null } });
  });
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  // v0.8.2 起：缺 Key 不再自动 Mock，而是 fail closed（503）
  const mock = process.env.MOCK_MODE === '1';
  const hasKey = !!process.env.GEMINI_API_KEY;
  const mode = mock ? 'MOCK（显式 MOCK_MODE=1，结果 non_promotable）'
    : hasKey ? 'LIVE（Gemini）'
    : 'FAIL-CLOSED（无 GEMINI_API_KEY 且未显式开启 MOCK_MODE → /api/extract 返回 503）';
  console.log(`[ds2kicad] dev API on http://localhost:${port}  mode=${mode}`);
  if (!process.env.EZPLM_JWT_SECRET && process.env.AUTH_MODE !== 'dev') {
    console.log('[ds2kicad] 提示：未设置 EZPLM_JWT_SECRET，接口将拒绝未鉴权请求；本地联调可设 AUTH_MODE=dev');
  }
});
