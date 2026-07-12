// src/api.js — 前端 API 层
async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${path} 返回 ${r.status}`);
  return data;
}

export const apiExtract = (pdfUrl) => post('/api/extract', { pdfUrl });
export const apiGenerate = (payload) => post('/api/generate', payload);
