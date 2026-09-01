import { getCurrentUser, initAuth, onAuthChanged, signOut } from './auth.js';
import { apiFetch } from './api.js';
import { applyRoleVisibility, setText } from './dom.js';

export function createAuthenticatedSessionGate() {
  let resolveReady;
  let settled = false;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  return {
    ready,
    publish(user) {
      if (!settled && user) {
        settled = true;
        resolveReady(user);
      }
    },
  };
}

export function renderAuthShell(user) {
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app-shell');
  const authenticated = Boolean(user);

  if (loginScreen) loginScreen.hidden = authenticated;
  if (appShell) appShell.hidden = !authenticated;
  setText(document.getElementById('current-user'), user?.displayName || user?.email || '');
  setText(document.getElementById('current-role'), user?.role || '');
  applyRoleVisibility(user?.role || null);
}

export function bootOneBoard() {
  const gate = createAuthenticatedSessionGate();
  globalThis.ONEBOARD_SESSION_READY = gate.ready;
  globalThis.ONEBOARD_API = Object.freeze({ fetch: apiFetch });
  globalThis.dispatchEvent?.(new Event('oneboard:session-ready'));

  renderAuthShell(null);
  onAuthChanged((user) => {
    renderAuthShell(user);
    gate.publish(user);
    globalThis.dispatchEvent?.(new CustomEvent('oneboard:auth-changed', { detail: { user } }));
  });

  document.getElementById('logout-button')?.addEventListener('click', async () => {
    const button = document.getElementById('logout-button');
    if (button) button.disabled = true;
    try {
      await signOut();
    } finally {
      if (button) button.disabled = false;
    }
  });

  const googleClientId = globalThis.ONEBOARD_CONFIG?.googleClientId
    || globalThis.GOOGLE_CLIENT_ID
    || document.documentElement.dataset.googleClientId
    || '';
  if (!googleClientId) {
    setText(document.getElementById('login-status'), 'Google 로그인 설정이 필요합니다. 관리자에게 문의하세요.');
  }

  initAuth({ googleClientId }).then((user) => {
    renderAuthShell(user);
    gate.publish(user);
  }).catch(() => {
    renderAuthShell(null);
    setText(document.getElementById('login-status'), '로그인 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
  });

  return { ready: gate.ready, getCurrentUser };
}

if (typeof document !== 'undefined' && document.getElementById('login-screen')) {
  bootOneBoard();
}
