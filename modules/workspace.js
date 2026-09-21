export function filterManualDocuments(documents = [], query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase('ko-KR');
  if (!needle) return [...documents];
  return documents.filter((document) => [
    document.title, document.summary, document.category, document.file,
  ].some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(needle)));
}

export function markdownBlocks(markdown = '') {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let code = [];

  const flushCode = () => {
    if (!code.length) return;
    blocks.push({ type: 'code', text: code.join('\n') });
    code = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(rawLine);
      continue;
    }
    if (!line.trim()) continue;
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'divider' });
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'quote', text: quote[1].trim() });
      continue;
    }
    const checklist = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checklist) {
      blocks.push({ type: 'list-item', ordered: false, checked: checklist[1].toLowerCase() === 'x', text: checklist[2].trim() });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: 'list-item', ordered: false, checked: null, text: bullet[1].trim() });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push({ type: 'list-item', ordered: true, checked: null, text: ordered[1].trim() });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      blocks.push({ type: 'table-row', text: line.trim() });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line.trim() });
  }
  if (inCode) flushCode();
  return blocks;
}

export function platformStatePresentation(state = {}) {
  if (state.source === 'manual') return { tone: 'neutral', label: '수동 관리', action: '자동 수집 대상에서 제외되어 있습니다. 판매자·광고 관리자에서 확인한 날짜별 금액을 직접 입력하세요.' };
  if (state.source === 'office_pc' && state.syncState === 'success') {
    const last = Date.parse(state.completedAt || state.lastSyncAt || '');
    if (!Number.isFinite(last) || Date.now() - last > 36 * 3600000) {
      return { tone: 'warning', label: 'PC 갱신 지연', action: '36시간 이상 새 수집이 없습니다. 사무실 PC의 전원·로그인·인터넷과 네이버 허용 IP를 확인하세요.' };
    }
  }
  if (state.connectionState !== 'connected') {
    return { tone: 'warning', label: '연결정보 필요', action: '설정에서 연결정보를 입력하세요.' };
  }
  if (state.syncState === 'running') {
    return { tone: 'neutral', label: '수집 중', action: '수집을 진행하고 있습니다. 잠시 후 연결 상태를 갱신하세요.' };
  }
  if (state.syncState === 'error' || state.syncState === 'failed') {
    if (String(state.errorDetail || '').includes('GW.IP_NOT_ALLOWED')) {
      return { tone: 'danger', label: '서버 IP 등록 필요', action: '네이버 커머스API센터에 수집 서버의 고정 발신 IP를 등록해야 합니다. 현재 서버 IP가 허용되지 않았습니다.' };
    }
    const http = /^SYNC_FAILED_HTTP_(\d{3})$/.exec(String(state.errorCode || ''));
    const status = http ? Number(http[1]) : null;
    const action = status === 401 || status === 403
      ? `HTTP ${status} · 토큰이 만료됐거나 권한(스코프)이 없습니다. 연결정보를 다시 저장하고 로그인 연결을 실행하세요.`
      : status === 422 || status === 400
        ? `HTTP ${status} · 요청 형식을 공급자가 거부했습니다. 수집 코드 점검이 필요합니다.`
        : status
          ? `HTTP ${status} · 공급자 응답 오류입니다. 잠시 후 수동 갱신을 다시 실행하세요.`
          : '연결 권한과 토큰을 확인하세요.';
    const detail = String(state.errorDetail || '').trim();
    return {
      tone: 'danger',
      label: status ? `수집 실패 · HTTP ${status}` : '수집 실패',
      action: detail ? `${action} 공급자 응답: ${detail}` : action,
    };
  }
  if (state.syncState === 'success') {
    const count = Number(state.recordsSynced || 0);
    return count === 0
      ? { tone: 'success', label: '정상 · 0건', action: '선택 기간에 발생한 데이터가 없습니다.' }
      : { tone: 'success', label: '수집 완료', action: `실제 API 데이터 ${count.toLocaleString('ko-KR')}건을 반영했습니다.` };
  }
  return { tone: 'neutral', label: '아직 미수집', action: '수동 갱신하거나 다음 자동 갱신을 기다리세요.' };
}

