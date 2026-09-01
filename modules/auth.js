import {
  apiFetch,
  beginSessionFamily,
  clearAccessToken,
  refreshSession,
  setAccessTokenForEpoch,
} from './api.js';

const listeners = new Set();
let currentUser = null;
let googleIdentity = null;

function publish(user, reason = user ? 'signed-in' : 'signed-out') {
  currentUser = user || null;
  for (const listener of listeners) listener(currentUser, { reason });
}

function publishSanitizedAuthError(code) {
  globalThis.dispatchEvent?.(new CustomEvent('oneboard:auth-error', {
    detail: {
      code,
      message: '로그인을 완료하지 못했습니다. 승인된 계정인지 확인한 뒤 다시 시도해 주세요.',
    },
  }));
}

async function readAuthResponse(response, epoch) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.accessToken || !payload?.data?.user) {
    const error = new Error(payload?.error?.message || `Authentication failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  setAccessTokenForEpoch(payload.data.accessToken, epoch);
  return payload.data.user;
}

async function acceptGoogleCredential(credential) {
  const epoch = beginSessionFamily();
  const response = await apiFetch('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
    authRetry: false,
  });
  const user = await readAuthResponse(response, epoch);
  publish(user);
  return user;
}

function mountGoogleButton({ googleClientId, google }) {
  const mount = document.getElementById('google-signin');
  const provider = google?.accounts?.id;
  if (!googleClientId || !mount) return;
  if (!provider) {
    document.getElementById('google-identity-script')?.addEventListener('load', () => {
      mountGoogleButton({ googleClientId, google: globalThis.google });
    }, { once: true });
    return;
  }

  googleIdentity = provider;
  provider.initialize({
    client_id: googleClientId,
    callback: ({ credential } = {}) => {
      if (!credential) return;
      acceptGoogleCredential(credential).catch(() => {
        publishSanitizedAuthError('GOOGLE_LOGIN_FAILED');
        publish(null, 'login-failed');
      });
    },
  });
  provider.renderButton(mount, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'rectangular',
  });
}

export async function initAuth({
  googleClientId,
  google = globalThis.google,
} = {}) {
  currentUser = null;
  beginSessionFamily();

  try {
    const session = await refreshSession();
    publish(session.user, 'signed-in');
  } catch {
    publish(null, 'initial-unauthenticated');
  }
  mountGoogleButton({ googleClientId, google: google || globalThis.google });
  return currentUser;
}

export function getCurrentUser() {
  return currentUser;
}

export async function signOut() {
  beginSessionFamily();
  let response;
  try {
    response = await apiFetch('/auth/logout', { method: 'POST', authRetry: false });
  } catch {
    const error = new Error('로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    error.code = 'LOGOUT_UNRESOLVED';
    throw error;
  }
  if (!response.ok) {
    const error = new Error('로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    error.code = 'LOGOUT_UNRESOLVED';
    throw error;
  }
  clearAccessToken({ notify: false });
  googleIdentity?.disableAutoSelect?.();
  publish(null, 'signed-out');
}

export function onAuthChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

globalThis.addEventListener?.('oneboard:session-cleared', () => {
  if (currentUser) publish(null, 'session-expired');
});
