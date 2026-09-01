import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { apiFetch, refreshSession, setAccessToken } from '../modules/api.js';
import { getCurrentUser, initAuth, onAuthChanged, signOut } from '../modules/auth.js';
import { announceAuthTransition, createAuthenticatedSessionGate } from '../modules/main.js';

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionPayload(token = 'fresh-access-token') {
  return {
    data: {
      accessToken: token,
      user: {
        id: 'user-1',
        email: 'ops@example.com',
        displayName: '운영 담당자',
        role: 'ops',
      },
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  delete window.ONEBOARD_API;
  document.body.innerHTML = '<div id="google-signin"></div>';
});

describe('API session lifecycle', () => {
  test('a 401 refreshes once and retries with the fresh bearer token', async () => {
    setAccessToken('expired-access-token');
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'ACCESS_EXPIRED' } }))
      .mockResolvedValueOnce(jsonResponse(200, sessionPayload()))
      .mockResolvedValueOnce(jsonResponse(200, { data: { total: 3 } }));
    vi.stubGlobal('fetch', fakeFetch);

    const response = await apiFetch('/data/summary');

    expect(response.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(fakeFetch.mock.calls[1][0]).toMatch(/\/auth\/refresh$/);
    expect(fakeFetch.mock.calls[1][1].credentials).toBe('include');
    expect(new Headers(fakeFetch.mock.calls[2][1].headers).get('Authorization'))
      .toBe('Bearer fresh-access-token');
  });

  test('a second 401 clears the access token without a second refresh', async () => {
    setAccessToken('expired-access-token');
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'ACCESS_EXPIRED' } }))
      .mockResolvedValueOnce(jsonResponse(200, sessionPayload()))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'ACCESS_DENIED' } }));
    vi.stubGlobal('fetch', fakeFetch);

    await expect(apiFetch('/data/summary')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
  });

  test('a failed refresh clears the session and stops the protected request', async () => {
    setAccessToken('expired-access-token');
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'ACCESS_EXPIRED' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'REFRESH_TOKEN_INVALID' } }));
    vi.stubGlobal('fetch', fakeFetch);

    await expect(apiFetch('/data/summary')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
  });

  test('concurrent 401 responses share one successful refresh and each request retries once', async () => {
    setAccessToken('expired-access-token');
    let releaseRefresh;
    const fakeFetch = vi.fn(async (url, options = {}) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((resolve) => { releaseRefresh = () => resolve(jsonResponse(200, sessionPayload())); });
      }
      const token = new Headers(options.headers).get('Authorization');
      if (token === 'Bearer expired-access-token') {
        return jsonResponse(401, { error: { code: 'ACCESS_EXPIRED' } });
      }
      return jsonResponse(200, { data: { ok: true } });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const first = apiFetch('/data/daily');
    const second = apiFetch('/team/tasks');
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
    releaseRefresh();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fakeFetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledTimes(5);
  });

  test('concurrent 401 responses share one failed refresh and do not retry protected requests', async () => {
    setAccessToken('expired-access-token');
    let releaseRefresh;
    const fakeFetch = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((resolve) => {
          releaseRefresh = () => resolve(jsonResponse(401, { error: { code: 'REFRESH_TOKEN_INVALID' } }));
        });
      }
      return jsonResponse(401, { error: { code: 'ACCESS_EXPIRED' } });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const requests = [apiFetch('/data/daily'), apiFetch('/team/tasks')];
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
    releaseRefresh();

    const settled = await Promise.allSettled(requests);
    expect(settled.every(({ reason }) => reason?.code === 'SESSION_EXPIRED')).toBe(true);
    expect(fakeFetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh'))).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
  });

  test('a 403 is terminal and never refreshes or clears the authenticated session', async () => {
    setAccessToken('valid-access-token');
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(403, {
      error: { code: 'ROLE_FORBIDDEN' },
    }));
    vi.stubGlobal('fetch', fakeFetch);

    const response = await apiFetch('/data/daily');

    expect(response.status).toBe(403);
    expect(fakeFetch).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('oneboard_access_token')).toBe('valid-access-token');
  });
});

