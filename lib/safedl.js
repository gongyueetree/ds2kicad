// lib/safedl.js — P0-4 统一安全下载器。
// 逐跳处理 redirect（不用 redirect:'follow'）：每一跳重新做 URL 结构 / scheme / 端口 /
// DNS 解析后 IP 段校验；响应体流式读取并施加真实字节上限（不信任 Content-Length）。
// 已知残余风险（记录在案）：DNS 校验与 fetch 实际连接之间存在 rebinding 时间窗，
// 彻底消除需按解析后 IP 直连（undici connect 定制），列入后台 Worker 阶段。
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const MAX_REDIRECTS = 5;

/** 私网/保留/环回/链路本地/元数据地址判定（v4 + v6 + v4-mapped v6） */
export function isForbiddenIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;                 // 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                               // 组播/保留
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
  const mappedDot = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low); // v4-mapped（点分）
  if (mappedDot) return isForbiddenIp(mappedDot[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low); // v4-mapped（URL 规范化后的十六进制）
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return isForbiddenIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** 单跳 URL 结构校验（含数值 IP 直写）；返回 {ok, error} */
export function validateHopUrl(u) {
  let url;
  try { url = new URL(u); } catch { return { ok: false, error: 'URL 非法' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: '仅允许 http/https' };
  if (!ALLOWED_PORTS.has(url.port)) return { ok: false, error: `不允许的端口 ${url.port}` };
  const host = url.hostname.replace(/^\[|\]$/g, ''); // URL 对 IPv6 保留方括号，isIP 不认
  if (net.isIP(host) && isForbiddenIp(host)) return { ok: false, error: '不允许访问内网/保留地址' };
  return { ok: true, url, host };
}

async function assertDnsPublic(rawHostname) {
  const hostname = rawHostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isForbiddenIp(hostname)) throw new Error('目标为内网/保留地址');
    return;
  }
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('DNS 解析失败');
  for (const a of addrs) {
    if (isForbiddenIp(a.address)) throw new Error(`DNS 解析到受限地址 ${a.address}`);
  }
}

/**
 * 安全下载。@returns {Promise<{buf:Buffer, contentType:string, finalUrl:string, status:number}>}
 */
export async function safeDownload(startUrl, { maxBytes, timeoutMs = 15000, headers = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const v = validateHopUrl(current);
    if (!v.ok) throw new Error(v.error);
    await assertDnsPublic(v.url.hostname);

    const remain = deadline - Date.now();
    if (remain < 500) throw new Error('下载超时');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remain);
    let resp;
    try {
      resp = await fetch(current, { redirect: 'manual', signal: ac.signal, headers });
    } catch (e) {
      clearTimeout(timer);
      throw e.name === 'AbortError' ? new Error(`数据手册下载超时（>${Math.round(timeoutMs / 1000)}s）`) : e;
    }

    if (resp.status >= 300 && resp.status < 400) {
      clearTimeout(timer);
      const loc = resp.headers.get('location');
      resp.body?.cancel?.();
      if (!loc) throw new Error(`重定向缺少 Location（HTTP ${resp.status}）`);
      current = new URL(loc, current).toString(); // 相对重定向解析后回到循环重新校验
      continue;
    }
    if (!resp.ok) {
      clearTimeout(timer);
      resp.body?.cancel?.();
      throw new Error(`上游返回 HTTP ${resp.status}`);
    }

    // 流式读取 + 真实字节上限（不信任 Content-Length）
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (maxBytes && total > maxBytes) {
          await reader.cancel();
          throw new Error(`PDF 超过大小限制（>${Math.round(maxBytes / 1048576)}MB）`);
        }
        chunks.push(value);
      }
    } finally {
      clearTimeout(timer);
    }
    return {
      buf: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      contentType: resp.headers.get('content-type') || '',
      finalUrl: current,
      status: resp.status
    };
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
}
