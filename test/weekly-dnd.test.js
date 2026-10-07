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
      bindEvents, renderIntegratedCalendar, renderWeeklyPanel, renderTeamSection, renderMinutesSection, loadMemberSettings,
      setMembers: (rows) => { teamMemberRecords = rows; },
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

test('daily disclosure exposes all tasks without mutations or opening the add dialog and survives rerender', async () => {
  const fetchImpl = vi.fn();
  const board = await loadBoard({ fetchImpl });
  document.body.insertAdjacentHTML('beforeend', '<div id="taskModal" style="display:none"></div>');
  const tasks = Array.from({ length: 7 }, (_, i) => ({
    id: `t${i}`, date: `${YM}-03`, assignee: '권나경', task: `긴 업무 제목 ${i}`, status: '완료',
  }));
  board.setTasks(tasks);
  board.setMonth(new Date(`${YM}-01T00:00:00`));
  board.renderIntegratedCalendar(tasks);
  board.bindEvents();
  let cell = document.querySelector(`[data-date="${YM}-03"]`);
  expect(cell.querySelectorAll('[data-task-id]:not([hidden])')).toHaveLength(4);
  const more = cell.querySelector('.cal-month-more');
  more.focus();
  more.click();
  expect(document.activeElement).toBe(more);
  expect(cell.querySelectorAll('[data-task-id]:not([hidden])')).toHaveLength(7);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  expect(cell.querySelector('.cal-month-day-num').getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById('taskModal').style.display).toBe('none');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(tasks.every(task => task.status === '완료')).toBe(true);
  board.renderIntegratedCalendar(tasks);
  cell = document.querySelector(`[data-date="${YM}-03"]`);
  expect(cell.querySelectorAll('[data-task-id]:not([hidden])')).toHaveLength(7);
  cell.querySelector('.cal-month-day-num').click();
  expect(cell.querySelectorAll('[data-task-id]:not([hidden])')).toHaveLength(4);
  expect(cell.querySelector('.cal-month-more').textContent).toBe('+3개 더 보기');
});

