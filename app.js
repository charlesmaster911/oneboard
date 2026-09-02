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
let meetingMinutes = [];
let notificationPollTimer = null;
let notificationPollGeneration = 0;
let editingTaskId = null;
let editingMinutesId = null;
let selectedMinutesId = null;
let selectedTeamAssignee = '통합';
let manualDocuments = [];
let selectedManualFile = null;
let integratedCalendarMonth = (() => {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), 1);
})();
let integratedShowArchive = false;

function collaborationHelpers() {
  const helpers = window.ONEBOARD_COLLABORATION;
  if (!helpers) throw new Error('COLLABORATION_HELPERS_UNAVAILABLE');
  return helpers;
}

function workspaceHelpers() {
  const helpers = window.ONEBOARD_WORKSPACE;
  if (!helpers) throw new Error('WORKSPACE_HELPERS_UNAVAILABLE');
  return helpers;
}

function defaultKpiRange() {
  const to = new Date().toISOString().slice(0, 10);
  return { from: `${to.slice(0, 7)}-01`, to };
}

async function renderKpiSection() {
  const fromField = document.getElementById('kpiFrom');
  const toField = document.getElementById('kpiTo');
  const fallback = defaultKpiRange();
  if (fromField && !fromField.value) fromField.value = fallback.from;
  if (toField && !toField.value) toField.value = fallback.to;
  const from = fromField?.value || fallback.from;
  const to = toField?.value || fallback.to;
  setText('kpiStatus', '실제 업무 데이터를 계산하고 있습니다.');
  try {
    const payload = await apiFetch(`/kpi/team?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const totals = payload?.totals || {};
    setText('teamKpiCompletion', `${Number(totals.completionRate || 0)}%`);
    setText('teamKpiCompleted', `완료 ${Number(totals.completed || 0)} / 전체 ${Number(totals.total || 0)}`);
    setText('teamKpiOverdue', `${Number(totals.overdue || 0)}건`);
    setText('teamKpiImportant', `${Number(totals.importantOpen || 0)}건`);
    setText('teamKpiActive', `${Number(totals.activeAssignees || 0)}명`);
    const body = document.getElementById('teamKpiTable');
    const fragment = document.createDocumentFragment();
    (payload?.byAssignee || []).forEach((row) => {
      const tr = createElement('tr');
      [
        row.assignee || '미배정',
        formatNumber(row.total),
        formatNumber(row.completed),
        `${Number(row.completionRate || 0)}%`,
        formatNumber(row.overdue),
        formatNumber(row.importantOpen),
      ].forEach((value) => tr.appendChild(createElement('td', '', value)));
      fragment.appendChild(tr);
    });
    if (!fragment.childNodes.length) {
      const tr = createElement('tr');
      const td = createElement('td', 'empty-state', '선택 기간에 등록된 업무가 없습니다.');
      td.colSpan = 6;
      tr.appendChild(td);
      fragment.appendChild(tr);
    }
    body?.replaceChildren(fragment);
    setText('kpiStatus', `${from} ~ ${to} · 인증된 팀 업무 ${Number(totals.total || 0).toLocaleString('ko-KR')}건 기준`);
  } catch (error) {
    if (isSessionExpired(error)) return;
    setText('kpiStatus', 'KPI를 불러오지 못했습니다. 날짜 범위와 서버 상태를 확인하세요.');
  }
}

function appendLinkifiedText(element, text) {
  const source = String(text || '').replace(/\*\*|__|`/g, '');
  const matches = source.matchAll(/https?:\/\/[^\s)]+/g);
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) element.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const anchor = createElement('a', 'manual-link', match[0]);
    anchor.href = match[0];
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    element.appendChild(anchor);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) element.appendChild(document.createTextNode(source.slice(cursor)));
}

function renderManualContent(documentData) {
  const viewer = document.getElementById('manualViewer');
  if (!viewer) return;
  const article = createElement('div', 'manual-document');
  const header = createElement('header', 'manual-document-head');
  header.append(
    createElement('span', 'manual-doc-cat', documentData.category || '운영매뉴얼'),
    createElement('h1', '', documentData.title || '운영매뉴얼'),
    createElement('p', 'manual-doc-summary', documentData.summary || ''),
  );
  article.appendChild(header);
  const body = createElement('div', 'manual-doc-body');
  for (const block of workspaceHelpers().markdownBlocks(documentData.content)) {
    let element;
    if (block.type === 'heading') element = createElement(`h${Math.min(4, Math.max(2, block.level + 1))}`, 'manual-heading');
    else if (block.type === 'quote') element = createElement('blockquote', 'manual-quote');
    else if (block.type === 'code' || block.type === 'table-row') element = createElement('pre', 'manual-code');
    else if (block.type === 'divider') element = createElement('hr', 'manual-divider');
    else if (block.type === 'list-item') {
      element = createElement('div', 'manual-list-item');
      element.appendChild(createElement('span', 'manual-list-marker', block.checked === true ? '☑' : block.checked === false ? '☐' : block.ordered ? '•' : '•'));
    } else element = createElement('p', 'manual-paragraph');
    if (block.text !== undefined) appendLinkifiedText(element, block.text);
    body.appendChild(element);
  }
  article.appendChild(body);
  viewer.replaceChildren(article);
}

