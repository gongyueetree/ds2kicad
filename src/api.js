// src/api.js — 前端 API 层
async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 504) {
      throw new Error('服务端处理超时（大 PDF + AI 响应慢）。建议：① 直接重试（AI 偶发慢）② ti.com.cn 链接改用 www.ti.com 全球域名 ③ 确认 Vercel 函数时长上限 ≥60s');
    }
    throw new Error(data.error || `${path} 返回 ${r.status}`);
  }
  return data;
}

export const apiExtract = (payload) => post('/api/extract', typeof payload === 'string' ? { pdfUrl: payload } : payload);
export const apiGenerate = (payload) => post('/api/generate', payload);
