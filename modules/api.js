const ACCESS_TOKEN_KEY = 'oneboard_access_token';
let refreshRecord = null;
let sessionEpoch = 0;

function apiBase() {
  return globalThis.ONEBOARD_CONFIG?.apiBase
    || globalThis.ONEBOARD_API_BASE
    || globalThis.API_BASE
    || '/api';
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBase().replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function accessToken() {
  return sessionStorage.getItem(ACCESS_TOKEN_KEY) || '';
}

function clearSession({ notify = true } = {}) {
  sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  if (notify) globalThis.dispatchEvent?.(new Event('oneboard:session-cleared'));
}

export class SessionExpiredError extends Error {
  constructor(message = 'Authenticated session expired') {
    super(message);
    this.name = 'SessionExpiredError';
    this.code = 'SESSION_EXPIRED';
  }
}

export class SessionSupersededError extends Error {
  constructor() {
    super('Authenticated session lifecycle was superseded');
    this.name = 'SessionSupersededError';
    this.code = 'SESSION_SUPERSEDED';
  }
}

export function beginSessionFamily() {
  sessionEpoch += 1;
  return sessionEpoch;
}

export function clearAccessToken({ notify = true } = {}) {
  clearSession({ notify });
}

export function setAccessToken(token, { notify = true } = {}) {
  if (token) sessionStorage.setItem(ACCESS_TOKEN_KEY, String(token));
  else clearSession({ notify });
}

export function setAccessTokenForEpoch(token, epoch) {
  if (epoch !== sessionEpoch) throw new SessionSupersededError();
  setAccessToken(token);
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

async function performRefresh(epoch) {
  let response;
  try {
    response = await fetch(apiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
    });
  } catch (error) {
    if (epoch !== sessionEpoch) throw new SessionSupersededError();
    clearSession();
    throw error;
  }
  const payload = await responsePayload(response);
  if (epoch !== sessionEpoch) throw new SessionSupersededError();
  if (!response.ok || !payload?.data?.accessToken || !payload?.data?.user) {
    clearSession();
    const error = new Error(`Session refresh failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  setAccessTokenForEpoch(payload.data.accessToken, epoch);
  return payload.data;
}

export function refreshSession() {
  const epoch = sessionEpoch;
  if (!refreshRecord || refreshRecord.epoch !== epoch) {
    const record = { epoch, promise: null };
    record.promise = performRefresh(epoch).finally(() => {
      if (refreshRecord === record) refreshRecord = null;
    });
    refreshRecord = record;
  }
  return refreshRecord.promise;
}

export async function apiFetch(path, options = {}) {
  const requestToken = accessToken();
  const response = await fetch(apiUrl(path), requestOptions(options, requestToken));
  if (response.status !== 401 || options.authRetry === false) return response;

  try {
    if (!requestToken || accessToken() === requestToken) await refreshSession();
  } catch (error) {
    if (error?.code === 'SESSION_SUPERSEDED') throw error;
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