function renderManualNavigation(query = '') {
  const target = document.getElementById('manualNav');
  if (!target) return;
  const filtered = workspaceHelpers().filterManualDocuments(manualDocuments, query);
  const fragment = document.createDocumentFragment();
  let category = '';
  for (const documentData of filtered) {
    if (documentData.category !== category) {
      category = documentData.category;
      fragment.appendChild(createElement('div', 'manual-group-title', category));
    }
    const button = createElement('button', `manual-item${documentData.file === selectedManualFile ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.manualFile = documentData.file;
    const title = createElement('span', 'manual-item-title', `${documentData.hot ? '🔥 ' : ''}${documentData.title}`);
    const summary = createElement('span', 'manual-item-summary', documentData.summary || '');
    button.append(title, summary);
    fragment.appendChild(button);
  }
  if (!filtered.length) fragment.appendChild(createElement('div', 'empty-state', '검색 결과가 없습니다.'));
  target.replaceChildren(fragment);
}

async function openManualDocument(file) {
  selectedManualFile = file;
  renderManualNavigation(document.getElementById('manualSearch')?.value || '');
  const viewer = document.getElementById('manualViewer');
  if (viewer) viewer.replaceChildren(createElement('div', 'manual-placeholder', '문서를 불러오고 있습니다.'));
  try {
    const documentData = await apiFetch(`/manuals/${encodeURIComponent(file)}`);
    renderManualContent(documentData);
  } catch (error) {
    if (isSessionExpired(error)) return;
    viewer?.replaceChildren(createElement('div', 'manual-placeholder', '문서를 불러오지 못했습니다. 다시 시도하세요.'));
  }
}

async function renderManualSection() {
  try {
    const payload = await apiFetch('/manuals');
    manualDocuments = payload?.documents || [];
    renderManualNavigation(document.getElementById('manualSearch')?.value || '');
    if (!selectedManualFile && manualDocuments.length) selectedManualFile = manualDocuments.find((item) => item.hot)?.file || manualDocuments[0].file;
    if (selectedManualFile) await openManualDocument(selectedManualFile);
  } catch (error) {
    if (isSessionExpired(error)) return;
    document.getElementById('manualNav')?.replaceChildren(createElement('div', 'empty-state', '문서 목록을 불러오지 못했습니다.'));
  }
}

const PLATFORM_FORMS = Object.freeze([
  { id: 'cafe24', label: '카페24', kind: '매출', fields: [['mall_id', '쇼핑몰 ID'], ['client_id', 'Client ID'], ['client_secret', 'Client Secret']] },
  { id: 'naver_store', label: '네이버 스마트스토어', kind: '매출', fields: [['client_id', 'Client ID'], ['client_secret', 'Client Secret']] },
  { id: 'coupang', label: '쿠팡 한반도', kind: '매출', fields: [['vendor_id', 'Vendor ID'], ['access_key', 'Access Key'], ['secret_key', 'Secret Key']] },
  { id: 'meta', label: 'META 광고', kind: '광고', fields: [['ad_account_id', '광고계정 ID'], ['access_token', 'Access Token'], ['app_id', 'App ID'], ['app_secret', 'App Secret']] },
  { id: 'naver_ads', label: '네이버 검색광고', kind: '광고', fields: [['customer_id', '고객 ID'], ['api_key', 'API License'], ['secret_key', 'Secret Key']] },
  { id: 'kakao', label: '카카오모먼트', kind: '광고', fields: [['ad_account_id', '광고계정 ID'], ['access_token', 'Business Token']] },
]);

function mergePlatformStates(platforms, syncRows) {
  const byPlatform = new Map((platforms || []).map((row) => [row.platform, row]));
  const bySync = new Map((syncRows || []).map((row) => [row.platform, row]));
  return PLATFORM_FORMS.map((definition) => ({
    ...definition,
    ...(byPlatform.get(definition.id) || { connectionState: 'disconnected' }),
    syncState: bySync.get(definition.id)?.status,
    recordsSynced: bySync.get(definition.id)?.records_synced,
    completedAt: bySync.get(definition.id)?.completed_at,
  }));
}

function renderSettingsCards(states, overviewPlatforms = []) {
  const target = document.getElementById('platformSettingsGrid');
  if (!target) return;
  const fragment = document.createDocumentFragment();
  for (const state of states) {
    const presentation = workspaceHelpers().platformStatePresentation(state);
    const card = createElement('article', `platform-setting-card state-${presentation.tone}`);
    card.dataset.platform = state.id;
    const head = createElement('div', 'platform-setting-head');
    const title = createElement('div');
    title.append(createElement('span', 'platform-kind', state.kind), createElement('h3', '', state.label));
    head.append(title, createElement('span', `platform-state-badge tone-${presentation.tone}`, presentation.label));
    card.append(head, createElement('p', 'platform-state-action', presentation.action));
    if (state.lastSyncAt || state.completedAt) card.appendChild(createElement('p', 'platform-last-sync', `최근 갱신 ${new Date(state.lastSyncAt || state.completedAt).toLocaleString('ko-KR')}`));
    const identifiers = createElement('div', 'platform-identifiers');
    (state.accountIdentifiers || []).forEach((identifier) => identifiers.appendChild(createElement('span', '', `${identifier.name} ····${identifier.lastFour}`)));
    if (identifiers.childNodes.length) card.appendChild(identifiers);
    const form = createElement('form', 'platform-credential-form');
    form.dataset.platformForm = state.id;
    state.fields.forEach(([name, label]) => {
      const field = createElement('label', 'platform-field');
      field.appendChild(createElement('span', '', label));
      const input = createElement('input', 'form-input');
      input.name = name;
      input.type = /secret|token|key/i.test(name) ? 'password' : 'text';
      input.autocomplete = 'off';
      input.placeholder = state.connectionState === 'connected' ? '변경할 때만 입력' : `${label} 입력`;
      field.appendChild(input);
      form.appendChild(field);
    });
    const submit = createElement('button', 'btn-primary', state.connectionState === 'connected' ? '연결정보 변경' : '연결정보 저장');
    submit.type = 'submit';
    form.appendChild(submit);
    card.appendChild(form);
    if (state.id === 'cafe24') {
      const oauth = createElement('button', 'btn-secondary cafe24-oauth-button', '카페24 로그인 연결');
      oauth.type = 'button';
      oauth.dataset.cafe24Oauth = 'start';
      card.appendChild(oauth);
    }
    fragment.appendChild(card);
  }
  const drive = createElement('article', 'platform-setting-card state-neutral drive-import-card');
  const driveHead = createElement('div', 'platform-setting-head');
  const driveTitle = createElement('div');
  driveTitle.append(createElement('span', 'platform-kind', '매출 · 무료 자동수집'), createElement('h3', '', '카카오 톡스토어 · 선물하기'));
  driveHead.appendChild(driveTitle);
  const driveStatus = createElement('div', 'drive-channel-states');
  [
    ['kakao_talk_store', '톡스토어'],
    ['kakao_gift', '선물하기'],
  ].forEach(([id, label]) => {
    const state = overviewPlatforms.find((row) => row.id === id) || { connectionState: 'disconnected' };
    const presentation = workspaceHelpers().platformStatePresentation(state);
    driveStatus.appendChild(createElement('span', `platform-state-badge tone-${presentation.tone}`, `${label} · ${presentation.label}`));
  });
  const fileGuide = createElement('div', 'drive-file-guide');
  fileGuide.append(
    createElement('code', '', 'sales_kakao_talk_store_YYYY-MM-DD.csv'),
    createElement('code', '', 'sales_kakao_gift_YYYY-MM-DD.csv'),
    createElement('small', '', '필수 열: 날짜, 매출액 · 오전 9시 자동 합산 · 처리 완료 파일은 processed 폴더로 이동'),
  );
  drive.append(
    driveHead,
    createElement('p', 'platform-state-action', 'Google Drive 판매자료에서 매일 오전 9시에 자동으로 합칩니다.'),
    driveStatus,
    fileGuide,
  );
  fragment.appendChild(drive);
  target.replaceChildren(fragment);
}

async function renderSettingsSection() {
  if (currentUser()?.role !== 'owner') return;
  setText('settingsStatus', '연결 상태와 최근 수집 결과를 확인하고 있습니다.');
  try {
    const [platformPayload, syncRows, overview] = await Promise.all([
      apiFetch('/admin/platforms'),
      apiFetch('/sync/status').catch(() => []),
      apiFetch('/sync/overview').catch(() => ({ platforms: [] })),
    ]);
    renderSettingsCards(
      mergePlatformStates(platformPayload?.data?.platforms, syncRows),
      overview?.platforms || []
    );
    setText('settingsStatus', '비밀값은 표시되지 않습니다. 변경할 항목만 입력해 저장하세요.');
  } catch (error) {
    if (isSessionExpired(error)) return;
    setText('settingsStatus', '연결 상태를 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
  }
}

async function startCafe24OAuth() {
  setText('settingsStatus', '카페24 로그인 연결 페이지를 준비하고 있습니다.');
  try {
    const payload = await apiFetch('/admin/oauth/cafe24/url');
    if (!payload?.data?.authorizationUrl) throw new Error('CAFE24_OAUTH_URL_MISSING');
    window.location.assign(payload.data.authorizationUrl);
  } catch (error) {
    if (isSessionExpired(error)) return;
    setText('settingsStatus', '카페24 쇼핑몰 ID·Client ID·Client Secret을 먼저 저장한 뒤 다시 연결하세요.');
  }
}

async function savePlatformSettings(form) {
  const platform = form.dataset.platformForm;
  const supplied = Object.fromEntries([...new FormData(form).entries()]
    .map(([name, value]) => [name, String(value).trim()])
    .filter(([, value]) => value));
  if (!Object.keys(supplied).length) {
    setText('settingsStatus', '저장할 연결정보를 한 항목 이상 입력하세요.');
    return;
  }
  setText('settingsStatus', `${platform} 연결정보를 암호화 저장하고 있습니다.`);
  try {
    await apiFetch(`/admin/platforms/${encodeURIComponent(platform)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supplied),
    });
    form.reset();
    setText('settingsStatus', '연결정보를 저장했습니다. 실제 데이터 확인을 위해 수동 갱신을 실행하세요.');
    await renderSettingsSection();
  } catch (error) {
    if (isSessionExpired(error)) return;
    setText('settingsStatus', '연결정보를 저장하지 못했습니다. 필수값과 권한을 확인하세요.');
  }
}