describe('Google auth state', () => {
  test('initAuth resumes an HttpOnly-cookie session and publishes its canonical role', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, sessionPayload()));
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton: vi.fn(),
          disableAutoSelect: vi.fn(),
        },
      },
    };
    const observed = [];
    const unsubscribe = onAuthChanged((user) => observed.push(user));

    const user = await initAuth({ googleClientId: 'test-client-id', google });

    unsubscribe();
    expect(user.role).toBe('ops');
    expect(getCurrentUser()).toEqual(user);
    expect(observed.at(-1)).toEqual(user);
    expect(google.accounts.id.initialize).toHaveBeenCalledOnce();
    expect(google.accounts.id.renderButton).toHaveBeenCalledOnce();
  });

  test('a Google provider that loads after auth initialization still mounts login', async () => {
    document.body.innerHTML = `
      <script id="google-identity-script"></script>
      <div id="google-signin"></div>
    `;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, {
      error: { code: 'REFRESH_TOKEN_INVALID' },
    })));
    const google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton: vi.fn(),
          disableAutoSelect: vi.fn(),
        },
      },
    };

    await initAuth({ googleClientId: 'test-client-id', google: undefined });
    window.google = google;
    document.querySelector('#google-identity-script').dispatchEvent(new Event('load'));

    expect(google.accounts.id.initialize).toHaveBeenCalledOnce();
    expect(google.accounts.id.renderButton).toHaveBeenCalledOnce();
  });

  test('Google login is not mounted until the initial refresh settles', async () => {
    let settleRefresh;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { settleRefresh = resolve; })));
    const google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton: vi.fn(),
          disableAutoSelect: vi.fn(),
        },
      },
    };

    const initialization = initAuth({ googleClientId: 'test-client-id', google });
    await Promise.resolve();
    expect(google.accounts.id.initialize).not.toHaveBeenCalled();
    expect(google.accounts.id.renderButton).not.toHaveBeenCalled();

    settleRefresh(jsonResponse(401, { error: { code: 'REFRESH_TOKEN_INVALID' } }));
    await initialization;

    expect(google.accounts.id.initialize).toHaveBeenCalledOnce();
    expect(google.accounts.id.renderButton).toHaveBeenCalledOnce();
  });

  test('the Google credential callback establishes the authenticated user session', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'REFRESH_TOKEN_INVALID' } }))
      .mockResolvedValueOnce(jsonResponse(200, sessionPayload('google-access-token')));
    vi.stubGlobal('fetch', fakeFetch);
    const initialize = vi.fn();
    const google = {
      accounts: { id: { initialize, renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    const authenticated = new Promise((resolve) => {
      const unsubscribe = onAuthChanged((user) => {
        if (user) {
          unsubscribe();
          resolve(user);
        }
      });
    });
    await initAuth({ googleClientId: 'test-client-id', google });

    initialize.mock.calls[0][0].callback({ credential: 'fake-google-credential' });
    const user = await authenticated;

    expect(user.role).toBe('ops');
    expect(sessionStorage.getItem('oneboard_access_token')).toBe('google-access-token');
    expect(JSON.parse(fakeFetch.mock.calls[1][1].body)).toEqual({
      credential: 'fake-google-credential',
    });
  });

  test('signOut calls the server, clears browser session state, and publishes null', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, sessionPayload()))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });
    const observed = [];
    const unsubscribe = onAuthChanged((user) => observed.push(user));

    await signOut();

    unsubscribe();
    expect(fakeFetch.mock.calls[1][0]).toMatch(/\/auth\/logout$/);
    expect(fakeFetch.mock.calls[1][1].credentials).toBe('include');
    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
    expect(getCurrentUser()).toBeNull();
    expect(observed.at(-1)).toBeNull();
  });

  test('logout invalidates an outstanding refresh and emits only signed-out in order', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, sessionPayload('prior-token')));
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });

    let releaseRefresh;
    fakeFetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((resolve) => {
          releaseRefresh = () => resolve(jsonResponse(200, sessionPayload('stale-refresh-token')));
        });
      }
      if (String(url).endsWith('/auth/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      throw new Error(`unexpected URL ${url}`);
    });
    const reasons = [];
    const unsubscribe = onAuthChanged((_user, { reason }) => reasons.push(reason));
    const refresh = refreshSession();
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
    await signOut();
    releaseRefresh();
    await expect(refresh).rejects.toMatchObject({ code: 'SESSION_SUPERSEDED' });
    unsubscribe();

    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
    expect(reasons).toEqual(['signed-out']);
  });

  test('failed logout keeps prior auth but rejects the outstanding stale refresh write', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, sessionPayload('prior-token')));
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });

    let releaseRefresh;
    fakeFetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((resolve) => {
          releaseRefresh = () => resolve(jsonResponse(200, sessionPayload('stale-refresh-token')));
        });
      }
      if (String(url).endsWith('/auth/logout')) {
        return Promise.resolve(jsonResponse(503, { error: { code: 'UNAVAILABLE' } }));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const refresh = refreshSession();
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
    await expect(signOut()).rejects.toMatchObject({ code: 'LOGOUT_UNRESOLVED' });
    releaseRefresh();
    await expect(refresh).rejects.toMatchObject({ code: 'SESSION_SUPERSEDED' });

    expect(getCurrentUser()?.id).toBe('user-1');
    expect(sessionStorage.getItem('oneboard_access_token')).toBe('prior-token');
  });

  test('a new Google login family invalidates an older outstanding refresh', async () => {
    const initialize = vi.fn();
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, sessionPayload('prior-token')));
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: { id: { initialize, renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });

    let releaseRefresh;
    fakeFetch.mockImplementation((url) => {
      if (String(url).endsWith('/auth/refresh')) {
        return new Promise((resolve) => {
          releaseRefresh = () => resolve(jsonResponse(200, sessionPayload('stale-refresh-token')));
        });
      }
      if (String(url).endsWith('/auth/google')) {
        return Promise.resolve(jsonResponse(200, sessionPayload('new-login-token')));
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const refresh = refreshSession();
    await vi.waitFor(() => expect(releaseRefresh).toBeTypeOf('function'));
    initialize.mock.calls[0][0].callback({ credential: 'new-family-credential' });
    await vi.waitFor(() => {
      expect(sessionStorage.getItem('oneboard_access_token')).toBe('new-login-token');
    });
    releaseRefresh();
    await expect(refresh).rejects.toMatchObject({ code: 'SESSION_SUPERSEDED' });

    expect(sessionStorage.getItem('oneboard_access_token')).toBe('new-login-token');
  });

  test('involuntary session clearing emits session-expired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, sessionPayload())));
    const google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });
    const reasons = [];
    const unsubscribe = onAuthChanged((_user, { reason }) => reasons.push(reason));

    setAccessToken(null);

    unsubscribe();
    expect(reasons).toEqual(['session-expired']);
  });

  test.each([
    ['HTTP failure', () => jsonResponse(503, { error: { message: '<img onerror=alert(1)>' } })],
    ['network failure', () => Promise.reject(new Error('socket secret detail'))],
  ])('signOut retains authenticated state after %s and exposes only a sanitized error', async (_label, responseFactory) => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, sessionPayload()))
      .mockImplementationOnce(responseFactory);
    vi.stubGlobal('fetch', fakeFetch);
    const google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    await initAuth({ googleClientId: 'test-client-id', google });

    await expect(signOut()).rejects.toMatchObject({
      code: 'LOGOUT_UNRESOLVED',
      message: '로그아웃을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    });
    expect(getCurrentUser()?.id).toBe('user-1');
    expect(sessionStorage.getItem('oneboard_access_token')).toBe('fresh-access-token');
  });
});

