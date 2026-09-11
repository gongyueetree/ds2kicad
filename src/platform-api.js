function guestHeader() {
  try {
    const token = sessionStorage.getItem('ds2k_guest_token');
    return token ? { 'X-Guest-Session': token } : {};
  } catch { return {}; }
}

async function request(path, options = {}) {
  const headers = { ...guestHeader(), ...(options.headers || {}) };
  let r;
  try {
    r = await fetch(path, { credentials: 'same-origin', ...options, headers });
  } catch (cause) {
    const isConnectivity = path === '/api/schematic-convert';
    const e = new Error(isConnectivity
      ? '与 Connectivity 提取服务的连接中断。系统可能仍在处理；请重试。如果持续出现，请检查 Vercel Function/网络链路。'
      : (cause?.message || 'Network request failed'));
    e.status = 0;
    e.code = 'network_fetch_failed';
    e.cause = cause;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (data.guestToken) {
    try { sessionStorage.setItem('ds2k_guest_token', data.guestToken); } catch {}
  }
  // Streaming connectivity responses flush HTTP 200 early to keep the connection alive.
  // If the long-running task later fails, the real status/code is carried in JSON.
  if (!r.ok || (data?.ok === false && data?.error)) {
    const e = new Error(data.error || `${path} returned ${r.status}`);
    e.status = Number(data.status || r.status || 500);
    e.code = data.code || null;
    e.payload = data;
    throw e;
  }
  return data;
}

export const apiPlatformSession = (payload = {}) => request('/api/platform-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

export const apiCredits = () => request('/api/credits');

export const apiCreateHandoff = (payload = {}) => request('/api/handoff', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

export const apiSchematicConvert = (payload = {}) => request('/api/schematic-convert', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

export const apiSchematicBuild = (ir) => request('/api/schematic-build', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ir })
});