async function requestFullSync() {
  setText('settingsStatus', '오늘의 매출·광고 데이터 수집을 요청하고 있습니다.');
  try {
    const today = new Date().toISOString().slice(0, 10);
    await apiFetch('/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_from: today, date_to: today }),
    });
    setText('settingsStatus', '수집 요청을 접수했습니다. 완료 후 연결 상태 갱신을 눌러 결과를 확인하세요.');
  } catch (error) {
    if (isSessionExpired(error)) return;
    setText('settingsStatus', '수집 요청을 접수하지 못했습니다. 연결정보와 서버 상태를 확인하세요.');
  }
}

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

async function renderSalesPlatformStatus() {
  try {
    const payload = await apiFetch('/sync/overview');
    workspaceHelpers().renderPlatformStatusStrip(
      document.getElementById('salesPlatformStatus'),
      payload?.platforms || []
    );
  } catch (error) {
    if (isSessionExpired(error)) return;
    workspaceHelpers().renderPlatformStatusStrip(document.getElementById('salesPlatformStatus'), []);
  }
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
  if (Array.isArray(tasks)) teamTasks = [...tasks];
  renderTeamMemberTabs();
  renderIntegratedTeamView();
}

const TEAM_COLOR_PALETTE = [
  { color: '#EF4444', background: '#FEF2F2' },
  { color: '#3B82F6', background: '#EFF6FF' },
  { color: '#10B981', background: '#F0FDF4' },
  { color: '#F59E0B', background: '#FFFBEB' },
  { color: '#8B5CF6', background: '#F5F3FF' },
  { color: '#0891B2', background: '#ECFEFF' },
];