test('auth transitions move focus and use a dedicated live region', () => {
  document.body.innerHTML = `
    <section id="login-screen"><h1 id="login-title" tabindex="-1">OneBoard</h1></section>
    <main id="app-shell" tabindex="-1"></main>
    <p id="auth-announcer" aria-live="assertive"></p>
  `;

  announceAuthTransition({ id: 'user-1', role: 'ops' }, 'signed-in');
  expect(document.activeElement).toBe(document.getElementById('app-shell'));
  expect(document.getElementById('auth-announcer').textContent).toBe('로그인되었습니다.');

  announceAuthTransition(null, 'session-expired');
  expect(document.activeElement).toBe(document.getElementById('login-title'));
  expect(document.getElementById('auth-announcer').textContent).toBe('세션이 만료되었습니다. 다시 로그인해 주세요.');
});

test('legacy data work stays at zero until authenticated session readiness resolves', async () => {
  const { ready, publish } = createAuthenticatedSessionGate();
  const dataRequest = vi.fn();
  ready.then(dataRequest);

  publish(null);
  await Promise.resolve();

  expect(dataRequest).not.toHaveBeenCalled();

  const user = { id: 'user-1', email: 'member@example.com', displayName: '팀원', role: 'member' };
  publish(user);
  await ready;

  expect(dataRequest).toHaveBeenCalledOnce();
  expect(dataRequest).toHaveBeenCalledWith(user);
});

test('the real legacy startup sends zero data requests before authentication', async () => {
  const script = await readFile(`${process.cwd()}/app.js`, 'utf8');
  const fakeFetch = vi.fn().mockResolvedValue(jsonResponse(200, []));
  const fakeStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal('fetch', fakeFetch);
  window.ONEBOARD_SESSION_READY = new Promise(() => {});

  Function('window', 'document', 'localStorage', 'sessionStorage', script)(
    window,
    document,
    fakeStorage,
    fakeStorage,
  );
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fakeFetch).not.toHaveBeenCalled();
});

