import { beforeEach, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  applyRoleVisibility,
  applyTaskMutationPolicy,
  applyUiPolicy,
  canMutateAssignedTask,
  createElement,
  formatDateTime,
  formatWon,
  replaceChildren,
  setText,
} from '../modules/dom.js';
import { renderAuthShell, renderPlatformDetail } from '../modules/main.js';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('safe DOM helpers', () => {
  test('setText renders malicious markup as literal text', () => {
    const element = document.createElement('div');

    setText(element, '<img onerror=alert(1)>');

    expect(element.textContent).toBe('<img onerror=alert(1)>');
    expect(element.querySelector('img')).toBeNull();
  });

  test('createElement and replaceChildren keep user text inert', () => {
    const parent = document.createElement('div');
    const child = createElement('span', {
      className: 'user-name',
      text: '<script>window.pwned=true</script>',
      attributes: { 'aria-label': 'current user' },
    });

    replaceChildren(parent, child);

    expect(parent.firstElementChild).toBe(child);
    expect(child.textContent).toBe('<script>window.pwned=true</script>');
    expect(child.querySelector('script')).toBeNull();
    expect(child.getAttribute('aria-label')).toBe('current user');
  });

  test('format helpers return Korean display values for valid inputs', () => {
    expect(formatWon(1234567)).toBe('₩1,234,567');
    expect(formatWon('not-a-number')).toBe('—');
    expect(formatDateTime('2026-09-01T12:34:00+09:00')).toMatch(/2026/);
    expect(formatDateTime('invalid')).toBe('—');
  });
});

describe('authenticated shell visibility', () => {
  test('an unauthenticated state hides the app shell and shows login', () => {
    document.body.innerHTML = `
      <section id="login-screen" hidden></section>
      <main id="app-shell"></main>
      <span id="current-user"></span>
      <span id="current-role"></span>
    `;

    renderAuthShell(null);

    expect(document.querySelector('#login-screen').hidden).toBe(false);
    expect(document.querySelector('#app-shell').hidden).toBe(true);
  });

  test.each(['member', 'marketing', 'system'])('%s cannot see owner/ops controls', (role) => {
    document.body.innerHTML = `
      <button id="restricted" data-roles="owner,ops">Restricted</button>
      <button id="shared" data-roles="owner,ops,marketing,member,system">Shared</button>
    `;

    applyRoleVisibility(role);

    expect(document.querySelector('#restricted').hidden).toBe(true);
    expect(document.querySelector('#shared').hidden).toBe(false);
  });

  test.each(['owner', 'ops'])('%s can see owner/ops controls', (role) => {
    document.body.innerHTML = '<button id="restricted" data-roles="owner,ops">Restricted</button>';

    applyRoleVisibility(role);

    expect(document.querySelector('#restricted').hidden).toBe(false);
  });

  test('a non-canonical role cannot see role-scoped controls', () => {
    document.body.innerHTML = '<button id="restricted" data-roles="owner,ops">Restricted</button>';

    applyRoleVisibility('admin');

    expect(document.querySelector('#restricted').hidden).toBe(true);
  });

  test.each([
    ['owner', ['sales', 'team', 'minutes', 'kpi', 'manual', 'settings']],
    ['ops', ['sales', 'team', 'minutes', 'kpi', 'manual']],
    ['marketing', ['sales', 'team', 'kpi', 'manual']],
    ['member', ['sales', 'team', 'kpi', 'manual']],
    ['system', []],
  ])('%s sees only canonical interactive sections', (role, visibleSections) => {
    document.body.innerHTML = ['sales', 'team', 'minutes', 'kpi', 'manual', 'settings']
      .map((section) => `<button data-section="${section}"></button>`)
      .join('');

    applyUiPolicy({ id: `${role}-1`, role });

    const visible = [...document.querySelectorAll('[data-section]')]
      .filter((element) => !element.hidden)
      .map((element) => element.dataset.section);
    expect(visible).toEqual(visibleSections);
  });

  test('marketing and member may change progress only on work assigned by authenticated user id', () => {
    for (const role of ['marketing', 'member']) {
      const user = { id: `${role}-1`, role };
      expect(canMutateAssignedTask(user, { assignedUserId: user.id }, ['status', 'memo'])).toBe(true);
      expect(canMutateAssignedTask(user, { assignedUserId: 'other-user' }, ['status'])).toBe(false);
      expect(canMutateAssignedTask(user, { assignedUserId: user.id }, ['task'])).toBe(false);
    }
  });

  test('task mutation controls distinguish workspace management from assigned progress', () => {
    document.body.innerHTML = `
      <button data-task-control="structure"></button>
      <button data-task-control="progress"></button>
      <button data-task-control="delete"></button>
    `;
    const user = { id: 'member-1', role: 'member' };

    applyTaskMutationPolicy(user, { assignedUserId: 'member-1' });

    expect(document.querySelector('[data-task-control="structure"]').hidden).toBe(true);
    expect(document.querySelector('[data-task-control="progress"]').hidden).toBe(false);
    expect(document.querySelector('[data-task-control="delete"]').hidden).toBe(true);
  });
});

test('platform detail constructs inert DOM for malicious platform_raw values', () => {
  const target = document.createElement('div');
  const malicious = '<img src=x onerror="window.pwned=true">';

  renderPlatformDetail(target, [{
    platform: 'etc',
    platform_raw: `etc:${malicious}`,
    total_sales: 1000,
    ad_spend: 10,
  }]);

  expect(target.textContent).toContain(malicious);
  expect(target.querySelector('img')).toBeNull();
  expect(window.pwned).toBeUndefined();
});

