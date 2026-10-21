/**
 * TdyTripPWA2026 - Network Transport Layer (Phase 3)
 * Giao tiếp HTTP với backend Google Apps Script.
 * Hỗ trợ timeout 45s, AbortController, text/plain (CORS safe), và che giấu token/key.
 */

export const DEFAULT_TIMEOUT_MS = 45000; // 45 giây cho batch 5 ops

export function sanitizeUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.has('user_content_key')) u.searchParams.set('user_content_key', '[REDACTED]');
    if (u.searchParams.has('token')) u.searchParams.set('token', '[REDACTED]');
    return u.toString();
  } catch (e) {
    return rawUrl.split('?')[0];
  }
}

/**
 * Gửi HTTP request an toàn với timeout và CORS
 */
export async function safeFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOpts = {
    ...options,
    signal: controller.signal
  };

  try {
    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);
    const durationMs = Date.now() - start;

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${res.statusText}) sau ${durationMs}ms`);
    }

    const json = await res.json();
    return {
      ok: true,
      status: res.status,
      json,
      durationMs
    };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    if (err.name === 'AbortError') {
      throw new Error(`Request timeout sau ${durationMs}ms (vượt ngưỡng client ${timeoutMs}ms)`);
    }
    throw err;
  }
}

/**
 * Gửi batch operations lên server Google Apps Script
 * Payload: { action: 'batch_apply', token, ops, clientVersion: 'v0.3.0' }
 */
export async function postBatchPayload(url, token, ops, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!url) throw new TypeError('Missing GAS URL');
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new TypeError('Ops must be non-empty array');
  }

  // Đảm bảo các ops trong batch được sort theo timestamp tăng dần
  const sortedOps = [...ops].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  const bodyPayload = {
    action: 'batch_apply',
    token: token || '',
    ops: sortedOps,
    clientVersion: 'v0.3.0'
  };

  const response = await safeFetch(
    url,
    {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8' // Giữ text/plain tránh CORS preflight options
      },
      body: JSON.stringify(bodyPayload)
    },
    timeoutMs
  );

  return response.json;
}