function taskAssignees() {
  return [...new Set(teamTasks.map((task) => task.assignee || task.who).filter(Boolean))]
    .sort((left, right) => String(left).localeCompare(String(right), 'ko-KR'));
}

function memberStyle(name) {
  const members = taskAssignees();
  const index = Math.max(0, members.indexOf(name));
  return TEAM_COLOR_PALETTE[index % TEAM_COLOR_PALETTE.length];
}

function activeTeamTasks() {
  return selectedTeamAssignee === '통합'
    ? teamTasks
    : teamTasks.filter((task) => String(task.assignee || task.who) === selectedTeamAssignee);
}

function renderTeamMemberTabs() {
  const target = document.getElementById('memberTabButtons');
  if (!target) return;
  const assignees = taskAssignees();
  if (selectedTeamAssignee !== '통합' && !assignees.includes(selectedTeamAssignee)) selectedTeamAssignee = '통합';
  const fragment = document.createDocumentFragment();
  for (const name of ['통합', ...assignees]) {
    const button = createElement('button', `member-tab-btn${name === selectedTeamAssignee ? ' active' : ''}`, name === '통합' ? '🔗 통합' : name);
    button.type = 'button';
    button.dataset.member = name;
    button.addEventListener('click', () => {
      selectedTeamAssignee = name;
      renderTeamMemberTabs();
      renderIntegratedTeamView();
    });
    fragment.appendChild(button);
  }
  target.replaceChildren(fragment);
}

function isTaskInCalendarMonth(task, month) {
  const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  return String(task?.date || '').slice(0, 7) === key;
}

function renderIntegratedTeamView() {
  const tasks = activeTeamTasks();
  renderPriorityPanel(tasks);
  renderIntegratedCalendar(tasks);
  renderRecentMinutesPanel();
  renderCollaborationAlerts(tasks);
  renderIntegratedLegend(tasks);
}

function renderPriorityPanel(tasks) {
  const helpers = collaborationHelpers();
  setText('intPriorityMonth', `${integratedCalendarMonth.getFullYear()}년 ${integratedCalendarMonth.getMonth() + 1}월 기준`);
  const priorityOrder = { 높음: 0, 보통: 1, 낮음: 2 };
  const statusOrder = { 진행: 0, 예정: 1, 완료: 2 };
  const visible = tasks
    .filter((task) => isTaskInCalendarMonth(task, integratedCalendarMonth))
    .filter((task) => integratedShowArchive || helpers.normalizeTaskStatus(task.status) !== '완료')
    .sort((left, right) => {
      const priority = (priorityOrder[left.priority] ?? 1) - (priorityOrder[right.priority] ?? 1);
      if (priority) return priority;
      const status = (statusOrder[helpers.normalizeTaskStatus(left.status)] ?? 1)
        - (statusOrder[helpers.normalizeTaskStatus(right.status)] ?? 1);
      if (status) return status;
      return String(left.date || '').localeCompare(String(right.date || ''));
    });
  const target = document.getElementById('intBlockers');
  if (!target) return;
  const fragment = document.createDocumentFragment();
  visible.slice(0, 80).forEach((task) => {
    const status = helpers.normalizeTaskStatus(task.status);
    const assignee = task.assignee || task.who || '미지정';
    const style = memberStyle(assignee);
    const row = createElement('button', `int3-pri-item${task.priority === '높음' ? ' hi' : ''}`);
    row.type = 'button';
    row.dataset.taskId = String(task.id);
    const member = createElement('span', 'int3-mb', assignee);
    member.style.background = style.background;
    member.style.color = style.color;
    row.append(
      member,
      createElement('span', 'int3-pt', task.task || '업무 내용 없음'),
      createElement('span', `int3-st int3-st-${status === '진행' ? 'progress' : status === '완료' ? 'done' : 'todo'}`, status),
      createElement('span', 'int3-dt', String(task.date || '').slice(0, 10)),
    );
    fragment.appendChild(row);
  });
  if (!visible.length) fragment.appendChild(createElement('div', 'int3-empty', integratedShowArchive ? '이번 달 업무가 없습니다.' : '이번 달 미완료 업무가 없습니다.'));
  target.replaceChildren(fragment);
}

