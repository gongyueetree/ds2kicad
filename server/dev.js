// server/dev.js — 本地开发 API 宿主（生产环境由 Vercel 直接托管 /api 目录，本文件不部署）
import express from 'express';
import extractHandler from '../api/extract.js';
import generateHandler from '../api/generate.js';
import lifecycleHandler from '../api/lifecycle.js';
import fetchPdfEdge from '../api/fetch-pdf.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

app.all('/api/extract', (req, res) => extractHandler(req, res));
app.all('/api/lifecycle', (req, res) => lifecycleHandler(req, res));
app.all('/api/generate', (req, res) => generateHandler(req, res));

// Edge 风格 handler（Request → Response）适配到 Express
app.get('/api/fetch-pdf', async (req, res) => {
  const url = new URL(req.originalUrl, `http://localhost:${process.env.PORT || 3001}`);
  const response = await fetchPdfEdge(new Request(url.toString()));
  res.status(response.status);
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
});

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