export function renderPlatformStatusStrip(target, states = []) {
  if (!target) return target;
  const fragment = document.createDocumentFragment();
  for (const state of states) {
    const presentation = platformStatePresentation(state);
    const pill = document.createElement('span');
    pill.className = `channel-state-pill tone-${presentation.tone}`;
    pill.title = presentation.action;
    const label = document.createElement('strong');
    label.textContent = state.label || state.id || '채널';
    const status = document.createElement('span');
    status.textContent = presentation.label;
    pill.append(label, status);
    fragment.appendChild(pill);
  }
  if (!states.length) {
    const empty = document.createElement('div');
    empty.className = 'channel-state-empty';
    empty.textContent = '연결된 판매·광고 채널 상태가 없습니다.';
    fragment.appendChild(empty);
  }
  target.replaceChildren(fragment);
  return target;
}

export const SALES_PLATFORMS = Object.freeze([
  { id: 'cafe24', label: '카페24' },
  { id: 'naver_store', label: '스마트스토어' },
  { id: 'coupang', label: '쿠팡 한반도' },
  { id: 'kakao_talk_store', label: '카카오 톡스토어' },
  { id: 'kakao_gift', label: '카카오 선물하기' },
].map(Object.freeze));

export const AD_PLATFORMS = Object.freeze([
  { id: 'meta', label: '메타 광고' },
  { id: 'naver_ads', label: '네이버 검색광고' },
  { id: 'kakao', label: '카카오모먼트' },
].map(Object.freeze));

const SALES_DAY_MS = 86400000;

function salesDateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

export function validateSalesDateRange(from, to, today) {
  const first = salesDateTimestamp(from);
  const last = salesDateTimestamp(to);
  const current = salesDateTimestamp(today);
  if (first === null || last === null) return '시작일과 종료일을 올바른 날짜로 입력하세요.';
  if (current === null) return '오늘 날짜를 확인할 수 없습니다. 화면을 새로고침하세요.';
  if (first > last) return '시작일은 종료일보다 늦을 수 없습니다.';
  if (last > current) return '미래 날짜는 조회할 수 없습니다.';
  if ((last - first) / SALES_DAY_MS + 1 > 366) return '한 번에 최대 366일까지 조회할 수 있습니다.';
  return '';
}

export function salesDatePreset(preset, today) {
  const current = salesDateTimestamp(today);
  if (current === null) throw new RangeError('오늘 날짜가 올바르지 않습니다.');
  const dateBefore = (days) => new Date(current - days * SALES_DAY_MS).toISOString().slice(0, 10);
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: dateBefore(1), to: dateBefore(1) };
    case '7days': return { from: dateBefore(6), to: today };
    case '30days': return { from: dateBefore(29), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    default: throw new RangeError('지원하지 않는 조회 기간입니다.');
  }
}

export function buildPlatformMatrix(rawRows = [], platforms = [], metric, { from, to } = {}) {
  const rangeError = validateSalesDateRange(from, to, to);
  if (rangeError) throw new RangeError(rangeError);
  const platformIds = platforms.map((platform) => platform.id);
  const allowedPlatforms = new Set(platformIds);
  const emptyValues = () => Object.fromEntries(platformIds.map((id) => [id, null]));
  const rows = [];
  const byDate = new Map();
  const totals = emptyValues();
  let grandTotal = null;
  const first = salesDateTimestamp(from);
  for (let timestamp = salesDateTimestamp(to); timestamp >= first; timestamp -= SALES_DAY_MS) {
    const row = { date: new Date(timestamp).toISOString().slice(0, 10), values: emptyValues(), total: null };
    rows.push(row);
    byDate.set(row.date, row);
  }
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') continue;
    const platform = raw.platform ?? raw.platform_raw;
    const row = byDate.get(raw.date);
    const value = raw[metric];
    if (!row || !allowedPlatforms.has(platform) || value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && !value.trim()) continue;
    const amount = Number(value);
    if (!Number.isFinite(amount)) continue;
    row.values[platform] = (row.values[platform] ?? 0) + amount;
    row.total = (row.total ?? 0) + amount;
    totals[platform] = (totals[platform] ?? 0) + amount;
    grandTotal = (grandTotal ?? 0) + amount;
  }
  return { rows, totals, grandTotal };
}