function renderIntegratedCalendar(tasks) {
  const target = document.getElementById('intCalGrid');
  if (!target) return;
  const helpers = collaborationHelpers();
  const dates = helpers.monthCalendarDates(integratedCalendarMonth);
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const fragment = document.createDocumentFragment();
  ['일', '월', '화', '수', '목', '금', '토'].forEach((day, index) => {
    const header = createElement('div', `cal-col-header${index === 0 ? ' sun' : index === 6 ? ' sat' : ''}`);
    header.appendChild(createElement('div', 'cal-day-name', day));
    fragment.appendChild(header);
  });
  dates.forEach((dateKey) => {
    const date = new Date(`${dateKey}T00:00:00`);
    const inMonth = date.getMonth() === integratedCalendarMonth.getMonth();
    const dayTasks = tasks.filter((task) => String(task.date || '').slice(0, 10) === dateKey);
    const cell = createElement('div', `cal-month-cell int3-cal-cell${dateKey === todayKey ? ' today' : ''}${inMonth ? '' : ' other-month'}${date.getDay() === 0 ? ' sun' : date.getDay() === 6 ? ' sat' : ''}`);
    cell.dataset.date = dateKey;
    cell.appendChild(createElement('div', 'cal-month-day-num', date.getDate()));
    dayTasks.slice(0, 4).forEach((task) => {
      const assignee = task.assignee || task.who || '미지정';
      const style = memberStyle(assignee);
      const item = createElement('button', `cal-month-task${helpers.normalizeTaskStatus(task.status) === '완료' ? ' done' : ''}`, `${assignee.slice(0, 2)} ${task.task || ''}`);
      item.type = 'button';
      item.dataset.taskId = String(task.id);
      item.title = `${assignee}: ${task.task || ''} (${helpers.normalizeTaskStatus(task.status)})`;
      item.style.background = style.background;
      item.style.borderLeftColor = style.color;
      item.style.color = style.color;
      cell.appendChild(item);
    });
    if (dayTasks.length > 4) cell.appendChild(createElement('div', 'cal-month-more', `+${dayTasks.length - 4}개 더`));
    if (isWorkspaceManager()) {
      const add = createElement('button', 'cal-month-add', '+');
      add.type = 'button';
      add.dataset.addTaskDate = dateKey;
      add.setAttribute('aria-label', `${dateKey} 업무 추가`);
      cell.appendChild(add);
    }
    fragment.appendChild(cell);
  });
  target.replaceChildren(fragment);
  target.style.gridTemplateColumns = 'repeat(7, minmax(0, 1fr))';
  setText('intCalLabel', `${integratedCalendarMonth.getFullYear()}년 ${integratedCalendarMonth.getMonth() + 1}월`);
}

function renderRecentMinutesPanel() {
  const target = document.getElementById('intMinutes');
  if (!target) return;
  const fragment = document.createDocumentFragment();
  collaborationHelpers().filterMinutes(meetingMinutes).slice(0, 5).forEach((minute) => {
    const card = createElement('button', 'int3-min-card');
    card.type = 'button';
    card.dataset.openMinutesId = String(minute.id);
    const head = createElement('span', 'int3-min-head');
    const minuteStatus = collaborationHelpers().normalizeTaskStatus(minute.status || '진행');
    head.append(
      createElement('span', 'int3-min-date', String(minute.date || '').slice(0, 10)),
      createElement('span', `status-chip status-${minuteStatus === '완료' ? 'done' : minuteStatus === '예정' ? 'todo' : 'progress'}`, minuteStatus),
    );
    card.append(head, createElement('span', 'int3-min-title', minute.title || '제목 없는 회의록'));
    const directiveCount = collaborationHelpers().splitTextLines(minute.directives).length;
    if (directiveCount) card.appendChild(createElement('span', 'int3-min-counter', `지시 ${directiveCount}건`));
    fragment.appendChild(card);
  });
  if (!meetingMinutes.length) fragment.appendChild(createElement('div', 'int3-empty', '회의록이 없습니다.'));
  target.replaceChildren(fragment);
}

function renderCollaborationAlerts(tasks) {
  const target = document.getElementById('intAlerts');
  if (!target) return;
  const today = new Date().toISOString().slice(0, 10);
  const helpers = collaborationHelpers();
  const delayed = tasks
    .filter((task) => task.date && String(task.date).slice(0, 10) < today && helpers.normalizeTaskStatus(task.status) !== '완료')
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .slice(0, 8);
  const fragment = document.createDocumentFragment();
  delayed.forEach((task) => {
    const assignee = task.assignee || task.who || '미지정';
    const style = memberStyle(assignee);
    const row = createElement('button', 'int3-pri-item int3-delay');
    row.type = 'button';
    row.dataset.taskId = String(task.id);
    const member = createElement('span', 'int3-mb', assignee);
    member.style.background = style.background;
    member.style.color = style.color;
    row.append(member, createElement('span', 'int3-pt', task.task || '업무 내용 없음'), createElement('span', 'int3-dt', `${String(task.date).slice(0, 10)} 지연`));
    fragment.appendChild(row);
  });
  if (!delayed.length) fragment.appendChild(createElement('div', 'int3-empty', '지연 항목이 없습니다.'));
  target.replaceChildren(fragment);
}

