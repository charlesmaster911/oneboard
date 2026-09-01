import { apiFetch, refreshSession, setAccessToken } from './api.js';

const listeners = new Set();
let currentUser = null;
let googleIdentity = null;

function publish(user) {
  currentUser = user || null;
  for (const listener of listeners) listener(currentUser);
}

async function readAuthResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.accessToken || !payload?.data?.user) {
    const error = new Error(payload?.error?.message || `Authentication failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  setAccessToken(payload.data.accessToken);
  return payload.data.user;
}

async function acceptGoogleCredential(credential) {
  const response = await apiFetch('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
    authRetry: false,
  });
  const user = await readAuthResponse(response);
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
      acceptGoogleCredential(credential).catch(() => publish(null));
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
  mountGoogleButton({ googleClientId, google });

  try {
    const session = await refreshSession();
    publish(session.user);
  } catch {
    publish(null);
  }
  return currentUser;
}

export function getCurrentUser() {
  return currentUser;
}

export async function signOut() {
  try {
    await apiFetch('/auth/logout', { method: 'POST', authRetry: false });
  } finally {
    setAccessToken(null);
    googleIdentity?.disableAutoSelect?.();
    publish(null);
  }
}

export function onAuthChanged(listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

globalThis.addEventListener?.('oneboard:session-cleared', () => {
  if (currentUser) publish(null);
});
