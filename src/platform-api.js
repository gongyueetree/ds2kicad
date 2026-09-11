function guestHeader() {
  try {
    const token = sessionStorage.getItem('ds2k_guest_token');
    return token ? { 'X-Guest-Session': token } : {};
  } catch { return {}; }
}

async function request(path, options = {}) {
  const headers = { ...guestHeader(), ...(options.headers || {}) };
  const r = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (data.guestToken) {
    try { sessionStorage.setItem('ds2k_guest_token', data.guestToken); } catch {}
  }
  if (!r.ok) {
    const e = new Error(data.error || `${path} returned ${r.status}`);
    e.status = r.status;
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