function renderIntegratedLegend(tasks) {
  const target = document.getElementById('intCalLegend');
  if (!target) return;
  const names = [...new Set(tasks.map((task) => task.assignee || task.who).filter(Boolean))];
  const fragment = document.createDocumentFragment();
  names.forEach((name) => {
    const style = memberStyle(name);
    const item = createElement('span', 'int3-legend-item');
    const dot = createElement('span', 'int3-legend-dot');
    dot.style.background = style.color;
    item.append(dot, document.createTextNode(name));
    fragment.appendChild(item);
  });
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
  setText('dataStatusBadge', '업무를 불러오는 중입니다');
  const [tasks, minutes] = await Promise.all([
    fetchTeamTasks(),
    isWorkspaceManager() ? fetchMinutes() : Promise.resolve([]),
  ]);
  teamTasks = tasks;
  meetingMinutes = minutes;
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

async function createMinutes(payload) {
  if (!isWorkspaceManager()) throw new Error('MINUTES_MUTATION_FORBIDDEN');
  const data = await apiFetch('/team/minutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data.minutes;
}

async function updateMinutes(id, patch) {
  if (!isWorkspaceManager()) throw new Error('MINUTES_MUTATION_FORBIDDEN');
  const data = await apiFetch(`/team/minutes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return data.minutes;
}

async function deleteMinutes(id) {
  if (!isWorkspaceManager()) throw new Error('MINUTES_MUTATION_FORBIDDEN');
  await apiFetch(`/team/minutes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

function renderMinutesList() {
  const target = document.getElementById('minutesList');
  if (!target) return;
  const query = document.getElementById('minutesSearch')?.value || '';
  const filtered = collaborationHelpers().filterMinutes(meetingMinutes, query);
  if (!filtered.some((minute) => String(minute.id) === String(selectedMinutesId))) {
    selectedMinutesId = filtered[0]?.id == null ? null : String(filtered[0].id);
  }
  const fragment = document.createDocumentFragment();
  for (const minute of filtered) {
    const button = createElement('button', `minutes-list-item${String(minute.id) === String(selectedMinutesId) ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.minutesId = String(minute.id);
    button.append(
      createElement('span', 'minutes-item-date', collaborationHelpers().formatBoardDate(minute.date)),
      createElement('strong', 'minutes-item-title', minute.title || '제목 없는 회의록'),
      createElement('span', 'minutes-item-preview', minute.summary || minute.directives || minute.content || '상세 내용을 확인하세요.'),
    );
    fragment.appendChild(button);
  }
  if (!filtered.length) fragment.appendChild(createElement('div', 'empty-state', query ? '검색 결과가 없습니다.' : '회의록이 없습니다.'));
  target.replaceChildren(fragment);
  const selected = meetingMinutes.find((minute) => String(minute.id) === String(selectedMinutesId));
  renderMinutesDocument(selected || null);
}

function renderMinutesDocument(minute) {
  const viewer = document.getElementById('minutesViewer');
  if (!viewer) return;
  if (!minute) {
    const placeholder = createElement('div', 'minutes-placeholder');
    placeholder.append(createElement('div', 'minutes-placeholder-icon', '📋'), createElement('div', '', '표시할 회의록을 선택하세요.'));
    viewer.replaceChildren(placeholder);
    return;
  }

  const helpers = collaborationHelpers();
  const header = createElement('header', 'minutes-doc-header');
  const heading = createElement('div', 'minutes-doc-heading');
  heading.append(
    createElement('div', 'minutes-doc-date', helpers.formatBoardDate(minute.date)),
    createElement('h2', 'minutes-doc-title', minute.title || '제목 없는 회의록'),
  );
  const actions = createElement('div', 'minutes-doc-actions');
  const edit = createElement('button', 'btn-secondary', '수정');
  edit.type = 'button';
  edit.dataset.minutesAction = 'edit';
  edit.dataset.minutesId = String(minute.id);
  const remove = createElement('button', 'btn-danger', '삭제');
  remove.type = 'button';
  remove.dataset.minutesAction = 'delete';
  remove.dataset.minutesId = String(minute.id);
  actions.append(edit, remove);
  header.append(heading, actions);

  const meta = createElement('div', 'minutes-doc-meta');
  meta.append(
    createElement('span', 'source-chip', helpers.collaborationSourceLabel(minute)),
    createElement('span', '', minute.attendees ? `참석자 ${minute.attendees}` : '참석자 기록 없음'),
  );

  const body = createElement('div', 'minutes-doc-body');
  if (minute.summary) {
    const block = createElement('section', 'minutes-summary-block');
    block.append(createElement('h3', 'minutes-summary-title', '핵심 요약'), createElement('p', 'minutes-summary-text', minute.summary));
    body.appendChild(block);
  }

  const directives = helpers.splitTextLines(minute.directives);
  const directiveBlock = createElement('section', 'minutes-directive-block');
  directiveBlock.appendChild(createElement('h3', 'minutes-directive-title', `지시사항 ${directives.length ? directives.length : ''}`.trim()));
  if (directives.length) {
    const list = createElement('ul', 'minutes-directive-list');
    directives.forEach((line) => list.appendChild(createElement('li', '', line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))));
    directiveBlock.appendChild(list);
  } else {
    directiveBlock.appendChild(createElement('p', 'minutes-empty-copy', '등록된 지시사항이 없습니다.'));
  }
  body.appendChild(directiveBlock);

  const contentBlock = createElement('section', 'minutes-content-block');
  contentBlock.appendChild(createElement('h3', '', '주요 논의 내용'));
  const contentLines = helpers.splitTextLines(minute.content);
  if (contentLines.length) contentLines.forEach((line) => contentBlock.appendChild(createElement('p', '', line)));
  else contentBlock.appendChild(createElement('p', 'minutes-empty-copy', '등록된 논의 내용이 없습니다.'));
  body.appendChild(contentBlock);
  viewer.replaceChildren(header, meta, body);
}

function minutesField(id) {
  return document.getElementById(id);
}

function closeMinutesModal() {
  const modal = minutesField('minutesModal');
  if (modal) modal.style.display = 'none';
  editingMinutesId = null;
  setText('minutesMutationStatus', '');
}

function openMinutesModal(minute = null) {
  if (!isWorkspaceManager()) return;
  editingMinutesId = minute?.id == null ? null : String(minute.id);
  const values = {
    minutesDate: minute?.date ? String(minute.date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    minutesTitle: minute?.title || '',
    minutesAttendees: minute?.attendees || '',
    minutesSummary: minute?.summary || '',
    minutesDirectives: minute?.directives || '',
    minutesContent: minute?.content || '',
  };
  Object.entries(values).forEach(([id, value]) => { const field = minutesField(id); if (field) field.value = value; });
  setText('minutesModalTitle', minute ? '회의록 수정' : '새 회의록');
  setText('minutesMutationStatus', '');
  const remove = minutesField('deleteMinutes');
  if (remove) remove.hidden = !minute;
  const modal = minutesField('minutesModal');
  if (modal) modal.style.display = 'flex';
  minutesField('minutesTitle')?.focus?.();
}

function minutesFormPayload() {
  return {
    date: minutesField('minutesDate')?.value || '',
    title: minutesField('minutesTitle')?.value?.trim() || '',
    attendees: minutesField('minutesAttendees')?.value?.trim() || '',
    summary: minutesField('minutesSummary')?.value?.trim() || '',
    directives: minutesField('minutesDirectives')?.value?.trim() || '',
    content: minutesField('minutesContent')?.value?.trim() || '',
  };
}

async function saveMinutesFromModal() {
  const payload = minutesFormPayload();
  if (!payload.date || !payload.title) {
    setText('minutesMutationStatus', '회의 날짜와 제목을 입력해 주세요.');
    return;
  }
  const button = minutesField('saveMinutes');
  if (button) button.disabled = true;
  try {
    const saved = editingMinutesId
      ? await updateMinutes(editingMinutesId, payload)
      : await createMinutes(payload);
    if (editingMinutesId) {
      meetingMinutes = meetingMinutes.map((minute) => String(minute.id) === editingMinutesId ? saved : minute);
    } else {
      meetingMinutes = [saved, ...meetingMinutes];
    }
    selectedMinutesId = String(saved.id);
    closeMinutesModal();
    renderMinutesList();
  } catch {
    setText('minutesMutationStatus', '회의록을 저장하지 못했습니다. 입력값을 확인하고 다시 시도해 주세요.');
  } finally {
    if (button) button.disabled = false;
  }
}

async function deleteMinutesFromModal(id = editingMinutesId) {
  if (!id || !isWorkspaceManager()) return;
  if (!window.confirm('이 회의록을 삭제할까요?')) return;
  try {
    await deleteMinutes(id);
    meetingMinutes = meetingMinutes.filter((minute) => String(minute.id) !== String(id));
    selectedMinutesId = null;
    closeMinutesModal();
    renderMinutesList();
  } catch {
    setText('minutesMutationStatus', '회의록을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function renderMinutesSection() {
  const target = document.getElementById('minutesList');
  if (!target) return;
  target.replaceChildren(createElement('div', 'empty-state', '회의록을 불러오는 중입니다.'));
  meetingMinutes = await fetchMinutes();
  renderMinutesList();
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
      if (button.dataset.section === 'kpi') void renderKpiSection();
      if (button.dataset.section === 'manual') void renderManualSection();
      if (button.dataset.section === 'settings') void renderSettingsSection();
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
  document.getElementById('refreshKpiBtn')?.addEventListener('click', () => {
    void renderKpiSection();
  });
  document.getElementById('refreshManualBtn')?.addEventListener('click', () => {
    selectedManualFile = null;
    void renderManualSection();
  });
  document.getElementById('manualSearch')?.addEventListener('input', (event) => {
    renderManualNavigation(event.target.value);
  });
  document.getElementById('manualNav')?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-manual-file]');
    if (button) void openManualDocument(button.dataset.manualFile);
  });
  document.getElementById('refreshSettingsBtn')?.addEventListener('click', () => {
    void renderSettingsSection();
  });
  document.getElementById('runAllSyncBtn')?.addEventListener('click', () => {
    void requestFullSync();
  });
  document.getElementById('platformSettingsGrid')?.addEventListener('submit', (event) => {
    const form = event.target.closest?.('[data-platform-form]');
    if (!form) return;
    event.preventDefault();
    void savePlatformSettings(form);
  });
  document.getElementById('platformSettingsGrid')?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-cafe24-oauth]')) void startCafe24OAuth();
  });
  document.getElementById('intShowArchive')?.addEventListener('change', (event) => {
    integratedShowArchive = event.target.checked;
    renderIntegratedTeamView();
  });
  document.getElementById('intCalPrev')?.addEventListener('click', () => {
    integratedCalendarMonth = new Date(integratedCalendarMonth.getFullYear(), integratedCalendarMonth.getMonth() - 1, 1);
    renderIntegratedTeamView();
  });
  document.getElementById('intCalNext')?.addEventListener('click', () => {
    integratedCalendarMonth = new Date(integratedCalendarMonth.getFullYear(), integratedCalendarMonth.getMonth() + 1, 1);
    renderIntegratedTeamView();
  });
  document.getElementById('intCalToday')?.addEventListener('click', () => {
    const today = new Date();
    integratedCalendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderIntegratedTeamView();
  });
  document.getElementById('addTaskBtn')?.addEventListener('click', () => {
    openTaskModal();
    if (selectedTeamAssignee !== '통합') {
      const field = taskField('taskAssignee');
      if (field) field.value = selectedTeamAssignee;
    }
  });
  document.getElementById('intBlockers')?.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-task-id]');
    if (!row) return;
    const task = teamTasks.find((candidate) => String(candidate.id) === String(row.dataset.taskId));
    if (task) openTaskModal(task);
  });
  document.getElementById('intAlerts')?.addEventListener('click', (event) => {
    const row = event.target.closest?.('[data-task-id]');
    if (!row) return;
    const task = teamTasks.find((candidate) => String(candidate.id) === String(row.dataset.taskId));
    if (task) openTaskModal(task);
  });
  document.getElementById('intCalGrid')?.addEventListener('click', (event) => {
    const taskItem = event.target.closest?.('[data-task-id]');
    if (taskItem) {
      const task = teamTasks.find((candidate) => String(candidate.id) === String(taskItem.dataset.taskId));
      if (task) openTaskModal(task);
      return;
    }
    const add = event.target.closest?.('[data-add-task-date]');
    if (!add || !isWorkspaceManager()) return;
    openTaskModal();
    const dateField = taskField('taskDate');
    const assigneeField = taskField('taskAssignee');
    if (dateField) dateField.value = add.dataset.addTaskDate;
    if (assigneeField && selectedTeamAssignee !== '통합') assigneeField.value = selectedTeamAssignee;
  });
  document.getElementById('intMinutes')?.addEventListener('click', (event) => {
    const card = event.target.closest?.('[data-open-minutes-id]');
    if (!card) return;
    selectedMinutesId = card.dataset.openMinutesId;
    document.querySelector('[data-section="minutes"]')?.click();
  });
  document.getElementById('closeTaskModal')?.addEventListener('click', closeTaskModal);
  document.getElementById('cancelTask')?.addEventListener('click', closeTaskModal);
  document.getElementById('saveTask')?.addEventListener('click', () => { void saveTaskFromModal(); });
  document.getElementById('deleteTask')?.addEventListener('click', () => { void deleteTaskFromModal(); });
  document.getElementById('taskModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'taskModal') closeTaskModal();
  });
  document.getElementById('addMinutesBtn')?.addEventListener('click', () => openMinutesModal());
  document.getElementById('minutesSearch')?.addEventListener('input', renderMinutesList);
  document.getElementById('minutesList')?.addEventListener('click', (event) => {
    const item = event.target.closest?.('[data-minutes-id]');
    if (!item) return;
    selectedMinutesId = item.dataset.minutesId;
    renderMinutesList();
  });
  document.getElementById('minutesViewer')?.addEventListener('click', (event) => {
    const action = event.target.closest?.('[data-minutes-action]');
    if (!action) return;
    const minute = meetingMinutes.find((item) => String(item.id) === String(action.dataset.minutesId));
    if (!minute) return;
    if (action.dataset.minutesAction === 'edit') openMinutesModal(minute);
    if (action.dataset.minutesAction === 'delete') void deleteMinutesFromModal(minute.id);
  });
  document.getElementById('closeMinutesModal')?.addEventListener('click', closeMinutesModal);
  document.getElementById('cancelMinutes')?.addEventListener('click', closeMinutesModal);
  document.getElementById('saveMinutes')?.addEventListener('click', () => { void saveMinutesFromModal(); });
  document.getElementById('deleteMinutes')?.addEventListener('click', () => { void deleteMinutesFromModal(); });
  document.getElementById('minutesModal')?.addEventListener('click', (event) => {
    if (event.target.id === 'minutesModal') closeMinutesModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('minutesModal')?.style.display !== 'none') closeMinutesModal();
    if (document.getElementById('taskModal')?.style.display !== 'none') closeTaskModal();
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
    if (!signal?.aborted) await renderSalesPlatformStatus();
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
