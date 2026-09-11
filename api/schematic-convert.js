// PDF/image-schematic -> Canonical Connectivity IR -> KiCad files.
import { setCors } from './extract.js';
import { authenticate } from '../lib/auth.js';
import { reserveCredit, commitCredit, refundCredit } from '../lib/credits.js';
import { signupTarget } from '../lib/platform-session.js';
import { validatePdfUrl } from '../lib/validate.js';
import { extractSchematicWithGemini } from '../lib/schematic/gemini.js';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles } from '../lib/schematic/kicad.js';

const MOCK_SCHEMATIC = {
  title: 'Schematic Reconstruction Demo', pageCount: 1, confidence: 0.94,
  components: [
    { ref:'R1', value:'1k', libraryId:'Device:R', position:{x:0.35,y:0.5}, confidence:0.98,
      pins:[{number:'1',name:'1',type:'passive',side:'left',confidence:0.9},{number:'2',name:'2',type:'passive',side:'right',confidence:0.9}] },
    { ref:'D1', value:'LED', libraryId:'Device:LED', position:{x:0.65,y:0.5}, confidence:0.98,
      pins:[{number:'1',name:'K',type:'passive',side:'left',confidence:0.9},{number:'2',name:'A',type:'passive',side:'right',confidence:0.9}] }
  ],
  nets:[{name:'LED_A',confidence:0.96,endpoints:[{ref:'R1',pin:'2'},{ref:'D1',pin:'1'}]}],
  noConnects:[], warnings:[]
};

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const session = auth.session;
  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body) return res.status(422).json({ error: 'invalid JSON body' });

  const mock = process.env.MOCK_MODE === '1' || body.mock === true;
  let reservation = { ok: true, reservationId: null, cost: 0 };
  if (!mock) {
    reservation = await reserveCredit(session, 'schematic_to_kicad', {
      cost: session.guest ? Number(process.env.GUEST_SCHEMATIC_TRIAL_COST || 3) : undefined,
      refKey: req.headers?.['idempotency-key'] || null,
      metadata: { channel: session.channel || 'direct', mode: 'connectivity_extraction' }
    });
    if (!reservation.ok) {
      return res.status(402).json({
        error: session.guest
          ? '免费原理图转换体验已用完。注册 ezPLM / eeHub 后可继续转换并保存工程。'
          : 'Credit 余额不足，请充值后继续转换。',
        code: 'credits_exhausted', wallet: reservation.wallet,
        requiredCredits: reservation.cost,
        signupUrl: signupTarget({ channel: session.channel, locale: session.locale })
      });
    }
  }

  const started = Date.now();
  let stream = null;
  try {
    let pdfBuf = null;
    let fileName = String(body.fileName || 'schematic.pdf').slice(0, 160);
    let sourceUrl = '';
    if (mock) {
      // no source bytes needed
    } else if (typeof body.pdfBase64 === 'string' && body.pdfBase64.length) {
      try { pdfBuf = Buffer.from(body.pdfBase64, 'base64'); }
      catch { throw httpError(400, 'upload is not valid base64'); }
      if (pdfBuf.length > 3.2 * 1024 * 1024) throw httpError(413, '上传 PDF 超过 3MB，请压缩或使用 PDF URL');
      if (pdfBuf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(422, '上传内容不是 PDF；图片请通过网页上传入口转换');
    } else {
      const v = validatePdfUrl(body.pdfUrl);
      if (!v.ok) throw httpError(400, v.error);
      sourceUrl = v.url;
      fileName = fileName === 'schematic.pdf' ? fileNameFromUrl(v.url) : fileName;
      const { safeDownload } = await import('../lib/safedl.js');
      const dl = await safeDownload(v.url, {
        maxBytes: Number(process.env.MAX_PDF_MB || 15) * 1024 * 1024,
        timeoutMs: Math.min(40000, Number(process.env.SCHEMATIC_DOWNLOAD_TIMEOUT_MS || 28000)),
        headers: { 'User-Agent':'Mozilla/5.0 ConnectivityIntelligenceEngine/1.0', 'Accept':'application/pdf,*/*;q=0.8' }
      });
      pdfBuf = dl.buf;
      if (pdfBuf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(422, 'URL did not return a PDF');
    }

    // A long AI call can leave a synchronous HTTP connection completely idle for >60s.
    // Start a chunked JSON response before the model call and emit whitespace heartbeats.
    // JSON parsers legally ignore the leading whitespace, while proxies/browsers see traffic.
    if (!mock && process.env.SCHEMATIC_STREAM_HEARTBEAT !== '0') {
      stream = beginJsonHeartbeat(res, Number(process.env.SCHEMATIC_HEARTBEAT_MS || 8000));
    }

    let raw, model = 'mock', extraction = { attempts: 0, elapsedMs: 0 };
    if (mock) raw = MOCK_SCHEMATIC;
    else {
      const extracted = await extractSchematicWithGemini({
        pdfBase64: pdfBuf.toString('base64'),
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.SCHEMATIC_MODEL || process.env.GEMINI_MODEL,
        fileName,
        deadlineMs: Number(process.env.SCHEMATIC_EXTRACT_BUDGET_MS || 145000)
      });
      raw = extracted.raw;
      model = extracted.model;
      extraction = { attempts: extracted.attempts || 1, elapsedMs: extracted.elapsedMs || (Date.now() - started) };
    }

    const ir = sanitizeSchematicIR(raw, { fileName, sourceUrl, model });
    const generated = buildSchematicFiles(ir);
    if (!mock) await commitCredit(reservation.reservationId);
    const payload = {
      ok: true,
      mode: 'connectivity_intelligence',
      ir,
      summary: summarizeSchematicIR(ir),
      files: generated.files,
      previewSvg: generated.previewSvg,
      report: generated.report,
      extraction,
      chargedCredits: reservation.cost || 0,
      mock
    };
    if (stream) return stream.end(payload);
    try { res.setHeader('Cache-Control', 'no-store'); } catch {}
    return res.status(200).json(payload);
  } catch (e) {
    if (!mock) {
      try { await refundCredit(reservation.reservationId); }
      catch (billingError) { console.error('[schematic-convert] refund failed', billingError); }
    }
    const status = Number(e.status || (e.code === 'schematic_extraction_timeout' ? 504 : 500));
    console.error('[schematic-convert]', { code: e.code, message: e.message, elapsedMs: Date.now() - started });
    const payload = {
      ok: false,
      error: e.code === 'schematic_extraction_timeout'
        ? 'Connectivity 提取超时；系统已自动重试。请再次提交，或使用更小/更清晰的 PDF。'
        : (e.message || 'schematic conversion failed'),
      detail: e.message || null,
      code: e.code || 'schematic_conversion_failed',
      status,
      elapsedMs: Date.now() - started
    };
    // Once streaming headers have been flushed the HTTP status is already 200.
    // Preserve the real status inside the JSON payload; the client converts it back to an exception.
    if (stream) return stream.end(payload);
    return res.status(status).json(payload);
  }
}

function beginJsonHeartbeat(res, intervalMs = 8000) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Connectivity-Streaming', 'heartbeat-v1');
  try { res.flushHeaders?.(); } catch {}

  const beat = () => {
    if (res.writableEnded || res.destroyed) return;
    try {
      // 1 KiB of legal JSON whitespace helps defeat intermediary buffering/idle connection expiry.
      res.write(`\n${' '.repeat(1024)}`);
    } catch {}
  };
  beat();
  const timer = setInterval(beat, Math.max(3000, Math.min(20000, Number(intervalMs) || 8000)));
  timer.unref?.();
  const stop = () => clearInterval(timer);
  res.once('finish', stop);
  res.once('close', stop);

  return {
    end(payload) {
      stop();
      if (res.writableEnded || res.destroyed) return;
      try { res.end(JSON.stringify(payload)); } catch {}
    }
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function fileNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'schematic.pdf').slice(0,160); }
  catch { return 'schematic.pdf'; }
}
