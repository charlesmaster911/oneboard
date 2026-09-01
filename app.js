/**
 * OneBoard browser application.
 *
 * Operational data has one source: the authenticated OneBoard backend. The
 * browser intentionally has no capability URL, public dataset, local business
 * preset, or detailed fallback. When an endpoint is unavailable the UI stays
 * empty or shows the permitted aggregate response.
 */

function isSessionExpired(error) {
  return error?.code === 'SESSION_EXPIRED';
}

function currentUser() {
  return window.ONEBOARD_CURRENT_USER || null;
}

function isWorkspaceManager(user = currentUser()) {
  return user?.role === 'owner' || user?.role === 'ops';
}

function mayViewDetail(user = currentUser()) {
  return ['owner', 'ops', 'marketing'].includes(user?.role);
}

function isOwnTask(task, user = currentUser()) {
  const assignedUserId = task?.assignedUserId || task?.assigned_user_id;
  return Boolean(user?.id && assignedUserId && String(assignedUserId) === String(user.id));
}

async function authenticatedResponse(path, options = {}) {
  const adapter = window.ONEBOARD_API?.fetch;
  if (typeof adapter !== 'function') throw new Error('AUTHENTICATED_API_UNAVAILABLE');
  const signal = options.signal || legacyLifecycleController?.signal;
  return adapter(path, signal ? { ...options, signal } : options);
}

async function apiFetch(path, options = {}) {
  const response = await authenticatedResponse(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error('ONEBOARD_API_REQUEST_FAILED');
    error.status = response.status;
    error.code = payload?.error?.code || 'API_REQUEST_FAILED';
    throw error;
  }
  return payload;
}

function setText(idOrElement, value) {
  const element = typeof idOrElement === 'string'
    ? document.getElementById(idOrElement)
    : idOrElement;
  if (element) element.textContent = value == null ? '' : String(value);
  return element;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function formatWon(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `₩${Math.round(amount).toLocaleString('ko-KR')}` : '—';
}

function formatNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount).toLocaleString('ko-KR') : '—';
}

