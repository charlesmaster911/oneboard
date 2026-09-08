import { beforeEach, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import * as collaboration from '../modules/collaboration.js';

const YM = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

async function loadBoard({ role = 'owner', fetchImpl }) {
  document.body.innerHTML = `
    <span id="dataStatusBadge"></span>
    <div id="memberTabButtons"></div>
    <div id="intBlockers"></div><div id="intAlerts"></div><div id="intMinutes"></div><div id="intCalLegend"></div>
    <span id="intCalLabel"></span><div id="intCalGrid"></div>
    <span id="weeklyMonthLabel"></span><div id="weeklyGrid"></div>
    <button id="weeklyPrev"></button><button id="weeklyNext"></button>`;
  window.ONEBOARD_CURRENT_USER = { id: 'owner-1', role, name: '찰스' };
  window.ONEBOARD_COLLABORATION = collaboration;
  window.ONEBOARD_API = { fetch: fetchImpl };
  const script = await readFile(`${process.cwd()}/app.js`, 'utf8');
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  return Function('window', 'document', 'localStorage', 'sessionStorage', `${script}
    return {
      bindEvents, renderIntegratedCalendar, renderWeeklyPanel,
      setTasks: (tasks) => { teamTasks = tasks; },
      setRoster: (roster) => { teamRoster = roster; },
      setMonth: (date) => { integratedCalendarMonth = date; },
    };`)(window, document, storage, storage);
}

function fire(element, type, dataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = dataTransfer;
  element.dispatchEvent(event);
  return event;
}

function dragFrom(item) {
  const store = {};
  const dataTransfer = { setData: (key, value) => { store[key] = value; }, getData: (key) => store[key] || '', effectAllowed: '', dropEffect: '' };
  fire(item, 'dragstart', dataTransfer);
  return dataTransfer;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

test('dragging a calendar task onto another day patches its date and re-renders it there', async () => {
  const calls = [];
  const fetchImpl = vi.fn(async (path, options = {}) => {
    calls.push([path, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    if (path.startsWith('/team/weekly')) return jsonResponse({ rows: [] });
    return jsonResponse({ task: { id: 't1', date: `${YM}-10` } });
  });
  const board = await loadBoard({ fetchImpl });
  board.setRoster(['권나경']);
  const tasks = [{ id: 't1', date: `${YM}-03`, assignee: '권나경', task: '블로그 발행', status: '예정', priority: '보통' }];
  board.setTasks(tasks);
  board.setMonth(new Date(`${YM}-01T00:00:00`));
  board.renderIntegratedCalendar(tasks);
  board.bindEvents();

  const item = document.querySelector('[data-task-id="t1"]');
  expect(item.draggable).toBe(true);
  const dataTransfer = dragFrom(item);
  const targetCell = document.querySelector(`[data-date="${YM}-10"]`);
  fire(targetCell, 'dragover', dataTransfer);
  expect(targetCell.classList.contains('cal-drop-over')).toBe(true);
  fire(targetCell, 'drop', dataTransfer);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContainEqual(['/team/tasks/t1', 'PATCH', { date: `${YM}-10` }]);
  expect(document.querySelector(`[data-date="${YM}-10"] [data-task-id="t1"]`)).not.toBeNull();
  expect(document.querySelector(`[data-date="${YM}-03"] [data-task-id="t1"]`)).toBeNull();
});

test('a member cannot drag calendar tasks', async () => {
  const board = await loadBoard({ role: 'member', fetchImpl: vi.fn(async () => jsonResponse({ rows: [] })) });
  board.setMonth(new Date(`${YM}-01T00:00:00`));
  board.renderIntegratedCalendar([{ id: 't1', date: `${YM}-03`, assignee: '권나경', task: '블로그', status: '예정' }]);
  expect(document.querySelector('[data-task-id="t1"]').draggable).toBe(false);
});

test('weekly section renders six slots per member and moves an item between slots by drag and drop', async () => {
  const calls = [];
  const rows = [
    { id: 'w1', member_id: '권나경', ym: YM, slot: '1주차', text: '블로그 2편', done: false, sort_order: 0 },
    { id: 'w2', member_id: '권나경', ym: YM, slot: '2주차', text: '릴스 1편', done: true, sort_order: 0 },
  ];
  const fetchImpl = vi.fn(async (path, options = {}) => {
    calls.push([path, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    if (options.method === 'PATCH') {
      const row = rows.find((candidate) => path.endsWith(candidate.id));
      Object.assign(row, JSON.parse(options.body));
      return jsonResponse({ row });
    }
    return jsonResponse({ rows });
  });
  const board = await loadBoard({ fetchImpl });
  board.setRoster(['권나경']);
  board.bindEvents();
  await board.renderWeeklyPanel();

  expect(document.getElementById('weeklyMonthLabel').textContent).toBe(YM);
  expect(calls[0][0]).toBe(`/team/weekly?member_id=${encodeURIComponent('권나경')}&ym=${YM}`);
  expect([...document.querySelectorAll('.weekly-col-head')].map((head) => head.textContent))
    .toEqual(['1주차', '2주차', '3주차', '4주차', '5주차', '상시']);
  expect(document.querySelector('[data-weekly-id="w2"]').classList.contains('done')).toBe(true);

  const dataTransfer = dragFrom(document.querySelector('[data-weekly-id="w1"]'));
  const target = document.querySelector('.weekly-col[data-slot="2주차"]');
  fire(target, 'drop', dataTransfer);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContainEqual(['/team/weekly/w1', 'PATCH', { slot: '2주차', sort_order: 1 }]);
  expect(document.querySelector('.weekly-col[data-slot="2주차"] [data-weekly-id="w1"]')).not.toBeNull();
  expect(document.querySelector('.weekly-col[data-slot="1주차"] [data-weekly-id]')).toBeNull();
});
