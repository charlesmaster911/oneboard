import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';

const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
async function load(fetch) {
  const script = await readFile(`${process.cwd()}/app.js`, 'utf8');
  const fakeWindow = { ONEBOARD_CURRENT_USER: { id: 'owner', role: 'owner' }, ONEBOARD_API: { fetch }, addEventListener() {} };
  const storage = { getItem: () => null };
  const hooks = Function('window', 'document', 'localStorage', 'sessionStorage', `${script}
    return { apiFetch, clearTeamReadCache, stopAuthenticatedLifecycle, fetchWeekly };`)(
    fakeWindow, { addEventListener() {}, removeEventListener() {} }, storage, storage,
  );
  return { ...hooks, window: fakeWindow };
}
afterEach(() => vi.restoreAllMocks());

test('concurrent and repeated team reads share one request and return independent data', async () => {
  let release;
  const fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const app = await load(fetch);
  const first = app.apiFetch('/team/minutes');
  const second = app.apiFetch('/team/minutes');
  release(response({ minutes: [{ title: 'Original' }] }));
  const [a, b] = await Promise.all([first, second]);
  a.minutes[0].title = 'Edited';
  expect(b.minutes[0].title).toBe('Original');
  expect((await app.apiFetch('/team/minutes')).minutes[0].title).toBe('Original');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('expiry and explicit refresh fetch new data', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.fn(async () => response({ tasks: [] }));
  const app = await load(fetch);
  await app.apiFetch('/team/tasks');
  now += 30001;
  await app.apiFetch('/team/tasks');
  app.clearTeamReadCache();
  await app.apiFetch('/team/tasks');
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('meeting writes invalidate both minutes and generated team tasks', async () => {
  const fetch = vi.fn(async () => response({ tasks: [], minutes: [] }));
  const app = await load(fetch);
  await app.apiFetch('/team/tasks');
  await app.apiFetch('/team/minutes');
  await app.apiFetch('/team/minutes', { method: 'POST' });
  await app.apiFetch('/team/tasks');
  await app.apiFetch('/team/minutes');
  expect(fetch).toHaveBeenCalledTimes(5);
});

test('failed reads retry and never become cached empty successes', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({}, false)).mockResolvedValue(response({ minutes: [] }));
  const app = await load(fetch);
  await expect(app.apiFetch('/team/minutes')).rejects.toThrow();
  await app.apiFetch('/team/minutes');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('logout discards a pending result and a new session cannot reuse it', async () => {
  let release;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue(response({ minutes: [] }));
  const app = await load(fetch);
  const pending = app.apiFetch('/team/minutes');
  app.stopAuthenticatedLifecycle();
  release(response({ minutes: [{ title: 'Private' }] }));
  await expect(pending).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  expect(await app.apiFetch('/team/minutes')).toEqual({ minutes: [] });
});

test('user and role changes cannot reuse another scope', async () => {
  const fetch = vi.fn(async () => response({ tasks: [] }));
  const app = await load(fetch);
  await app.apiFetch('/team/tasks');
  app.window.ONEBOARD_CURRENT_USER = { id: 'member', role: 'member' };
  await app.apiFetch('/team/tasks');
  app.window.ONEBOARD_CURRENT_USER.role = 'ops';
  await app.apiFetch('/team/tasks');
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('weekly loads all permitted members in one request', async () => {
  const fetch = vi.fn(async () => response({ rows: [{ member_id: 'A' }, { member_id: 'B' }] }));
  const app = await load(fetch);
  expect(await app.fetchWeekly('2026-09')).toHaveLength(2);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/team/weekly?ym=2026-09', {});
});

test('an old in-flight read cannot restore data invalidated by a successful write', async () => {
  let release;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce(response({ task: { title: 'Updated' } }))
    .mockResolvedValue(response({ tasks: [{ title: 'Updated' }] }));
  const app = await load(fetch);
  const oldRead = app.apiFetch('/team/tasks');
  await app.apiFetch('/team/tasks/1', { method: 'PATCH' });
  release(response({ tasks: [{ title: 'Old' }] }));
  expect((await oldRead).tasks[0].title).toBe('Updated');
  expect((await app.apiFetch('/team/tasks')).tasks[0].title).toBe('Updated');
  expect(fetch).toHaveBeenCalledTimes(3);
});