function dateRange(days = 30) {
  const to = new Date().toISOString().slice(0, 10);
  const safeDays = Number.isInteger(days) && days > 0 ? days : 30;
  const from = new Date(Date.now() - (safeDays - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

let legacyLifecycleController = null;
let legacyLifecycleActive = false;
let legacyDomReady = document.readyState !== 'loading';
let allData = [];
let teamTasks = [];
let notificationPollTimer = null;
let notificationPollGeneration = 0;
let editingTaskId = null;

async function fetchAPIDailyData(days = 30) {
  const { from, to } = dateRange(days);
  const response = await authenticatedResponse(`/data/daily?from=${from}&to=${to}`);
  if (response.status === 403 || !response.ok) return [];
  const payload = await response.json().catch(() => null);
  return (payload?.rows || []).map((row) => {
    const sales = Number(row.total_sales || 0);
    const adSpend = Number(row.ad_spend || 0);
    const conversionSales = Number(row.conversion_sales || 0);
    return {
      date: String(row.date || '').slice(0, 10),
      totalSales: sales,
      totalTraffic: Number(row.total_traffic || 0),
      convSales: conversionSales,
      totalAdSpend: adSpend,
      totalROAS: adSpend > 0 ? Math.round(sales / adSpend * 100) : 0,
      convROAS: adSpend > 0 ? Math.round(conversionSales / adSpend * 100) : 0,
      adRatio: sales > 0 ? Number((adSpend / sales * 100).toFixed(2)) : 0,
    };
  });
}

async function fetchPermittedSummary(days = 30) {
  const { from, to } = dateRange(days);
  const response = await authenticatedResponse(`/data/summary?from=${from}&to=${to}`);
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.totals || null;
}

function renderSummary(totals, { partial = false } = {}) {
  setText('val-sales', formatWon(totals?.total_sales || 0));
  setText('val-traffic', formatNumber(totals?.total_traffic || 0));
  setText('val-adspend', formatWon(totals?.ad_spend || 0));
  setText('val-roas', totals?.roas == null ? '—' : `${Number(totals.roas).toLocaleString('ko-KR')}%`);
  setText('dataSource', partial ? '권한에 맞는 요약 데이터' : '인증된 API');
}

function renderDailyTable(rows) {
  const body = document.getElementById('tableBody');
  if (!body) return;
  const fragment = document.createDocumentFragment();
  if (!rows.length) {
    const tr = createElement('tr');
    const td = createElement('td', 'loading-row', '상세 데이터를 표시할 수 없습니다.');
    td.colSpan = 7;
    tr.appendChild(td);
    fragment.appendChild(tr);
  } else {
    for (const row of rows) {
      const tr = createElement('tr');
      [
        row.date,
        formatWon(row.totalSales),
        formatNumber(row.totalTraffic),
        formatWon(row.convSales),
        formatWon(row.totalAdSpend),
        `${row.totalROAS}%`,
        `${row.adRatio}%`,
      ].forEach((value) => tr.appendChild(createElement('td', '', value)));
      fragment.appendChild(tr);
    }
  }
  body.replaceChildren(fragment);
}

async function fetchChannelMatrix(days = 30) {
  if (!mayViewDetail()) return [];
  const { from, to } = dateRange(days);
  const response = await authenticatedResponse(`/data/daily-by-platform?from=${from}&to=${to}`);
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return payload?.rows || [];
}

function renderChannelMatrix(rows) {
  const head = document.getElementById('channelMatrixHead');
  const body = document.getElementById('channelMatrixBody');
  if (!head || !body) return;
  const headRow = createElement('tr');
  ['날짜', '플랫폼', '매출', '광고비'].forEach((label) => headRow.appendChild(createElement('th', '', label)));
  head.replaceChildren(headRow);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = createElement('tr');
    const rawPlatform = String(row.platform_raw || row.platform || '');
    [String(row.date || '').slice(0, 10), rawPlatform, formatWon(row.total_sales), formatWon(row.ad_spend)]
      .forEach((value) => tr.appendChild(createElement('td', '', value)));
    fragment.appendChild(tr);
  }
  if (!rows.length) {
    const tr = createElement('tr');
    const td = createElement('td', 'loading-row', '표시할 상세 채널 데이터가 없습니다.');
    td.colSpan = 4;
    tr.appendChild(td);
    fragment.appendChild(tr);
  }
  body.replaceChildren(fragment);
  setText('matrixSource', rows.length ? '인증된 API' : '빈 상태');
}

function renderDayDetail(date, rows) {
  const target = document.getElementById('dayDetailBody');
  if (!target) return;
  setText('dayDetailTitle', `📅 ${date} 채널별 상세`);
  const table = createElement('table');
  const tbody = createElement('tbody');
  for (const row of rows) {
    const tr = createElement('tr');
    const rawPlatform = String(row.platform_raw || row.platform || '');
    const platform = rawPlatform.startsWith('etc:') ? rawPlatform.slice(4) : rawPlatform;
    [platform, formatWon(row.total_sales), formatWon(row.ad_spend)]
      .forEach((value) => tr.appendChild(createElement('td', '', value)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  target.replaceChildren(table);
}

function closeDayDetailModal() {
  const modal = document.getElementById('dayDetailModal');
  if (modal) modal.style.display = 'none';
}
window.closeDayDetailModal = closeDayDetailModal;

async function fetchTeamTasks(from, to) {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  try {
    const payload = await apiFetch(`/team/tasks?${query}`);
    const tasks = (payload?.tasks || []).map((task) => ({
      ...task,
      who: task.assignee,
      assignedUserId: task.assigned_user_id || null,
    }));
    const user = currentUser();
    return ['marketing', 'member'].includes(user?.role)
      ? tasks.filter((task) => isOwnTask(task, user))
      : tasks;
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return [];
  }
}

async function createTask(payload) {
  if (!isWorkspaceManager()) throw new Error('TASK_MUTATION_FORBIDDEN');
  const data = await apiFetch('/team/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: payload.date,
      assignee: payload.who || payload.assignee,
      assigned_user_id: payload.assignedUserId || payload.assigned_user_id,
      task: payload.task,
      status: payload.status,
      priority: payload.priority,
      memo: payload.memo,
    }),
  });
  return data.task;
}

async function updateTask(id, patch) {
  const existing = teamTasks.find((task) => String(task.id) === String(id));
  const user = currentUser();
  let permitted = patch;
  if (!isWorkspaceManager(user)) {
    if (!isOwnTask(existing, user) || !['marketing', 'member'].includes(user?.role)) {
      throw new Error('TASK_MUTATION_FORBIDDEN');
    }
    permitted = Object.fromEntries(Object.entries(patch).filter(([field]) => ['status', 'memo', 'comment'].includes(field)));
    if (!Object.keys(permitted).length) throw new Error('TASK_MUTATION_FORBIDDEN');
  }
  const data = await apiFetch(`/team/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(permitted),
  });
  return data.task;
}

async function deleteTask(id) {
  if (!isWorkspaceManager()) throw new Error('TASK_MUTATION_FORBIDDEN');
  await apiFetch(`/team/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  teamTasks = teamTasks.filter((task) => String(task.id) !== String(id));
}

function renderTaskList(tasks) {
  const target = document.getElementById('intBlockers');
  if (!target) return;
  teamTasks = [...tasks];
  const fragment = document.createDocumentFragment();
  for (const task of tasks) {
    const row = createElement('button', 'int3-priority-item');
    row.type = 'button';
    row.dataset.taskId = String(task.id);
    row.appendChild(createElement('span', '', `${task.date || ''} · ${task.task || ''} · ${task.status || ''}`));
    fragment.appendChild(row);
  }
  if (!tasks.length) fragment.appendChild(createElement('div', 'int3-empty', '표시할 배정 업무가 없습니다.'));
  target.replaceChildren(fragment);
}

function taskField(id) {
  return document.getElementById(id);
}

function closeTaskModal() {
  const modal = taskField('taskModal');
  if (modal) modal.style.display = 'none';
  editingTaskId = null;
  setText('taskMutationStatus', '');
}

function openTaskModal(task = null) {
  const user = currentUser();
  const manager = isWorkspaceManager(user);
  if (!task && !manager) return;
  if (task && !manager && !isOwnTask(task, user)) return;

  editingTaskId = task?.id == null ? null : String(task.id);
  const values = {
    taskDate: task?.date ? String(task.date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    taskAssignee: task?.assignee || task?.who || '',
    taskAssignedUserId: task?.assigned_user_id || task?.assignedUserId || '',
    taskContent: task?.task || '',
    taskStatus: task?.status || '예정',
    taskPriority: task?.priority || '보통',
    taskMemo: task?.memo || '',
  };
  for (const [id, value] of Object.entries(values)) {
    const field = taskField(id);
    if (field) field.value = value;
  }
  for (const id of ['taskDate', 'taskAssignee', 'taskAssignedUserId', 'taskContent', 'taskPriority']) {
    const field = taskField(id);
    if (field) field.disabled = !manager;
  }
  const remove = taskField('deleteTask');
  if (remove) remove.hidden = !manager || !task;
  setText('taskModalTitle', task ? '업무 수정' : '업무 추가');
  setText('taskMutationStatus', '');
  const modal = taskField('taskModal');
  if (modal) modal.style.display = 'flex';
  taskField(manager ? 'taskDate' : 'taskStatus')?.focus?.();
}

function taskFormPayload() {
  return {
    date: taskField('taskDate')?.value || '',
    who: taskField('taskAssignee')?.value?.trim() || '',
    assignedUserId: taskField('taskAssignedUserId')?.value?.trim() || null,
    task: taskField('taskContent')?.value?.trim() || '',
    status: taskField('taskStatus')?.value || '예정',
    priority: taskField('taskPriority')?.value || '보통',
    memo: taskField('taskMemo')?.value?.trim() || '',
  };
}

async function saveTaskFromModal() {
  const payload = taskFormPayload();
  const manager = isWorkspaceManager();
  if (manager && (!payload.date || !payload.who || !payload.task)) {
    setText('taskMutationStatus', '날짜, 담당자, 업무 내용을 입력해 주세요.');
    return;
  }
  try {
    let saved;
    if (editingTaskId) {
      const patch = manager ? {
        date: payload.date,
        assignee: payload.who,
        assigned_user_id: payload.assignedUserId,
        task: payload.task,
        status: payload.status,
        priority: payload.priority,
        memo: payload.memo,
      } : { status: payload.status, memo: payload.memo };
      saved = await updateTask(editingTaskId, patch);
      teamTasks = teamTasks.map((task) => String(task.id) === editingTaskId ? saved : task);
    } else {
      saved = await createTask(payload);
      teamTasks = [...teamTasks, saved];
    }
    renderTaskList(teamTasks);
    closeTaskModal();
  } catch {
    setText('taskMutationStatus', '업무를 저장하지 못했습니다. 권한과 입력값을 확인해 주세요.');
  }
}

async function deleteTaskFromModal() {
  if (!editingTaskId || !isWorkspaceManager()) return;
  try {
    await deleteTask(editingTaskId);
    renderTaskList(teamTasks);
    closeTaskModal();
  } catch {
    setText('taskMutationStatus', '업무를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function renderTeamSection() {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 3, 1).toISOString().slice(0, 10);
  const to = new Date(today.getFullYear(), today.getMonth() + 4, 0).toISOString().slice(0, 10);
  teamTasks = await fetchTeamTasks(from, to);
  renderTaskList(teamTasks);
  setText('dataStatusBadge', teamTasks.length ? '인증된 API' : '빈 상태');
  const add = document.getElementById('addTaskBtn');
  if (add) add.hidden = !isWorkspaceManager();
}

async function fetchMinutes() {
  if (!isWorkspaceManager()) return [];
  try {
    const data = await apiFetch('/team/minutes');
    return data.minutes || [];
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return [];
  }
}

async function renderMinutesSection() {
  const target = document.getElementById('minutesList');
  if (!target) return;
  const minutes = await fetchMinutes();
  const fragment = document.createDocumentFragment();
  for (const minute of minutes) {
    fragment.appendChild(createElement('div', 'minutes-list-item', `${minute.date || ''} · ${minute.title || ''}`));
  }
  if (!minutes.length) fragment.appendChild(createElement('div', 'empty-state', '회의록이 없습니다.'));
  target.replaceChildren(fragment);
}

async function fetchNotifications() {
  try {
    const data = await apiFetch('/notifications');
    return data.notifications || [];
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return [];
  }
}

function renderNotifications(notifications) {
  const badge = document.getElementById('notifBadge');
  const list = document.getElementById('notifList');
  if (!badge || !list) return;
  const unread = notifications.filter((notification) => !(notification.read ?? notification.is_read)).length;
  badge.style.display = unread ? 'flex' : 'none';
  badge.textContent = unread > 9 ? '9+' : String(unread);
  const fragment = document.createDocumentFragment();
  for (const notification of notifications) {
    const read = notification.read ?? notification.is_read;
    const item = createElement('div', `notif-item${read ? '' : ' unread'}`);
    item.append(
      createElement('div', 'notif-item-title', notification.title || ''),
      createElement('div', 'notif-item-body', notification.body || ''),
    );
    fragment.appendChild(item);
  }
  if (!notifications.length) fragment.appendChild(createElement('div', 'notif-empty', '알림 없음'));
  list.replaceChildren(fragment);
}

function startNotificationPolling() {
  if (notificationPollTimer !== null) return;
  const generation = ++notificationPollGeneration;
  const poll = async () => {
    try {
      const notifications = await fetchNotifications();
      if (notificationPollTimer !== null && generation === notificationPollGeneration) {
        renderNotifications(notifications);
      }
    } catch {}
  };
  notificationPollTimer = setInterval(poll, 5 * 60 * 1000);
  void poll();
}

function stopNotificationPolling() {
  notificationPollGeneration += 1;
  if (notificationPollTimer !== null) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
}

function bindEvents() {
  document.querySelectorAll('.section-btn').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.hidden) return;
      document.querySelectorAll('.section-content').forEach((section) => { section.style.display = 'none'; });
      const target = document.getElementById(`section-${button.dataset.section}`);
      if (target) target.style.display = '';
      document.querySelectorAll('.section-btn').forEach((item) => item.classList.toggle('active', item === button));
      if (button.dataset.section === 'team') void renderTeamSection();
      if (button.dataset.section === 'minutes') void renderMinutesSection();
    });
  });
  document.getElementById('notifBell')?.addEventListener('click', async () => {
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    if (dropdown.style.display === 'block') renderNotifications(await fetchNotifications());
  });
  document.getElementById('notifReadAll')?.addEventListener('click', async () => {
    try {
      await apiFetch('/notifications/read', { method: 'POST' });
      renderNotifications(await fetchNotifications());
    } catch {}
  });
  document.getElementById('dayDetailModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'dayDetailModal') closeDayDetailModal();
  });
  document.getElementById('refreshTeamBtn')?.addEventListener('click', () => {
    void renderTeamSection();
  });
  document.getElementById('addTaskBtn')?.addEventListener('click', () => openTaskModal());
  document.getElementById('intBlockers')?.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-task-id]');
    if (!row) return;
    const task = teamTasks.find((candidate) => String(candidate.id) === String(row.dataset.taskId));
    if (task) openTaskModal(task);
  });
  document.getElementById('closeTaskModal')?.addEventListener('click', closeTaskModal);
  document.getElementById('cancelTask')?.addEventListener('click', closeTaskModal);
  document.getElementById('saveTask')?.addEventListener('click', () => { void saveTaskFromModal(); });
  document.getElementById('deleteTask')?.addEventListener('click', () => { void deleteTaskFromModal(); });
  document.getElementById('taskModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'taskModal') closeTaskModal();
  });
}