test('opening a calendar task shows its full content and preserves status without saving', async () => {
  const fetchImpl = vi.fn();
  const board = await loadBoard({ fetchImpl });
  document.body.insertAdjacentHTML('beforeend', '<div id="taskModal" style="display:none"></div><input id="taskContent"><select id="taskStatus"><option>완료</option></select>');
  const tasks = [{ id: 'detail', date: `${YM}-03`, assignee: '권나경', task: '말줄임 없이 확인해야 하는 아주 긴 업무 내용', status: '완료' }];
  board.setTasks(tasks);
  board.setMonth(new Date(`${YM}-01T00:00:00`));
  board.renderIntegratedCalendar(tasks);
  board.bindEvents();
  document.querySelector('[data-task-id="detail"]').click();
  expect(document.getElementById('taskModal').style.display).toBe('flex');
  expect(document.getElementById('taskContent').value).toBe(tasks[0].task);
  expect(document.getElementById('taskStatus').value).toBe('완료');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('weekly disclosure is read-only, per-slot, and retained after refreshing the panel', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, member_id: '권나경', ym: YM, slot: '1주차', text: `주간 ${i}`, done: false, sort_order: i }));
  const fetchImpl = vi.fn(async () => jsonResponse({ rows }));
  const board = await loadBoard({ fetchImpl });
  board.setRoster(['권나경']);
  board.bindEvents();
  await board.renderWeeklyPanel(rows);
  expect(document.querySelectorAll('.weekly-item:not([hidden])')).toHaveLength(3);
  document.querySelector('.weekly-more').click();
  expect(document.querySelectorAll('.weekly-item:not([hidden])')).toHaveLength(6);
  await board.renderWeeklyPanel(rows);
  expect(document.querySelector('.weekly-more').getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelectorAll('.weekly-item:not([hidden])')).toHaveLength(6);
  document.querySelector('.weekly-more').click();
  expect(document.querySelectorAll('.weekly-item:not([hidden])')).toHaveLength(3);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('team loads four resources concurrently and switching to minutes reuses the response', async () => {
  const releases = [];
  const fetchImpl = vi.fn((path) => new Promise(resolve => {
    releases.push(() => resolve(jsonResponse(path.includes('/roster')
      ? { members: ['권나경'] } : { tasks: [], minutes: [], rows: [] })));
  }));
  const board = await loadBoard({ fetchImpl });
  document.body.insertAdjacentHTML('beforeend', '<div id="minutesList"></div>');
  const pending = board.renderTeamSection();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(fetchImpl.mock.calls.map(call => call[0])).toContain(`/team/weekly?ym=${YM}`);
  releases.forEach(release => release());
  await pending;
  await board.renderMinutesSection();
  await board.renderTeamSection();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
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
  expect(calls[0][0]).toBe(`/team/weekly?ym=${YM}`);
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

test('a member uses the explicit add button to file a task for themselves on that date', async () => {
  const calls = [];
  const fetchImpl = vi.fn(async (path, options = {}) => {
    calls.push([path, options.method || 'GET', options.body ? JSON.parse(options.body) : null]);
    if (path.startsWith('/team/weekly')) return jsonResponse({ rows: [] });
    return jsonResponse({ task: { id: 't9', date: `${YM}-12`, assignee: '권나경', assigned_user_id: 'member-1', task: '블로그 발행' } });
  });
  document.body.innerHTML = '';
  const board = await loadBoard({ role: 'member', fetchImpl });
  window.ONEBOARD_CURRENT_USER = { id: 'member-1', role: 'member', displayName: '권나경' };
  document.body.insertAdjacentHTML('beforeend', `
    <div id="taskModal" style="display:none"></div><div id="taskModalTitle"></div><div id="taskMutationStatus"></div>
    <input id="taskDate"><select id="taskAssignee"></select><input id="taskAssignedUserId">
    <input id="taskContent"><select id="taskStatus"><option value="예정">예정</option></select>
    <select id="taskPriority"><option value="보통">보통</option></select><input id="taskMemo">
    <button id="saveTask"></button><button id="deleteTask"></button>`);
  board.setRoster(['권나경']);
  board.setMonth(new Date(`${YM}-01T00:00:00`));
  board.renderIntegratedCalendar([]);
  board.bindEvents();

  document.querySelector(`[data-date="${YM}-12"] .cal-month-add`).click();
  expect(document.getElementById('taskModal').style.display).toBe('flex');
  expect(document.getElementById('taskDate').value).toBe(`${YM}-12`);
  expect(document.getElementById('taskAssignee').value).toBe('권나경');
  expect(document.getElementById('taskAssignee').disabled).toBe(true);
  expect(document.getElementById('taskContent').disabled).toBe(false);

  document.getElementById('taskContent').value = '블로그 발행';
  document.getElementById('saveTask').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toContainEqual(['/team/tasks', 'POST', expect.objectContaining({ date: `${YM}-12`, assignee: '권나경', assigned_user_id: 'member-1', task: '블로그 발행' })]);
});

test('retired history is opt-in while upcoming members remain assignable without accounts', async () => {
  const rows=[{name:'신입',status:'upcoming'},{name:'퇴사자',status:'retired'}];
  const tasks=[{id:'new',assignee:'신입',date:YM+'-03',task:'입사 준비'},{id:'old',assignee:'퇴사자',date:YM+'-03',task:'기존 기록'}];
  const fetchImpl=vi.fn(async path=>jsonResponse(path.startsWith('/team/roster')?{members:['신입'],records:rows}:path.startsWith('/team/tasks')?{tasks}:path.startsWith('/team/minutes')?{minutes:[]}:{rows:[]}));
  const board=await loadBoard({fetchImpl});
  document.body.insertAdjacentHTML('beforeend','<input type="checkbox" id="showRetiredMembers"><select id="taskAssignee"></select>');
  board.bindEvents();await board.renderTeamSection();
  expect(document.querySelector('[data-member="신입"]').textContent).toContain('입사 예정');
  expect(document.querySelector('[data-member="퇴사자"]')).toBeNull();
  expect(document.querySelector('#intCalGrid [data-task-id="old"]')).toBeNull();
  document.getElementById('showRetiredMembers').click();
  expect(document.querySelector('[data-member="퇴사자"]').textContent).toContain('퇴사');
  expect(document.querySelector('#intCalGrid [data-task-id="old"]')).not.toBeNull();
  expect([...document.querySelectorAll('#taskAssignee option')].map(x=>x.value)).not.toContain('퇴사자');
  expect(fetchImpl.mock.calls.every(([,o])=>!o?.method || o.method==='GET')).toBe(true);
});

test('team member settings submits name and employment state without creating a login account', async()=>{
  const calls=[];const records=[];
  const fetchImpl=vi.fn(async(path,options={})=>{calls.push([path,options]);if(path==='/team/members'){if(options.method==='POST')records.push({id:'member1',...JSON.parse(options.body)});return jsonResponse({records});}if(path==='/team/roster')return jsonResponse({members:records.map(r=>r.name),records});return jsonResponse({tasks:[],minutes:[],rows:[]});});
  const board=await loadBoard({fetchImpl});
  const html=await readFile(`${process.cwd()}/index.html`,'utf8');
  document.body.insertAdjacentHTML('beforeend',new DOMParser().parseFromString(html,'text/html').querySelector('.team-member-settings').outerHTML);
  board.bindEvents();await board.loadMemberSettings();
  document.getElementById('memberName').value='새 팀장';document.getElementById('memberEmploymentStatus').value='upcoming';document.getElementById('memberStartMonth').value='2026-10';
  document.getElementById('memberSettingsForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await vi.waitFor(()=>expect(document.getElementById('memberSettingsStatus').textContent).toContain('저장 완료'));
  const writes=calls.filter(([,o])=>o.method==='POST');expect(writes).toHaveLength(1);expect(writes[0][0]).toBe('/team/members');expect(JSON.parse(writes[0][1].body)).toEqual({name:'새 팀장',title:'',status:'upcoming',start_month:'2026-10',end_date:null});
  expect(document.querySelector('[data-member="새 팀장"]')).not.toBeNull();
});
