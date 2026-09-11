// server/dev.js — 本地开发 API 宿主（生产环境由 Vercel 直接托管 /api 目录）
import express from 'express';
import extractHandler from '../api/extract.js';
import platformExtractHandler from '../api/platform-extract.js';
import platformSessionHandler from '../api/platform-session.js';
import creditsHandler from '../api/credits.js';
import handoffHandler from '../api/handoff.js';
import schematicConvertHandler from '../api/schematic-convert.js';
import schematicBuildHandler from '../api/schematic-build.js';
import generateHandler from '../api/generate.js';
import lifecycleHandler from '../api/lifecycle.js';
import figureUploadHandler from '../api/figure-upload.js';
import fetchPdfHandler from '../api/fetch-pdf.js';
import jobPdfHandler from '../api/job-pdf.js';
import jobHandler from '../api/job.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

// v1.2 public/multi-channel entrypoints
app.all('/api/platform-session', (req, res) => platformSessionHandler(req, res));
app.all('/api/platform-extract', (req, res) => platformExtractHandler(req, res));
app.all('/api/credits', (req, res) => creditsHandler(req, res));
app.all('/api/handoff', (req, res) => handoffHandler(req, res));
app.all('/api/schematic-convert', (req, res) => schematicConvertHandler(req, res));
app.all('/api/schematic-build', (req, res) => schematicBuildHandler(req, res));

// Core Agent APIs (also kept for trusted/internal integration)
app.all('/api/extract', (req, res) => extractHandler(req, res));
app.all('/api/figure-upload', (req, res) => figureUploadHandler(req, res));
app.all('/api/lifecycle', (req, res) => lifecycleHandler(req, res));
app.all('/api/generate', (req, res) => generateHandler(req, res));
app.all('/api/fetch-pdf', (req, res) => fetchPdfHandler(req, res));
app.all('/api/job-pdf', (req, res) => jobPdfHandler(req, res));
app.all('/api/job', (req, res) => jobHandler(req, res));

if (process.env.AUTH_MODE === 'dev') {
  app.post('/api/__test-env', (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!/^(MOCK_MODE|GEMINI_API_KEY|GEMINI_STUB|SCHEMATIC_GEMINI_STUB|OCR_STUB|PDF_PARSER)$/.test(k)) continue;
      if (v === '' || v === null) delete process.env[k]; else process.env[k] = String(v);
    }
    res.json({ ok: true, env: { MOCK_MODE: process.env.MOCK_MODE || null, GEMINI_STUB: process.env.GEMINI_STUB ? 'set' : null, SCHEMATIC_GEMINI_STUB: process.env.SCHEMATIC_GEMINI_STUB ? 'set' : null } });
  });
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  const mock = process.env.MOCK_MODE === '1';
  const hasKey = !!process.env.GEMINI_API_KEY;
  const mode = mock ? 'MOCK（免费，不扣 Credit）'
    : hasKey ? 'LIVE（Gemini + Trial/Credit）'
    : 'FAIL-CLOSED（无 GEMINI_API_KEY 且未显式开启 MOCK_MODE）';
  console.log(`[ds2kicad] dev API on http://localhost:${port} mode=${mode}`);
  console.log(`[ds2kicad] guest trial=${process.env.ALLOW_GUEST_TRIAL === '0' ? 'off' : 'on'} freeCredits=${process.env.GUEST_FREE_CREDITS || 3}`);
});