test('the page keeps every board section behind Google login and removes the password gate', async () => {
  const source = await readFile(`${process.cwd()}/index.html`, 'utf8');
  const page = new DOMParser().parseFromString(source, 'text/html');

  expect(page.querySelector('#login-screen #google-signin')).not.toBeNull();
  expect(page.querySelector('#app-shell #current-user')).not.toBeNull();
  expect(page.querySelector('#app-shell #current-role')).not.toBeNull();
  expect(page.querySelector('#app-shell #logout-button')).not.toBeNull();
  expect(page.querySelector('#auth-announcer[aria-live]')).not.toBeNull();
  expect(page.querySelectorAll('#app-shell .section-content').length).toBe(6);
  expect(page.querySelector('#settingsPassword')).toBeNull();
  expect(page.querySelector('#settingsUnlock')).toBeNull();
  expect(page.querySelector('#settingsLockBtn')).toBeNull();
});

test('production sources contain no historical identity or target sentinels', async () => {
  const files = [
    'index.html', 'style.css', 'app.js',
    'modules/api.js', 'modules/auth.js', 'modules/dom.js', 'modules/main.js',
  ];
  const source = (await Promise.all(files.map((file) => readFile(`${process.cwd()}/${file}`, 'utf8')))).join('\n');

  expect(source).not.toMatch(/이한수|권나경|권수지|찰스|컨텐츠팀|JEWELICE|쥬얼아이스|20억/i);
});

test('the retained page exposes only wired buttons and explicit non-loading states', async () => {
  const source = await readFile(`${process.cwd()}/index.html`, 'utf8');
  const page = new DOMParser().parseFromString(source, 'text/html');
  const allowedButtonIds = new Set([
    'logout-button', 'notifBell', 'notifReadAll', 'refreshTeamBtn', 'addTaskBtn',
    'closeTaskModal', 'cancelTask', 'saveTask', 'deleteTask',
    'intCalPrev', 'intCalNext', 'intCalToday',
    'addMinutesBtn', 'closeMinutesModal', 'cancelMinutes', 'saveMinutes', 'deleteMinutes',
    'refreshKpiBtn', 'refreshManualBtn', 'refreshSettingsBtn', 'runAllSyncBtn',
  ]);
  const unaccounted = [...page.querySelectorAll('button')].filter((button) => (
    !button.dataset.section && !allowedButtonIds.has(button.id)
  ));

  expect(unaccounted.map((button) => button.outerHTML)).toEqual([]);
  expect(source).not.toMatch(/로딩 중|데이터 로딩|확인 중/);
  expect(source).not.toMatch(/onclick\s*=/i);
});

test('team work restores the original integrated calendar and minutes restore detail input', async () => {
  const source = await readFile(`${process.cwd()}/index.html`, 'utf8');
  const page = new DOMParser().parseFromString(source, 'text/html');

  expect(page.querySelector('#memberTabs')).not.toBeNull();
  expect(page.querySelector('#integratedView')).not.toBeNull();
  expect(page.querySelector('#intBlockers')).not.toBeNull();
  expect(page.querySelector('#intCalGrid')).not.toBeNull();
  expect(page.querySelector('#intMinutes')).not.toBeNull();
  expect(page.querySelector('#intAlerts')).not.toBeNull();
  expect(page.querySelector('#minutesSearch')).not.toBeNull();
  expect(page.querySelector('#minutesViewer')).not.toBeNull();
  expect(page.querySelector('#addMinutesBtn')).not.toBeNull();
  expect(page.querySelector('#minutesModal')).not.toBeNull();
  expect(page.querySelector('#minutesDate')).not.toBeNull();
  expect(page.querySelector('#minutesTitle')).not.toBeNull();
  expect(page.querySelector('#minutesAttendees')).not.toBeNull();
  expect(page.querySelector('#minutesSummary')).not.toBeNull();
  expect(page.querySelector('#minutesDirectives')).not.toBeNull();
  expect(page.querySelector('#minutesContent')).not.toBeNull();
});

test('runtime config loads before application modules and production sources contain no browser Sheets path or real presets', async () => {
  const [indexSource, appSource, readmeSource, renderSource] = await Promise.all([
    readFile(`${process.cwd()}/index.html`, 'utf8'),
    readFile(`${process.cwd()}/app.js`, 'utf8'),
    readFile(`${process.cwd()}/README.md`, 'utf8'),
    readFile(`${process.cwd()}/render.yaml`, 'utf8'),
  ]);
  const page = new DOMParser().parseFromString(indexSource, 'text/html');
  const scripts = [...page.querySelectorAll('script[src]')].map((script) => script.getAttribute('src'));

  expect(scripts.indexOf('config.js')).toBeLessThan(scripts.indexOf('modules/main.js'));
  expect(`${indexSource}\n${appSource}`).not.toMatch(/docs\.google\.com\/spreadsheets|script\.google\.com\/macros/);
  expect(appSource).not.toContain('SHEET_TASKS_PRESET');
  expect(appSource).not.toContain('TEAM_MEMBERS = [');
  expect(readmeSource).not.toMatch(/localStorage|Google Sheets CSV|buildless|빌드 없이/);
  expect(renderSource).toContain('GOOGLE_CLIENT_ID');
  expect(renderSource).toContain('ONEBOARD_API_BASE');
  expect(renderSource).toContain('npm run build');
});