let handlersBound = false;
function bindHandlersOnce() {
  if (handlersBound) return;
  handlersBound = true;
  bindEvents();
}

async function init() {
  const signal = legacyLifecycleController?.signal;
  try {
    allData = await fetchAPIDailyData(30);
    if (signal?.aborted) return;
    if (allData.length) {
      const totals = allData.reduce((sum, row) => ({
        total_sales: sum.total_sales + row.totalSales,
        total_traffic: sum.total_traffic + row.totalTraffic,
        ad_spend: sum.ad_spend + row.totalAdSpend,
      }), { total_sales: 0, total_traffic: 0, ad_spend: 0 });
      totals.roas = totals.ad_spend > 0 ? totals.total_sales / totals.ad_spend * 100 : 0;
      renderSummary(totals);
      renderDailyTable(allData);
    } else {
      const summary = await fetchPermittedSummary(30);
      if (signal?.aborted) return;
      renderSummary(summary || {}, { partial: true });
      renderDailyTable([]);
    }
    const matrixRows = await fetchChannelMatrix(30);
    if (!signal?.aborted) renderChannelMatrix(matrixRows);
  } catch (error) {
    if (isSessionExpired(error) || signal?.aborted) return;
    allData = [];
    renderSummary({}, { partial: true });
    renderDailyTable([]);
    renderChannelMatrix([]);
  }
}

async function startAuthenticatedLifecycle() {
  if (legacyLifecycleActive) return;
  legacyLifecycleActive = true;
  legacyLifecycleController = new AbortController();
  bindHandlersOnce();
  startNotificationPolling();
  await init();
}

function stopAuthenticatedLifecycle() {
  legacyLifecycleActive = false;
  legacyLifecycleController?.abort();
  legacyLifecycleController = null;
  stopNotificationPolling();
}

async function waitForAuthenticatedSession() {
  if (!window.ONEBOARD_SESSION_READY) {
    await new Promise((resolve) => window.addEventListener('oneboard:session-ready', resolve, { once: true }));
  }
  return window.ONEBOARD_SESSION_READY;
}

window.addEventListener('oneboard:auth-changed', ({ detail } = {}) => {
  if (detail?.user && detail.user.role !== 'system' && legacyDomReady) void startAuthenticatedLifecycle();
  else stopAuthenticatedLifecycle();
});

document.addEventListener('DOMContentLoaded', async () => {
  legacyDomReady = true;
  await waitForAuthenticatedSession();
  await startAuthenticatedLifecycle();
});