async function loadLegacyHooks() {
  const script = await readFile(`${process.cwd()}/app.js`, 'utf8');
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  return Function('window', 'document', 'localStorage', 'sessionStorage', `${script}\nreturn { init, fetchAPIDailyData, startNotificationPolling, stopNotificationPolling, bindEvents, renderTaskList };`)(
    window,
    document,
    storage,
    storage,
  );
}

test('retained task controls invoke authenticated create, update, and delete APIs', async () => {
  document.body.innerHTML = `
    <button id="addTaskBtn"></button><button id="refreshTeamBtn"></button>
    <div id="intBlockers"></div><div id="taskModal" style="display:none"></div>
    <div id="taskModalTitle"></div><div id="taskMutationStatus"></div>
    <input id="taskDate"><input id="taskAssignee"><input id="taskAssignedUserId">
    <input id="taskContent"><select id="taskStatus"><option value="예정">예정</option><option value="완료">완료</option></select>
    <select id="taskPriority"><option value="보통">보통</option></select><input id="taskMemo">
    <button id="closeTaskModal"></button><button id="cancelTask"></button>
    <button id="saveTask"></button><button id="deleteTask"></button>
  `;
  window.ONEBOARD_CURRENT_USER = { id: 'ops-1', role: 'ops' };
  const task = {
    id: 'task-1', date: '2026-09-03', assignee: 'Assigned user', assigned_user_id: 'user-2',
    task: 'Initial task', status: '예정', priority: '보통', memo: '',
  };
  window.ONEBOARD_API = Object.freeze({
    fetch: vi.fn(async (path, options = {}) => {
      if (path === '/team/tasks' && options.method === 'POST') {
        return jsonResponse(201, { task });
      }
      if (path === '/team/tasks/task-1' && options.method === 'PATCH') {
        return jsonResponse(200, { task: { ...task, status: '완료' } });
      }
      if (path === '/team/tasks/task-1' && options.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (String(path).startsWith('/team/tasks?')) return jsonResponse(200, { tasks: [task] });
      throw new Error(`unexpected task request ${path}`);
    }),
  });
  const hooks = await loadLegacyHooks();
  hooks.bindEvents();

  document.getElementById('addTaskBtn').click();
  document.getElementById('taskDate').value = '2026-09-03';
  document.getElementById('taskAssignee').value = 'Assigned user';
  document.getElementById('taskAssignedUserId').value = 'user-2';
  document.getElementById('taskContent').value = 'Initial task';
  document.getElementById('saveTask').click();
  await vi.waitFor(() => expect(window.ONEBOARD_API.fetch).toHaveBeenCalledWith(
    '/team/tasks', expect.objectContaining({ method: 'POST' })
  ));

  hooks.renderTaskList([task]);
  document.querySelector('[data-task-id="task-1"]').click();
  document.getElementById('taskStatus').value = '완료';
  document.getElementById('saveTask').click();
  await vi.waitFor(() => expect(window.ONEBOARD_API.fetch).toHaveBeenCalledWith(
    '/team/tasks/task-1', expect.objectContaining({ method: 'PATCH' })
  ));

  hooks.renderTaskList([task]);
  document.querySelector('[data-task-id="task-1"]').click();
  document.getElementById('deleteTask').click();
  await vi.waitFor(() => expect(window.ONEBOARD_API.fetch).toHaveBeenCalledWith(
    '/team/tasks/task-1', expect.objectContaining({ method: 'DELETE' })
  ));
});

test('assigned members receive progress-only task controls and payloads', async () => {
  document.body.innerHTML = `
    <div id="intBlockers"></div><div id="taskModal" style="display:none"></div>
    <div id="taskModalTitle"></div><div id="taskMutationStatus"></div>
    <input id="taskDate"><input id="taskAssignee"><input id="taskAssignedUserId">
    <input id="taskContent"><select id="taskStatus"><option value="완료">완료</option></select>
    <select id="taskPriority"><option value="보통">보통</option></select><input id="taskMemo">
    <button id="closeTaskModal"></button><button id="cancelTask"></button>
    <button id="saveTask"></button><button id="deleteTask"></button>
  `;
  window.ONEBOARD_CURRENT_USER = { id: 'member-1', role: 'member' };
  const task = {
    id: 'own-task', date: '2026-09-03', assignee: 'Current user', assigned_user_id: 'member-1',
    task: 'Assigned task', status: '예정', priority: '보통', memo: '',
  };
  window.ONEBOARD_API = Object.freeze({
    fetch: vi.fn(async (path, options = {}) => {
      if (path === '/team/tasks/own-task' && options.method === 'PATCH') {
        expect(JSON.parse(options.body)).toEqual({ status: '완료', memo: 'done' });
        return jsonResponse(200, { task: { ...task, status: '완료', memo: 'done' } });
      }
      throw new Error(`unexpected task request ${path}`);
    }),
  });
  const hooks = await loadLegacyHooks();
  hooks.bindEvents();
  hooks.renderTaskList([task]);

  document.querySelector('[data-task-id="own-task"]').click();
  expect(document.getElementById('taskContent').disabled).toBe(true);
  expect(document.getElementById('deleteTask').hidden).toBe(true);
  document.getElementById('taskStatus').value = '완료';
  document.getElementById('taskMemo').value = 'done';
  document.getElementById('saveTask').click();

  await vi.waitFor(() => expect(window.ONEBOARD_API.fetch).toHaveBeenCalledOnce());
});

test('the real legacy API loader uses the authenticated adapter and preserves parsed JSON', async () => {
  const browserFetch = vi.fn();
  vi.stubGlobal('fetch', browserFetch);
  window.ONEBOARD_API = Object.freeze({
    fetch: vi.fn().mockResolvedValue(jsonResponse(200, {
      rows: [{ date: '2026-09-01', total_sales: 1000, total_traffic: 5, conversion_sales: 800, ad_spend: 100 }],
    })),
  });
  const hooks = await loadLegacyHooks();

  const rows = await hooks.fetchAPIDailyData(1);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ date: '2026-09-01', totalSales: 1000, totalAdSpend: 100 });
  expect(window.ONEBOARD_API.fetch).toHaveBeenCalledOnce();
  expect(browserFetch).not.toHaveBeenCalled();
});

