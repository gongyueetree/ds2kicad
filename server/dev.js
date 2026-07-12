// server/dev.js — 本地开发 API 宿主（生产环境由 Vercel 直接托管 /api 目录，本文件不部署）
import express from 'express';
import extractHandler from '../api/extract.js';
import generateHandler from '../api/generate.js';
import fetchPdfEdge from '../api/fetch-pdf.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.all('/api/extract', (req, res) => extractHandler(req, res));
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
  const mock = process.env.MOCK_MODE === '1' || !process.env.GEMINI_API_KEY;
  console.log(`[ds2kicad] dev API on http://localhost:${port}  mode=${mock ? 'MOCK（演示数据）' : 'LIVE（Gemini）'}`);
});
