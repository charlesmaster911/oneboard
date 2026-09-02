import { getCurrentUser, initAuth, onAuthChanged, signOut } from './auth.js';
import { apiFetch } from './api.js';
import { applyUiPolicy, createElement, formatWon, setText } from './dom.js';
import * as collaboration from './collaboration.js';
import * as workspace from './workspace.js';

globalThis.ONEBOARD_COLLABORATION = Object.freeze({ ...collaboration });
globalThis.ONEBOARD_WORKSPACE = Object.freeze({ ...workspace });

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
  const authenticated = Boolean(user && user.role !== 'system');

  if (loginScreen) loginScreen.hidden = authenticated;
  if (appShell) appShell.hidden = !authenticated;
  setText(document.getElementById('current-user'), user?.displayName || user?.email || '');
  setText(document.getElementById('current-role'), user?.role || '');
  applyUiPolicy(authenticated ? user : null);
  globalThis.ONEBOARD_CURRENT_USER = authenticated ? Object.freeze({ ...user }) : null;
}

export function announceAuthTransition(user, reason) {
  const announcer = document.getElementById('auth-announcer');
  const messages = {
    'signed-in': '로그인되었습니다.',
    'signed-out': '로그아웃되었습니다.',
    'session-expired': '세션이 만료되었습니다. 다시 로그인해 주세요.',
  };
  if (!messages[reason]) return;
  setText(announcer, messages[reason]);
  const target = user ? document.getElementById('app-shell') : document.getElementById('login-title');
  target?.focus?.();
}

export function renderPlatformDetail(target, rows = []) {
  const table = createElement('table');
  const tbody = createElement('tbody');
  for (const row of rows) {
    const tr = createElement('tr');
    const raw = String(row.platform_raw || row.platform || '');
    const label = raw.startsWith('etc:') ? raw.slice(4) : raw;
    tr.append(
      createElement('td', { text: label }),
      createElement('td', { text: formatWon(row.total_sales) }),
      createElement('td', { text: formatWon(row.ad_spend) }),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  target?.replaceChildren(table);
  return table;
}

export function bootOneBoard() {
  const gate = createAuthenticatedSessionGate();
  globalThis.ONEBOARD_SESSION_READY = gate.ready;
  globalThis.ONEBOARD_API = Object.freeze({ fetch: apiFetch });
  globalThis.dispatchEvent?.(new Event('oneboard:session-ready'));

  renderAuthShell(null);
  onAuthChanged((user, { reason } = {}) => {
    renderAuthShell(user);
    gate.publish(user);
    announceAuthTransition(user, reason);
    globalThis.dispatchEvent?.(new CustomEvent('oneboard:auth-changed', { detail: { user } }));
  });

  document.getElementById('logout-button')?.addEventListener('click', async () => {
    const button = document.getElementById('logout-button');
    const status = document.getElementById('auth-action-status');
    if (button) button.disabled = true;
    try {
      await signOut();
      setText(status, '');
    } catch {
      setText(status, '로그아웃을 완료하지 못했습니다. 현재 세션은 유지됩니다. 잠시 후 다시 시도해 주세요.');
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

  globalThis.addEventListener?.('oneboard:auth-error', ({ detail } = {}) => {
    setText(document.getElementById('login-status'), detail?.message || '로그인을 완료하지 못했습니다.');
  });

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
