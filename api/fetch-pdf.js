// api/fetch-pdf.js — PDF 代理（Edge Runtime，流式转发，绕过 CORS 与 4.5MB 响应限制）
// 前端 pdf.js 通过本接口加载 ti.com 等站点的 PDF 进行页面渲染与图区截取。
export const config = { runtime: 'edge' };

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[fc|\[fd|\[fe80)/i;

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('url') || '';
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'URL 格式无效' }, 400);
  }
  if (!/^https?:$/.test(target.protocol) || PRIVATE_HOST_RE.test(target.hostname)) {
    return json({ error: '不允许的 URL' }, 400);
  }

  const maxMb = Number(process.env.MAX_PDF_MB || 15);
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DS2KiCad/0.1; +https://eetree.cn)',
        'Accept': 'application/pdf,*/*'
      }
    });
  } catch (e) {
    return json({ error: `上游请求失败: ${e.message}` }, 502);
  }
  if (!upstream.ok) return json({ error: `上游返回 ${upstream.status}` }, 502);

  const len = Number(upstream.headers.get('content-length') || 0);
  if (len && len > maxMb * 1024 * 1024) {
    return json({ error: `PDF 超过 ${maxMb}MB 限制` }, 413);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
