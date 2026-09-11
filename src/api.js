// src/api.js — 前端 API 层（v1.2: Guest Token + Trial/Credit Gateway）
function guestHeaders() {
  try {
    const token = sessionStorage.getItem('ds2k_guest_token');
    return token ? { 'X-Guest-Session': token } : {};
  } catch { return {}; }
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    // 鉴权令牌不得进入浏览器 bundle：已登录用户由同源 Cookie/BFF 注入；
    // Guest Token 仅代表匿名试用身份，不含发布权限，由服务端额度闸门约束。
    headers: { 'Content-Type': 'application/json', ...guestHeaders() },
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (data.guestToken) {
    try { sessionStorage.setItem('ds2k_guest_token', data.guestToken); } catch {}
  }
  if (!r.ok) {
    if (r.status === 504) {
      throw apiError('服务端处理超时（大 PDF + AI 响应慢）。建议：① 直接重试 ② ti.com.cn 链接改用 www.ti.com 全球域名 ③ 确认 Vercel 函数时长上限 ≥60s', r.status, data);
    }
    if (r.status === 402 && data.code === 'credits_exhausted') {
      throw apiError(data.error || '免费体验/Credit 已用完，请注册或充值后继续。', r.status, data);
    }
    throw apiError(data.error || `${path} 返回 ${r.status}`, r.status, data);
  }
  return data;
}

function apiError(message, status, data) {
  const e = new Error(message);
  e.status = status;
  e.code = data?.code || null;
  if (data?.currentRevision !== undefined) e.currentRevision = data.currentRevision;
  e.payload = data || null;
  return e;
}

export async function apiExtract(payload) {
  const data = await post('/api/platform-extract', typeof payload === 'string' ? { pdfUrl: payload } : payload);
  window.dispatchEvent(new Event('ds2k:usage-changed'));
  return data;
}
export const apiGenerate = (payload) => post('/api/generate', payload);

/** item 11：认证态 / Guest 自己的 reloadJob */
export async function apiLoadJob(jobId) {
  const r = await fetch(`/api/job?jobId=${encodeURIComponent(jobId)}`, {
    credentials: 'same-origin', headers: guestHeaders()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw apiError(data.error || `加载作业失败（${r.status}）`, r.status, data);
  return data;
}
export const apiFigureUpload = (payload) => post('/api/figure-upload', payload);
export const apiLifecycle = (payload) => post('/api/lifecycle', payload);
