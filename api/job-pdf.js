// api/job-pdf.js — v0.8.6：按 jobId 取回该作业的 PDF（图集裁剪用）。
// 相较 fetch-pdf 的改进（线上图集空白的根因修复）：
//   1) 不依赖跨实例共享的 HMAC 令牌 —— 用 JobStore + 会话鉴权授权，Serverless 多实例天然一致；
//   2) 优先返回 Job 中缓存的 PDF 字节，避免对慢速源站（analog.com 等）重复下载导致超时；
//   3) 仅在缓存缺失时回源，且走 SafeDownloader。
import { setCors } from './extract.js';
import { getJobStore } from '../lib/jobstore.js';
import { authenticate, authorizeJobAccess } from '../lib/auth.js';
import { safeDownload } from '../lib/safedl.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const session = auth.session;

  const jobId = String(req.query?.jobId || '');
  if (!jobId) return res.status(400).json({ error: '缺少 jobId' });

  const store = await getJobStore();
  const got = await store.get(jobId);
  if (!got.ok) return res.status(400).json({ error: got.error, code: got.code });
  const job = got.job;
  const az = authorizeJobAccess(session, job);
  if (!az.ok) return res.status(az.status).json({ error: az.error, code: az.code });

  // 1) 优先用作业内缓存的 PDF（extract 时已下载过，避免二次回源）
  if (job.ir.pdfBase64) {
    const buf = Buffer.from(job.ir.pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.status(200).send(buf);
  }

  // 2) 回源（本地上传的 PDF 没有可回源的 URL）
  const url = job.ir.pdfUrl;
  if (!url || String(url).startsWith('local:')) {
    return res.status(409).json({ error: '该作业没有可用的 PDF 字节（上传通道请在同一浏览器会话内完成图区裁剪）', code: 'pdf_unavailable' });
  }
  try {
    const dl = await safeDownload(url, {
      maxBytes: (Number(process.env.MAX_PDF_MB) || 15) * 1024 * 1024,
      timeoutMs: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,application/octet-stream,*/*;q=0.8',
        'Referer': new URL(url).origin + '/'
      }
    });
    if (dl.buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(422).json({ error: '源站返回的不是 PDF' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.status(200).send(dl.buf);
  } catch (e) {
    return res.status(502).json({ error: `取回失败：${e.message}`, code: 'fetch_failed' });
  }
}
