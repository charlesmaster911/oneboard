import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import { apiFetch, setAccessToken } from '../modules/api.js';
import { getCurrentUser, initAuth, onAuthChanged, signOut } from '../modules/auth.js';
import { createAuthenticatedSessionGate } from '../modules/main.js';

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

    const response = await apiFetch('/data/summary');

    expect(response.status).toBe(401);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem('oneboard_access_token')).toBeNull();
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