test('the real legacy loader never falls through to Sheets or mock after session expiry', async () => {
  document.body.innerHTML = '<span id="dataSource"></span>';
  const browserFetch = vi.fn();
  vi.stubGlobal('fetch', browserFetch);
  const expired = Object.assign(new Error('expired'), { code: 'SESSION_EXPIRED' });
  window.ONEBOARD_API = Object.freeze({ fetch: vi.fn().mockRejectedValue(expired) });
  const hooks = await loadLegacyHooks();

  await hooks.init();

  expect(window.ONEBOARD_API.fetch).toHaveBeenCalledOnce();
  expect(browserFetch).not.toHaveBeenCalled();
  expect(document.getElementById('dataSource').textContent).toBe('');
});

test('notification polling stops on logout and restarts once after later login', async () => {
  vi.useFakeTimers();
  try {
    window.ONEBOARD_API = Object.freeze({
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, { notifications: [] })),
    });
    const hooks = await loadLegacyHooks();

    hooks.startNotificationPolling();
    hooks.startNotificationPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.ONEBOARD_API.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(window.ONEBOARD_API.fetch).toHaveBeenCalledTimes(2);

    hooks.stopNotificationPolling();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(window.ONEBOARD_API.fetch).toHaveBeenCalledTimes(2);

    hooks.startNotificationPolling();
    hooks.startNotificationPolling();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(window.ONEBOARD_API.fetch).toHaveBeenCalledTimes(4);
  } finally {
    vi.useRealTimers();
  }
});

test('production config build emits runtime config and rejects a missing Google client ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oneboard-config-'));
  const output = join(directory, 'config.js');
  try {
    const valid = spawnSync(process.execPath, ['scripts/build-config.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
        ONEBOARD_API_BASE: 'https://api.example.test/api',
        ONEBOARD_CONFIG_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    expect(valid.status, valid.stderr).toBe(0);
    const configSource = await readFile(output, 'utf8');
    const target = {};
    Function('window', configSource)(target);
    expect(target.ONEBOARD_CONFIG).toEqual({
      googleClientId: 'test-client-id.apps.googleusercontent.com',
      apiBase: 'https://api.example.test/api',
    });

    const missing = spawnSync(process.execPath, ['scripts/build-config.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        GOOGLE_CLIENT_ID: '',
        ONEBOARD_API_BASE: 'https://api.example.test/api',
        ONEBOARD_CONFIG_OUTPUT: join(directory, 'missing.js'),
      },
      encoding: 'utf8',
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/GOOGLE_CLIENT_ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
