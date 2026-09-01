const ACCESS_TOKEN_KEY = 'oneboard_access_token';

function apiBase() {
  return globalThis.ONEBOARD_CONFIG?.apiBase
    || globalThis.ONEBOARD_API_BASE
    || globalThis.API_BASE
    || 'https://oneboard-server.onrender.com/api';
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBase().replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function accessToken() {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) || '';
}

function clearSession() {
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  globalThis.dispatchEvent?.(new Event('oneboard:session-cleared'));
}

export class SessionExpiredError extends Error {
  constructor(message = 'Authenticated session expired') {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'SESSION_EXPIRED';
  }
}

export function setAccessToken(token) {
  if (token) sessionStorage.setItem(ACCESS_TOKEN_KEY, String(token));
  else clearSession();
}

function requestOptions(options = {}, token = accessToken()) {
  const { authRetry: _authRetry, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { ...fetchOptions, headers, credentials: 'include' };
}

async function responsePayload(response) {
  return response.json().catch(() => null);
}

export async function refreshSession() {
  let response;
  try {
    response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
    });
  } catch (error) {
    clearSession();
    throw error;
  }
  const payload = await responsePayload(response);
  if (!response.ok || !payload?.data?.accessToken || !payload?.data?.user) {
    clearSession();
    const error = new Error(`Session refresh failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  setAccessToken(payload.data.accessToken);
  return payload.data;
}

export async function apiFetch(path, options = {}) {
  const response = await fetch(apiUrl(path), requestOptions(options));
  if (response.status !== 401 || options.authRetry === false) return response;

  try {
    await refreshSession();
  } catch {
    clearSession();
    throw new SessionExpiredError();
  }

  const retry = await fetch(apiUrl(path), requestOptions(options));
  if (retry.status === 401) {
    clearSession();
    throw new SessionExpiredError();
  }
  return retry;
}
