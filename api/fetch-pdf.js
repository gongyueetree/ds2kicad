// api/fetch-pdf.js — 受控 PDF 取回端点（v0.8.1 item 7）。
// 变更：不再是公开 Edge 代理（任何人可传任意 URL 让本服务代抓）。
// 现在改为 Node Serverless + SafeDownloader（逐跳重定向校验 / DNS 私网拒绝 / 流式字节上限），
// 并要求短期签名令牌：签名由 /api/extract 在校验通过后签发，绑定 URL + 过期时间。
// 说明：本仓库为无状态部署，尚无对象存储；签名 URL 机制以 HMAC 令牌等价实现，
// 迁移到 ezPLM 后台后应替换为 对象存储 + 预签名 URL（见 docs/upgrade/01-v0.8.1-report.md）。
import { safeDownload } from '../lib/safedl.js';
import { signPdfToken, verifyPdfToken } from '../lib/pdftoken.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const origin = req.headers?.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const url = String(req.query?.url || '');
  const token = String(req.query?.token || '');
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });

  const v = verifyPdfToken(url, token);
  if (!v.ok) {
    return res.status(403).json({
      error: `未授权的取回请求（${v.error}）。该端点不再作为公开代理，令牌由 /api/extract 校验通过后签发`
    });
  }

  const maxBytes = (Number(process.env.MAX_PDF_MB) || 15) * 1024 * 1024;
  try {
    const dl = await safeDownload(url, {
      maxBytes,
      timeoutMs: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/pdf,application/octet-stream,*/*;q=0.8',
        'Referer': new URL(url).origin + '/'
      }
    });
    if (dl.buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(422).json({ error: '目标不是 PDF 文件' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(dl.buf);
  } catch (e) {
    return res.status(502).json({ error: `取回失败：${e.message}` });
  }
}

export { signPdfToken };
