/**
 * OneBoard — 원보드 메인 앱
 * Google Sheets CSV 실시간 연동 + Chart.js 대시보드
 *
 * 데이터 구조 (통합 탭):
 *   날짜 | 총 매출 | 총 유입 | 전환 매출 | 총 광고비 | 총 ROAS | 전환 ROAS | 광고비율
 */

function isSessionExpired(error) {
  return error?.code === 'SESSION_EXPIRED';
}

async function authenticatedResponse(path, options = {}) {
  const adapter = window.ONEBOARD_API?.fetch;
  if (typeof adapter !== 'function') throw new Error('Authenticated API adapter is unavailable');
  const signal = options.signal || legacyLifecycleController?.signal;
  return adapter(path, signal ? { ...options, signal } : options);
}

// Legacy callers expect parsed JSON, while auth/retry remains exclusively in modules/api.js.
async function apiFetch(path, options = {}) {
  const response = await authenticatedResponse(path, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `API ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

let legacyLifecycleController = null;
function lifecycleFetch(input, options = {}) {
  const signal = options.signal || legacyLifecycleController?.signal;
  return fetch(input, signal ? { ...options, signal } : options);
}

const SHEET_ID = '11byYTuUleS-kq3idS4e0Mgt368FssfnrHchyalHPuRI';

// 팀 업무 매뉴얼 시트 (2026-05-21 OneBoard 백엔드 폐기 → Google Drive 100% 전환)
// 컬럼: date, who, task, status, priority, memo
const SHEET_TEAM_TASKS_ID = '1uktRhUEvxQCodwGxSSR9LXlVlfUFpESyfktUUTTZ7EQ';
const SHEET_TEAM_TASKS_GID = 0;
const SHEET_TEAM_TASKS_URL = `https://docs.google.com/spreadsheets/d/${SHEET_TEAM_TASKS_ID}/edit#gid=${SHEET_TEAM_TASKS_GID}`;

// 회의록 시트 (Legacy 별도 spreadsheet)
// 2026-05-29 #OB-MIN-EDIT-002 — 단일 출처 통합으로 더 이상 fetch 안 함(113건 minutes 시트로 마이그레이션).
//   원본 데이터 보존용으로 ID만 주석 보관: 13yy1MtUhXNg4MEG6qL9lJogIDNdouXqQzv8mkUp2Kkk (gid=1125757148)

// CSV 멀티라인 파서 (회의록 시트는 한 셀에 markdown 보고서 박힘)
function parseCSVMultiline(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch === '\r') {}
      else cell += ch;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function syncToSheet(action, body) {
  try {
    return await apiFetch('/legacy-sheets/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload: body }),
    });
  } catch (e) {
    if (isSessionExpired(e)) throw e;
    console.warn('[OneBoard] Sheets proxy sync 실패');
    return { ok: false, reason: 'proxy_unavailable' };
  }
}

function teamTaskKey(t) {
  return `${t.date}|${t.who}|${t.task}`;
}

// 시트 gid — 채널별 분리 시트
const SHEET_GIDS = {
  main:          0,           // 메인 (통합/자사몰/META/네이버 스마트스토어 등)
  coupang_split: 2052767088,  // 쿠팡 한반도(듀오) + 네모칩(아블러)
  kakao:         1562400814,  // 카카오모먼트 광고 + 메시지(알림톡) 매출
  naver_ad:      364317310,   // 네이버 검색광고
};

/**
 * 채널별 CSV 컬럼 레이아웃 (0-indexed):
 *
 * [gid=0 메인 시트]
 *  통합     col 1-8  : 날짜, 총매출, 총유입, 전환매출, 총광고비, 총ROAS, 전환ROAS, 광고비율
 *  자사몰   col 10-17: 날짜, 자사매출, 유입, 광고매출, 광고비, 자사ROAS, 광고ROAS, 광고비율
 *  META     col 19-23: 날짜, 광고매출, 광고비, ROAS, 광고비율  (유입 없음)
 *  네이버   col 39-45: 날짜, 전체매출, 유입, 광고매출, 광고비, ROAS, 광고비율
 *
 * [gid=2052767088 쿠팡 분리]
 *  쿠팡_한반도(듀오)   col 1-12 : 날짜, 전체매출, 유입, 노출, 클릭, CPC, CTR, 전환(14일), 전환매출, 전환율, 광고비, ROAS
 *  쿠팡_네모칩(아블러) col 14-25: (동일 12컬럼)
 *
 * [gid=1562400814 카카오]
 *  카카오모먼트        col 1-12: 날짜, 전체매출, 유입, 노출, 클릭, CPC, CTR, 전환수, 전환매출, 전환율, 광고비, ROAS
 *  카카오_매출(메시지) col 14-22: 날짜, 발송수, 열람, 클릭, CTR, 전환, 전환매출, 광고비, ROAS
 *
 * [gid=364317310 네이버 검색광고]
 *  네이버_검색광고 col 1-12: 날짜, 전체매출, 유입, 노출, 클릭, CPC, CTR, 전환수, 전환매출, 전환율, 광고비, ROAS
 */
// 2026-05-26 #OB-SALES-FIX-001 — Agent 분석 결과 반영 매핑 재확정
// 변경 3건: ①네이버 dateCol 39→47 (39는 쿠팡_네모칩 거울) ②카카오모먼트·카카오_매출 gid 1562400814→0 (분리 시트엔 일자 없음)
const CHANNEL_COL_MAP = {
  // 메인 시트 (gid=0)
  '통합':           { gid: 0,           dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 4,  adCol: 5,  roasCol: 6,  adRatioCol: 8,    hasTraffic: true  },
  // 2026-05-26 #OB-OWN-FIX-001 — 자사몰: salesCol=9 (순매출=총매출-환불). col 7=총매출(참고), col 8=환불합계(광고비 아님), col 9=순매출=진짜 매출. 광고비는 META 시트 col 9 cross-ref (attachMetaAdSpendToOwnshop)
  '자사몰':         { gid: 1273644982,  dateCol: 1,  salesCol: 9,  trafficCol: 2,    convCol: 9,  adCol: null, roasCol: null, adRatioCol: null, hasTraffic: true  },
  // 2026-05-26 #OB-SALES-FIX-003 — META 전용 시트(gid=140033998) 발견. 통합 시트 가짜 매핑 폐기.
  // 헤더(B~K): 날짜·노출수·클릭수·결과·CPC·클릭율·전환매출·전환율·광고비·ROAS
  'META':           { gid: 140033998,   dateCol: 1,  salesCol: 7,  trafficCol: 3,    convCol: 7,  adCol: 9,  roasCol: 10, adRatioCol: null, hasTraffic: true  },
  // 2026-05-26 #OB-SALES-FIX-004 — 네이버 시트(gid=364317310)는 GFA광고+검색광고 두 영역 가로 배치
  '네이버':         { gid: 364317310,   dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 9,  adCol: null, roasCol: null, adRatioCol: null, hasTraffic: true  },
  '네이버_GFA':     { gid: 364317310,   dateCol: 1,  salesCol: 9,  trafficCol: 3,    convCol: 9,  adCol: 11, roasCol: 12, adRatioCol: null, hasTraffic: true  },
  '네이버_검색광고':{ gid: 364317310,   dateCol: 14, salesCol: 20, trafficCol: 15,   convCol: 20, adCol: 22, roasCol: 23, adRatioCol: null, hasTraffic: true  },
  // 쿠팡 분리 시트 (gid=2052767088)
  '쿠팡_한반도':    { gid: 2052767088,  dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 9,  adCol: 11, roasCol: 12, adRatioCol: null, hasTraffic: true  },
  '쿠팡_네모칩':    { gid: 2052767088,  dateCol: 14, salesCol: 15, trafficCol: 16,   convCol: 22, adCol: 24, roasCol: 25, adRatioCol: null, hasTraffic: true  },
  // 카카오 — 진짜 카카오모먼트 시트(gid=1562400814): 좌측 모먼트 매출 + 우측 메세지 발송
  '카카오모먼트':   { gid: 1562400814,  dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 2,  adCol: null, roasCol: null, adRatioCol: null, hasTraffic: true  },
  '카카오_매출':    { gid: 1562400814,  dateCol: 14, salesCol: 20, trafficCol: 15,   convCol: 20, adCol: 21, roasCol: 22, adRatioCol: null, hasTraffic: true  },
  // 2026-05-26 #OB-SALES-FIX-004 — 유튜브쇼핑 시트(gid=1763675428). 어쿠스틱(col 1-7) + 미스터위스키(col 9-15) 합산은 추후. 어쿠스틱만 매핑(미스터위스키 5월 0)
  '유튜브쇼핑':     { gid: 1763675428,  dateCol: 1,  salesCol: 4,  trafficCol: 2,    convCol: 3,  adCol: 5,  roasCol: 6,  adRatioCol: null, hasTraffic: true  },
  // 2026-05-26 #OB-EXTRA-SALES-001/002 — 기타매출 시트(gid=1649923806). 와디즈/오늘의집/지마켓/cj/sk스토아 등 비정기 채널. col 2=매출, col 3=광고비+수수료, col 4=플랫폼, col 5=ROAS. 5/13 와디즈 매출 ₩23.75M / 광고비 ₩12.81M / ROAS 185%
  '기타매출':         { gid: 1649923806,  dateCol: 1,  salesCol: 2,  trafficCol: null,  convCol: 2,  adCol: 3,    roasCol: 5,  adRatioCol: null, hasTraffic: false },
  // 2026-05-26 #OB-EXTRA-SALES-003 — 광고 그룹에서도 매출=col 2, 광고비=col 3 동일. ROAS = 매출/광고비 (와디즈 5/13: ₩23.75M / ₩12.81M = 185%)
  '기타_광고수수료': { gid: 1649923806,  dateCol: 1,  salesCol: 2,  trafficCol: null,  convCol: 2,  adCol: 3,    roasCol: 5,  adRatioCol: null, hasTraffic: false },
};

// 채널별 색상
const CHANNEL_COLORS = {
  '자사몰':         '#3B82F6',
  'META':           '#EC4899',
  '쿠팡_한반도':    '#F59E0B',
  '쿠팡_네모칩':    '#FB923C',
  '네이버':         '#10B981',
  '네이버_검색광고':'#34D399',
  '카카오_매출':    '#FBBF24',
  '카카오모먼트':   '#8B5CF6',
};

// 채널별 비중 목업 (API 연동 전)
const CHANNEL_MOCK_SHARE = {
  labels: ['자사몰', 'META', '쿠팡(한반도)', '쿠팡(네모칩)', '네이버', '카카오'],
  data:   [38, 22, 13, 9, 12, 6],
  colors: ['#3B82F6', '#EC4899', '#F59E0B', '#FB923C', '#10B981', '#FBBF24'],
};

// 상태
let rawCSV = null;          // 메인 시트 원본 CSV (구버전 호환 — gid=0)
let rawCSVByGid = {};       // gid별 원본 CSV 캐시 (다중 시트 탭 지원)
let channelDataCache = {};  // 채널별 파싱 결과 캐시
let allData = [];
let filteredData = [];
let currentRange = 'month'; // 2026-06-02 #OB-RANGE-WEEKMONTH-001 — 기본 '이번달' ('week'|'month'|'0'|숫자)
let currentChannel = '통합';
let charts = {};

// ─── CSV 파서 ────────────────────────────────────────────────
function parseCSVRow(row) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field.trim());
  return result;
}

function parseKRW(str) {
  if (!str) return 0;
  return parseInt(str.replace(/[₩,\s"]/g, '')) || 0;
}

function parseNum(str) {
  if (!str) return 0;
  return parseInt(str.replace(/[,\s"]/g, '')) || 0;
}

function parsePct(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[%,\s"]/g, '')) || 0;
}

// ─── 포맷터 ─────────────────────────────────────────────────
// fmtKRW: 축약 제거 — 전체 숫자 그대로 표시 (₩1,900,000 형식)
function fmtKRW(n) {
  return `₩${Math.round(Number(n) || 0).toLocaleString('ko-KR')}`;
}

// ─── 13채널 표준 정의 (2026-05-13 v4) ─────────────────
// daily_metrics.platform 값과 1:1 매칭. 미매핑은 'etc:<원본>'으로 들어와 "기타"로 합산.
const REVENUE_CHANNELS = [
  { platform: 'cafe24',           label: '🛒 자사몰',           color: '#3B82F6' },
  { platform: 'youtube_shop',     label: '📺 유튜브 쇼핑',      color: '#EF4444' },
  { platform: 'naver_store',      label: '🟢 스마트스토어',     color: '#10B981' },
  { platform: 'coupang',          label: '🛍️ 쿠팡',             color: '#F59E0B' },
  { platform: 'coupang_abler',    label: '🛍️ 쿠팡(아블러)',     color: '#FB923C' },
  { platform: 'kakao_talk_store', label: '💛 카카오(톡스토어)', color: '#FBBF24' },
  { platform: 'kakao_gift',       label: '💛 카카오(선물하기)', color: '#FCD34D' },
  { platform: 'wadiz',            label: '🟣 와디즈',           color: '#8B5CF6' },
  { platform: 'newtem',           label: '🟠 뉴템',             color: '#F97316' },
  { platform: 'today_house',      label: '🏠 오늘의집',         color: '#14B8A6' },
  { platform: 'oasis',            label: '🥗 오아시스',         color: '#84CC16' },
  { platform: 'toss',             label: '🔵 토스',             color: '#0EA5E9' },
  { platform: 'etc',              label: '📦 기타',             color: '#9CA3AF' },
];
const REVENUE_PLATFORMS = REVENUE_CHANNELS.map(c => c.platform);

function getChannelLabel(platform) {
  if (!platform) return '❓';
  if (platform.startsWith('etc:')) return `📦 기타 (${platform.slice(4)})`;
  const ch = REVENUE_CHANNELS.find(c => c.platform === platform);
  return ch ? ch.label : `❓ ${platform}`;
}
function getChannelColor(platform) {
  if (platform.startsWith('etc:')) return '#9CA3AF';
  const ch = REVENUE_CHANNELS.find(c => c.platform === platform);
  return ch ? ch.color : '#9CA3AF';
}

// 채널별 일자 매트릭스 데이터 (date -> {platform -> {sales, ad_spend, raw}})
let matrixData = {};   // { '2026-05-13': { 'cafe24': {sales: 12345, ad_spend: 0, raw: {...}}, ... } }
let matrixDates = [];  // 정렬된 날짜 배열

// fmtNum: 축약 제거 — 전체 숫자 그대로
function fmtNum(n) {
  return Math.round(Number(n) || 0).toLocaleString('ko-KR');
}

function fmtDate(str) {
  return str ? str.slice(5) : ''; // MM-DD
}

// ─── Google Sheets CSV 패치 (다중 gid 캐시) ──────────────────
async function fetchSheetCSV(gid = 0) {
  if (rawCSVByGid[gid]) return rawCSVByGid[gid];
  // 2026-06-04 #OB-EXPORT-FULL-001 — gviz/tq?out:csv 는 시트 필터/테이블 자동감지로 최근 ~100행만 반환(2026-04~06).
  //   → /export?format=csv 로 교체하면 시트 필터 무시, 전체 행 반환(2025-07~2026-06 365일). "과거 자료 안 들어옴" 근본 해결.
  //   (#OB-CSV-FIX-001 당시 export 400은 다른 시트 케이스였고, 본 시트는 link-share라 export 200 OK 확인)
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await lifecycleFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} (gid=${gid})`);
  const text = await res.text();
  rawCSVByGid[gid] = text;
  if (gid === 0) rawCSV = text; // 구버전 호환 (gid=0)
  return text;
}

// 채널 데이터 로드 — 채널 매핑의 gid에 해당하는 시트 fetch + 파싱
// 2026-05-26 #OB-DOUBLE-MERGE-FIX — 채널별 머지를 여기 1곳에 통합 (탭 click 또는 init에서 다시 머지하면 이중 합산됨)
async function loadChannelData(channel) {
  if (channelDataCache[channel]) return channelDataCache[channel];
  const cols = CHANNEL_COL_MAP[channel];
  if (!cols) return [];
  const gid = (typeof cols.gid === 'number') ? cols.gid : 0;
  let csv = rawCSVByGid[gid];
  if (!csv) {
    try {
      csv = await fetchSheetCSV(gid);
    } catch (e) {
      console.warn(`[OneBoard] gid=${gid} fetch 실패:`, e.message);
      return [];
    }
  }
  let rows = parseSheetRows(csv, channel);

  // 채널별 머지 — cache miss 시 1회만 적용
  // 2026-05-26 #OB-INTEGRATED-NO-MERGE — 통합 시트 col F에 권수지 대리가 이미 와디즈 광고비 합산해 박았음 (5/13 ₩13,222,361 = ~₩411K + 와디즈 ₩12.81M). 머지하면 이중 합산. 5월 합 ₩24,470,374는 이미 정상값
  // if (channel === '통합')   rows = await mergeExtraAdSpendIntoIntegrated(rows);  // 폐기
  if (channel === '자사몰') rows = await attachMetaAdSpendToOwnshop(rows);
  if (channel === '네이버') rows = await mergeNaverAdSpend(rows);

  // 2026-06-04 #OB-EXPORT-FULL-001 — 과거 백필(#OB-HISTORY-MERGE-001) 제거.
  //   export 전환으로 각 채널 탭이 2025-07~ 전체 history를 자체 보유 → gid=0 백필 불필요.

  channelDataCache[channel] = rows;
  return rows;
}

function parseSheetRows(csvText, channel = '통합') {
  const cols = CHANNEL_COL_MAP[channel] || CHANNEL_COL_MAP['통합'];
  const lines = csvText.trim().split('\n').filter(l => l);

  // 2026-05-26 #OB-SALES-FIX-002 — Math.min(10,...) → lines.length 전체 검색
  // 시트의 일별 데이터는 row 20+부터 시작하는데 10줄만 검색해서 dataStart=-1 → 0개 반환되던 root cause
  let dataStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const v = parseCSVRow(lines[i]);
    const cell = (v[cols.dateCol] || '').replace(/"/g, '').trim();
    if (cell === '날짜') { dataStart = i + 1; break; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(cell)) { dataStart = i; break; }
  }
  if (dataStart === -1) return [];

  const rows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const v = parseCSVRow(lines[i]);
    const dateStr = (v[cols.dateCol] || '').replace(/"/g, '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    // 2026-06-04 #OB-SALES-FALLBACK-001 — 통합 등 일부 채널은 6월부터 총매출 칸(col)을 비우고 전환매출만 기입.
    //   총매출 0 && 전환매출>0 이면 전환매출을 총매출로 대체 → '이번주 총매출 0' 방지.
    //   salesCol===convCol 채널은 동일값이라 무영향, 과거(총매출 기입分)는 그대로.
    let _totalSales = parseKRW(v[cols.salesCol]);
    const _convSales = parseKRW(v[cols.convCol]);
    if (_totalSales === 0 && _convSales > 0) _totalSales = _convSales;

    rows.push({
      date:         dateStr,
      totalSales:   _totalSales,
      totalTraffic: parseNum(v[cols.trafficCol] || '0'),
      convSales:    _convSales,
      totalAdSpend: parseKRW(v[cols.adCol]),
      totalROAS:    parsePct(v[cols.roasCol]),
      convROAS:     parsePct(v[cols.roasCol]),
      adRatio:      parsePct(v[cols.adRatioCol]),
    });
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── API: oneboard-server에서 요약 데이터 패치 ───────────────
async function fetchAPIData(days = 30) {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const res = await authenticatedResponse(`/data/summary?from=${from}&to=${to}`);
    if (!res.ok) return null;
    const json = await res.json();
    return apiSummaryToRows(json);
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return null;
  }
}

// API 응답(by_platform 배열)을 app.js 내부 row 포맷으로 변환
function apiSummaryToRows(json) {
  if (!json || !json.by_platform) return null;
  // by_platform을 날짜별 통합 row로 변환 (통합 채널 기준)
  const t = json.totals;
  // API는 기간 합산만 반환하므로, 기간을 하루 단위로 표현 불가.
  // daily 엔드포인트 데이터를 사용하기 위해 별도 패치 필요.
  // 현재는 totals로 오늘 날짜 단일 row 반환 (채널 탭별로 확장 예정)
  return null; // 아래 fetchAPIDailyData 사용
}

async function fetchAPIDailyData(days = 30) {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const res = await authenticatedResponse(`/data/daily?from=${from}&to=${to}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.rows || json.rows.length === 0) return null;
    // API 컬럼 → app.js row 포맷 매핑
    return json.rows.map(r => ({
      date:         r.date,
      totalSales:   parseInt(r.total_sales   || 0),
      totalTraffic: parseInt(r.total_traffic || 0),
      convSales:    parseInt(r.conversion_sales || 0),
      totalAdSpend: parseInt(r.ad_spend      || 0),
      totalROAS:    r.ad_spend > 0
                      ? Math.round(parseInt(r.total_sales || 0) / parseInt(r.ad_spend) * 100)
                      : 0,
      convROAS:     r.ad_spend > 0
                      ? Math.round(parseInt(r.conversion_sales || 0) / parseInt(r.ad_spend) * 100)
                      : 0,
      adRatio:      r.total_sales > 0
                      ? parseFloat((parseInt(r.ad_spend || 0) / parseInt(r.total_sales) * 100).toFixed(2))
                      : 0,
    }));
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return null;
  }
}

// ─── 13채널 매트릭스 fetch (daily_metrics 정본) ──────────────
async function fetchChannelMatrix(days = 30) {
  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const res = await authenticatedResponse(`/data/daily-by-platform?from=${from}&to=${to}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.rows || [];
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return null;
  }
}

// 평면 row 배열 → date×platform 매트릭스 구조로 변환
function buildMatrix(rows) {
  const matrix = {};
  const datesSet = new Set();
  for (const r of (rows || [])) {
    const date = r.date;
    datesSet.add(date);
    if (!matrix[date]) matrix[date] = {};
    // etc:* 원본명을 'etc'로 합산하되 raw 보존
    const platformRaw = r.platform || 'unknown';
    const platform = platformRaw.startsWith('etc:') ? 'etc' : platformRaw;
    const sales = parseInt(r.total_sales || 0);
    const adSpend = parseInt(r.ad_spend || 0);
    if (!matrix[date][platform]) {
      matrix[date][platform] = { sales: 0, ad_spend: 0, conversion_sales: 0, orders: 0, sources: [] };
    }
    matrix[date][platform].sales            += sales;
    matrix[date][platform].ad_spend         += adSpend;
    matrix[date][platform].conversion_sales += parseInt(r.conversion_sales || 0);
    matrix[date][platform].orders           += parseInt(r.conversions || 0);
    matrix[date][platform].sources.push({
      platform_raw: platformRaw,
      sales, ad_spend: adSpend,
      roas: r.roas, ctr: r.ctr, cpc: r.cpc,
    });
  }
  return { matrix, dates: Array.from(datesSet).sort().reverse() };
}

// 13채널 매트릭스 표 렌더
function renderChannelMatrix() {
  const head = document.getElementById('channelMatrixHead');
  const body = document.getElementById('channelMatrixBody');
  if (!head || !body) return;

  // 헤더: 날짜 + 13채널 + 합계
  head.innerHTML = `
    <tr>
      <th style="position:sticky;left:0;background:#F9FAFB;z-index:1">날짜</th>
      ${REVENUE_CHANNELS.map(c => `<th style="text-align:right;color:${c.color}">${c.label}</th>`).join('')}
      <th style="text-align:right;background:#EDE9FE;color:#6B46C1">합계</th>
    </tr>
  `;

  body.innerHTML = '';
  if (!matrixDates.length) {
    body.innerHTML = '<tr><td colspan="15" class="loading-row">데이터 없음 — 매출이 들어오면 자동 표시됩니다</td></tr>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const date of matrixDates) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openDayDetailModal(date));
    tr.addEventListener('mouseenter', () => { tr.style.background = '#F3F4F6'; });
    tr.addEventListener('mouseleave', () => { tr.style.background = ''; });

    // 날짜 셀
    const tdDate = document.createElement('td');
    tdDate.textContent = date;
    tdDate.style.cssText = 'position:sticky;left:0;background:#FFF;font-weight:600;z-index:1';
    tr.appendChild(tdDate);

    const dayData = matrixData[date] || {};
    let dayTotal = 0;

    for (const ch of REVENUE_CHANNELS) {
      const cell = dayData[ch.platform] || { sales: 0 };
      const td = document.createElement('td');
      td.style.textAlign = 'right';
      td.textContent = cell.sales > 0 ? fmtKRW(cell.sales) : '-';
      if (cell.sales > 0) td.style.color = ch.color;
      tr.appendChild(td);
      dayTotal += cell.sales;
    }

    const tdTotal = document.createElement('td');
    tdTotal.style.cssText = 'text-align:right;background:#EDE9FE;color:#6B46C1;font-weight:700';
    tdTotal.textContent = dayTotal > 0 ? fmtKRW(dayTotal) : '-';
    tr.appendChild(tdTotal);

    fragment.appendChild(tr);
  }
  body.appendChild(fragment);
}

// 일자 상세 모달
function openDayDetailModal(date) {
  const modal = document.getElementById('dayDetailModal');
  const title = document.getElementById('dayDetailTitle');
  const body  = document.getElementById('dayDetailBody');
  if (!modal || !title || !body) return;

  title.textContent = `📅 ${date} 채널별 매출·광고 상세`;

  const dayData = matrixData[date] || {};
  const channels = Object.keys(dayData).sort((a, b) => (dayData[b].sales || 0) - (dayData[a].sales || 0));

  if (channels.length === 0) {
    body.innerHTML = '<div class="loading-row">이 날짜에 들어온 데이터가 없습니다.</div>';
    modal.style.display = 'flex';
    return;
  }

  let totalSales = 0, totalAd = 0;
  const rows = channels.map(p => {
    const c = dayData[p];
    totalSales += c.sales;
    totalAd    += c.ad_spend;
    const roas = c.ad_spend > 0 ? Math.round(c.sales / c.ad_spend * 100) : null;
    const sourceList = (c.sources || [])
      .filter(s => s.platform_raw.startsWith('etc:'))
      .map(s => s.platform_raw.slice(4))
      .filter(Boolean);
    const etcNote = (p === 'etc' && sourceList.length > 0)
      ? `<div style="font-size:11px;color:#6B7280;margin-top:2px">원본: ${sourceList.join(', ')}</div>`
      : '';
    return `
      <tr>
        <td style="padding:10px;font-weight:600">${getChannelLabel(p)}${etcNote}</td>
        <td style="padding:10px;text-align:right">${fmtKRW(c.sales)}</td>
        <td style="padding:10px;text-align:right;color:#6B7280">${c.ad_spend > 0 ? fmtKRW(c.ad_spend) : '-'}</td>
        <td style="padding:10px;text-align:right">${roas != null ? roas + '%' : '-'}</td>
        <td style="padding:10px;text-align:right;color:#6B7280">${c.orders > 0 ? c.orders.toLocaleString('ko-KR') + '건' : '-'}</td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead style="background:#F3F4F6">
        <tr>
          <th style="padding:10px;text-align:left">채널</th>
          <th style="padding:10px;text-align:right">매출</th>
          <th style="padding:10px;text-align:right">광고비</th>
          <th style="padding:10px;text-align:right">ROAS</th>
          <th style="padding:10px;text-align:right">주문수</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot style="background:#EDE9FE;font-weight:700">
        <tr>
          <td style="padding:10px">합계</td>
          <td style="padding:10px;text-align:right">${fmtKRW(totalSales)}</td>
          <td style="padding:10px;text-align:right">${totalAd > 0 ? fmtKRW(totalAd) : '-'}</td>
          <td style="padding:10px;text-align:right">${totalAd > 0 ? Math.round(totalSales / totalAd * 100) + '%' : '-'}</td>
          <td style="padding:10px"></td>
        </tr>
      </tfoot>
    </table>
  `;
  modal.style.display = 'flex';
}

function closeDayDetailModal() {
  const modal = document.getElementById('dayDetailModal');
  if (modal) modal.style.display = 'none';
}
window.closeDayDetailModal = closeDayDetailModal;

// 매트릭스 CSV 내보내기
function exportChannelMatrixCSV() {
  const headers = ['날짜', ...REVENUE_CHANNELS.map(c => c.label.replace(/^[^\s]+\s/, '')), '합계'];
  const rows = matrixDates.map(date => {
    const d = matrixData[date] || {};
    let total = 0;
    const row = [date, ...REVENUE_CHANNELS.map(ch => {
      const s = (d[ch.platform] || { sales: 0 }).sales;
      total += s;
      return s;
    }), total];
    return row;
  });
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `oneboard_channel_matrix_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 매트릭스 로드 + 렌더 (외부에서 호출)
async function loadChannelMatrix(days) {
  const rows = await fetchChannelMatrix(days || rangeToDays(currentRange));
  const built = buildMatrix(rows || []);
  matrixData  = built.matrix;
  matrixDates = built.dates;
  renderChannelMatrix();
  const srcEl = document.getElementById('matrixSource');
  if (srcEl) srcEl.textContent = (rows && rows.length > 0) ? 'daily_metrics ✅' : '데이터 없음';
}

// ─── 목업 데이터 (시트 연동 실패 시) ─────────────────────────
function buildMockData() {
  const rows = [];
  const start = new Date('2025-07-01');
  const end   = new Date('2026-04-16');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const isWeekend = [0, 6].includes(d.getDay());
    const base = isWeekend ? 4600000 : 3600000;
    const totalSales = Math.round(base * (.7 + Math.random() * .8));
    const adSpend    = Math.round(totalSales * (.06 + Math.random() * .11));
    const convSales  = Math.round(adSpend * (2.5 + Math.random() * 3));

    rows.push({
      date:         d.toISOString().slice(0, 10),
      totalSales,
      totalTraffic: Math.round(1500 + Math.random() * 2000),
      convSales,
      totalAdSpend: adSpend,
      totalROAS:    Math.round(totalSales / adSpend * 100),
      convROAS:     Math.round(convSales / adSpend * 100),
      adRatio:      parseFloat((adSpend / totalSales * 100).toFixed(2)),
    });
  }
  return rows;
}

// ─── 네이버 광고비: GFA(col 11) + 검색광고(col 22) 합산 ──────
// 2026-05-26 #OB-NAVER-FIX-001 — Charles 지시: 네이버 채널 광고비 = GFA + 검색광고 합산. 매출(col 2 스토어매출) 그대로, 전환매출 = GFA+검색광고 전환매출 합산, ROAS 재계산
async function mergeNaverAdSpend(rows) {
  try {
    const [gfa, search] = await Promise.all([
      loadChannelData('네이버_GFA'),
      loadChannelData('네이버_검색광고'),
    ]);
    const adGFA       = Object.fromEntries((gfa    || []).map(r => [r.date, r.totalAdSpend || 0]));
    const adSearch    = Object.fromEntries((search || []).map(r => [r.date, r.totalAdSpend || 0]));
    const convGFA     = Object.fromEntries((gfa    || []).map(r => [r.date, r.totalSales   || 0]));
    const convSearch  = Object.fromEntries((search || []).map(r => [r.date, r.totalSales   || 0]));
    return rows.map(r => {
      const ad   = (adGFA[r.date]      || 0) + (adSearch[r.date]    || 0);
      const conv = (convGFA[r.date]    || 0) + (convSearch[r.date]  || 0);
      return {
        ...r,
        totalAdSpend: ad,
        convSales:    conv,
        totalROAS: ad > 0 ? Math.round((r.totalSales || 0) / ad * 100) : 0,
        convROAS:  ad > 0 ? Math.round(conv / ad * 100) : 0,
      };
    });
  } catch (e) {
    console.warn('[OneBoard] 네이버 광고비 합산 실패:', e.message);
    return rows;
  }
}

// ─── 자사몰 광고비: META 시트 col 9 cross-ref ────────────────
// 2026-05-26 #OB-OWN-FIX-001 — Charles 지시: 자사몰 광고비 = META 시트 J 컬럼(col 9). 자사몰 시트 col 8은 환불합계라 광고비로 잡으면 안 됨
async function attachMetaAdSpendToOwnshop(rows) {
  try {
    const metaRows = await loadChannelData('META');
    if (!metaRows || !metaRows.length) return rows;
    const byDate = Object.fromEntries(metaRows.map(r => [r.date, r.totalAdSpend || 0]));
    return rows.map(r => {
      const ad = byDate[r.date] || 0;
      return {
        ...r,
        totalAdSpend: ad,
        totalROAS: ad > 0 ? Math.round((r.totalSales || 0) / ad * 100) : 0,
        convROAS:  ad > 0 ? Math.round((r.convSales  || 0) / ad * 100) : 0,
      };
    });
  } catch (e) {
    console.warn('[OneBoard] META 광고비 자사몰 attach 실패:', e.message);
    return rows;
  }
}

// ─── 통합 KPI 합산: 기타매출 광고비+수수료 머지 ──────────────
// 2026-05-26 #OB-EXTRA-SALES-002 — Charles 지시: 통합 탭 총광고비에 기타매출 광고비+수수료 합산, 평균 ROAS 재계산
async function mergeExtraAdSpendIntoIntegrated(rows) {
  try {
    const extraRows = await loadChannelData('기타매출');
    if (!extraRows || !extraRows.length) return rows;
    const byDate = Object.fromEntries(extraRows.map(r => [r.date, r.totalAdSpend || 0]));
    return rows.map(r => {
      const extra = byDate[r.date] || 0;
      const merged = (r.totalAdSpend || 0) + extra;
      return {
        ...r,
        totalAdSpend: merged,
        totalROAS: merged > 0 ? Math.round((r.totalSales || 0) / merged * 100) : r.totalROAS,
        convROAS:  merged > 0 ? Math.round((r.convSales  || 0) / merged * 100) : r.convROAS,
      };
    });
  } catch (e) {
    console.warn('[OneBoard] 기타매출 광고비 머지 실패:', e.message);
    return rows;
  }
}

// ─── 날짜 필터 ───────────────────────────────────────────────
// 2026-05-26 #OB-DATE-PICKER-001 — 임의 기간 지정 지원. customFrom/customTo 우선, 없으면 days 기반
let customFromDate = null;
let customToDate = null;

// 2026-06-02 #OB-SALES-ANCHOR-001 — 값이 있는 마지막 날짜를 찾는다.
//   시트에 빈 미래행(₩-)이 미리 깔려 있어, '오늘' 기준 롤링 창이 빈 구간에 걸려
//   직전 달(값 꽉 찬 구간)이 가려지던 문제를 막기 위함.
function dataAnchorDate(data) {
  const hasVal = d => (d.totalSales > 0 || d.totalTraffic > 0 || d.totalAdSpend > 0 || d.convSales > 0);
  let anchor = '';
  for (const d of data) if (hasVal(d)) anchor = d.date; // data는 날짜 오름차순 정렬됨
  if (!anchor && data.length) anchor = data[data.length - 1].date;
  return anchor || new Date().toISOString().slice(0, 10);
}

// 2026-06-02 #OB-RANGE-WEEKMONTH-001 — 주/월 경계 (앵커 날짜 기준, UTC 일요일 시작)
function weekBounds(anchorStr) {
  const a = new Date(anchorStr + 'T00:00:00Z');
  const from = new Date(a); from.setUTCDate(a.getUTCDate() - a.getUTCDay());
  const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
// 매트릭스·API 호출용 일수 환산
function rangeToDays(range) {
  if (range === 'week') return 7;
  if (range === 'month') return 31;
  if (!range || range === '0' || range === 0) return 3650;
  return Number(range) || 30;
}

function applyRange(data, range) {
  if (customFromDate && customToDate) {
    return data.filter(d => d.date >= customFromDate && d.date <= customToDate);
  }
  if (!range || range === '0' || range === 0) return data; // 전체
  // 2026-06-02 #OB-SALES-ANCHOR-001/RANGE-WEEKMONTH-001 — '오늘'이 아니라 '값이 있는 마지막 날짜' 기준
  const anchorStr = dataAnchorDate(data);
  if (range === 'month') {                       // 이번달 = 앵커가 속한 달
    const ym = anchorStr.slice(0, 7);
    return data.filter(d => d.date.slice(0, 7) === ym);
  }
  if (range === 'week') {                         // 이번주 = 앵커가 속한 주(일~토)
    const b = weekBounds(anchorStr);
    return data.filter(d => d.date >= b.from && d.date <= b.to);
  }
  const n = Number(range);                        // 숫자 N일 (하위호환)
  const a = new Date(anchorStr + 'T00:00:00Z');
  a.setUTCDate(a.getUTCDate() - (n - 1));
  const cut = a.toISOString().slice(0, 10);
  return data.filter(d => d.date >= cut && d.date <= anchorStr);
}

// ─── KPI 계산 ─────────────────────────────────────────────
function calcKPIs(data) {
  const totalSales   = data.reduce((s, d) => s + d.totalSales, 0);
  const totalTraffic = data.reduce((s, d) => s + d.totalTraffic, 0);
  const totalAdSpend = data.reduce((s, d) => s + d.totalAdSpend, 0);
  const avgROAS      = totalAdSpend > 0 ? Math.round(totalSales / totalAdSpend * 100) : 0;
  return { totalSales, totalTraffic, totalAdSpend, avgROAS };
}

// ─── KPI 렌더 ──────────────────────────────────────────────
function renderKPIs(curr, prev) {
  setText('val-sales',   fmtKRW(curr.totalSales));
  setText('val-traffic', fmtNum(curr.totalTraffic));
  setText('val-adspend', fmtKRW(curr.totalAdSpend));
  setText('val-roas',    `${curr.avgROAS.toLocaleString()}%`);

  if (prev) {
    setChange('chg-sales',   curr.totalSales,   prev.totalSales);
    setChange('chg-traffic', curr.totalTraffic, prev.totalTraffic);
    setChange('chg-adspend', curr.totalAdSpend, prev.totalAdSpend);
    setChange('chg-roas',    curr.avgROAS,       prev.avgROAS);
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setChange(id, curr, prev) {
  const el = document.getElementById(id);
  if (!el || !prev) return;
  const pct   = ((curr - prev) / Math.abs(prev) * 100).toFixed(1);
  const isUp  = pct > 0;
  const arrow = isUp ? '▲' : '▼';
  el.textContent = `${arrow} ${Math.abs(pct)}% 전 기간 대비`;
  el.className = `kpi-change ${isUp ? 'up' : 'down'}`;
}

// ─── 차트 공통 설정 ──────────────────────────────────────────
const TOOLTIP = {
  backgroundColor: '#1E293B',
  titleColor: '#94A3B8',
  bodyColor: '#F8FAFC',
  borderColor: '#334155',
  borderWidth: 1,
  padding: 12,
  cornerRadius: 8,
};

const SCALES_BASE = {
  x: {
    grid: { display: false },
    ticks: { color: '#94A3B8', font: { size: 11 }, maxTicksLimit: 10 },
  },
  y: {
    grid: { color: '#F1F5F9' },
    ticks: { color: '#94A3B8', font: { size: 11 } },
    border: { display: false },
  },
};

// 데이터 샘플링 (차트가 너무 조밀하지 않게)
function sample(data, max = 60) {
  if (data.length <= max) return data;
  const step = Math.ceil(data.length / max);
  return data.filter((_, i) => i % step === 0);
}

// ─── 매출 추이 차트 ───────────────────────────────────────────
function renderSalesChart(data) {
  const ctx = document.getElementById('salesChart');
  if (!ctx) return;

  const s = sample(data, 60);
  charts.sales?.destroy();

  charts.sales = new Chart(ctx, {
    type: 'line',
    data: {
      labels: s.map(d => fmtDate(d.date)),
      datasets: [
        {
          label: '총 매출',
          data: s.map(d => d.totalSales),
          borderColor: '#3B82F6',
          backgroundColor: 'rgba(59,130,246,.06)',
          borderWidth: 2.5,
          pointRadius: 2,
          pointHoverRadius: 6,
          fill: true,
          tension: .35,
        },
        {
          label: '전환 매출',
          data: s.map(d => d.convSales),
          borderColor: '#10B981',
          backgroundColor: 'rgba(16,185,129,.04)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 6,
          fill: true,
          tension: .35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtKRW(ctx.raw)}`,
          },
        },
      },
      scales: {
        ...SCALES_BASE,
        y: {
          ...SCALES_BASE.y,
          ticks: { ...SCALES_BASE.y.ticks, callback: v => fmtKRW(v) },
        },
      },
    },
  });
}

// ─── ROAS 추이 차트 ───────────────────────────────────────────
function renderROASChart(data) {
  const ctx = document.getElementById('roasChart');
  if (!ctx) return;

  const s = sample(data, 30);
  charts.roas?.destroy();

  charts.roas = new Chart(ctx, {
    type: 'line',
    data: {
      labels: s.map(d => fmtDate(d.date)),
      datasets: [{
        label: 'ROAS',
        data: s.map(d => d.totalROAS),
        borderColor: '#10B981',
        backgroundColor: 'rgba(16,185,129,.08)',
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 5,
        fill: true,
        tension: .35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP, callbacks: { label: ctx => ` ROAS: ${ctx.raw}%` } },
      },
      scales: {
        ...SCALES_BASE,
        y: {
          ...SCALES_BASE.y,
          ticks: { ...SCALES_BASE.y.ticks, callback: v => `${v}%` },
        },
      },
    },
  });
}

// ─── 광고비율 추이 차트 ────────────────────────────────────────
function renderAdRatioChart(data) {
  const ctx = document.getElementById('adRatioChart');
  if (!ctx) return;

  const s = sample(data, 30);
  charts.adRatio?.destroy();

  charts.adRatio = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s.map(d => fmtDate(d.date)),
      datasets: [{
        label: '광고비율',
        data: s.map(d => d.adRatio),
        backgroundColor: 'rgba(245,158,11,.65)',
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { ...TOOLTIP, callbacks: { label: ctx => ` 광고비율: ${ctx.raw}%` } },
      },
      scales: {
        ...SCALES_BASE,
        y: {
          ...SCALES_BASE.y,
          ticks: { ...SCALES_BASE.y.ticks, callback: v => `${v}%` },
        },
      },
    },
  });
}

// ─── 채널 도넛 차트 ───────────────────────────────────────────
function renderChannelChart() {
  const ctx = document.getElementById('channelChart');
  if (!ctx) return;

  charts.channel?.destroy();

  charts.channel = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: CHANNEL_MOCK_SHARE.labels,
      datasets: [{
        data: CHANNEL_MOCK_SHARE.data,
        backgroundColor: CHANNEL_MOCK_SHARE.colors,
        borderWidth: 0,
        hoverOffset: 10,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '60%',
      plugins: {
        legend: {
          display: true,
          position: 'right',
          labels: {
            color: '#64748B',
            font: { size: 11 },
            padding: 8,
            boxWidth: 10,
            boxHeight: 10,
          },
        },
        tooltip: {
          ...TOOLTIP,
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw}%` },
        },
      },
    },
  });
}

// ─── XSS-safe 셀 생성 헬퍼 ──────────────────────────────────
function makeTd(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

// ─── 데이터 테이블 (innerHTML 미사용 — XSS 안전) ─────────────
function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  if (!tbody) return;

  // 기존 행 제거
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  const rows = [...data].reverse().slice(0, 60);

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'loading-row';
    td.textContent = '데이터 없음';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const r of rows) {
    const roasClass = r.totalROAS >= 1000 ? 'td-up' : r.totalROAS < 500 ? 'td-down' : '';
    const adClass   = r.adRatio  <= 8    ? 'td-up' : r.adRatio  > 15   ? 'td-down' : '';

    const tr = document.createElement('tr');
    tr.appendChild(makeTd(r.date));
    tr.appendChild(makeTd(fmtKRW(r.totalSales)));
    tr.appendChild(makeTd(r.totalTraffic.toLocaleString('ko-KR')));
    tr.appendChild(makeTd(fmtKRW(r.convSales)));
    tr.appendChild(makeTd(fmtKRW(r.totalAdSpend)));
    tr.appendChild(makeTd(`${r.totalROAS}%`, roasClass));
    tr.appendChild(makeTd(`${r.adRatio.toFixed(1)}%`, adClass));
    fragment.appendChild(tr);
  }
  tbody.appendChild(fragment);
}

// ─── CSV 내보내기 ─────────────────────────────────────────────
function exportCSV(data) {
  const headers = ['날짜','총 매출','총 유입','전환 매출','총 광고비','총 ROAS','광고비율'];
  const rows    = data.map(d => [
    d.date, d.totalSales, d.totalTraffic, d.convSales,
    d.totalAdSpend, `${d.totalROAS}%`, `${d.adRatio}%`,
  ]);
  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `oneboard_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── 대시보드 전체 업데이트 ──────────────────────────────────
function updateDashboard() {
  filteredData = applyRange(allData, currentRange);

  // 비교 기간 (이전 동일 기간) — 앵커(값 있는 마지막 날짜) 기준
  let prevData = [];
  if (allData.length && currentRange && currentRange !== '0' && currentRange !== 0) {
    const anchorStr = dataAnchorDate(allData);
    if (currentRange === 'month') {               // 직전 달
      const [y, m] = anchorStr.slice(0, 7).split('-').map(Number);
      const pym = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      prevData = allData.filter(d => d.date.slice(0, 7) === pym);
    } else if (currentRange === 'week') {          // 직전 주
      const b = weekBounds(anchorStr);
      const pf = new Date(b.from + 'T00:00:00Z'); pf.setUTCDate(pf.getUTCDate() - 7);
      const pt = new Date(b.from + 'T00:00:00Z'); pt.setUTCDate(pt.getUTCDate() - 1);
      prevData = allData.filter(d => d.date >= pf.toISOString().slice(0, 10) && d.date <= pt.toISOString().slice(0, 10));
    } else {                                       // 숫자 N일
      const n = Number(currentRange);
      const c1d = new Date(anchorStr + 'T00:00:00Z'); c1d.setUTCDate(c1d.getUTCDate() - (n - 1));
      const c2d = new Date(c1d); c2d.setUTCDate(c2d.getUTCDate() - n);
      prevData = allData.filter(d => d.date >= c2d.toISOString().slice(0, 10) && d.date < c1d.toISOString().slice(0, 10));
    }
  }

  const curr = calcKPIs(filteredData);
  const prev = prevData.length ? calcKPIs(prevData) : null;

  renderKPIs(curr, prev);
  renderSalesChart(filteredData);
  renderROASChart(filteredData);
  renderAdRatioChart(filteredData);
  renderChannelChart();
  renderTable(filteredData);

  // 13채널 매트릭스 (daily_metrics 정본 — 비동기 fire-and-forget)
  loadChannelMatrix(rangeToDays(currentRange)).catch(e => console.warn('[matrix] 로드 실패:', e.message));

  // 최근 날짜 표시 — 빈 미래행 무시, 값이 있는 마지막 날짜 (#OB-SALES-ANCHOR-001)
  const latest = allData.length ? dataAnchorDate(allData) : (filteredData.length ? filteredData[filteredData.length - 1].date : '');
  if (latest) document.getElementById('lastUpdated').textContent = `최근 데이터: ${latest}`;
}

// ─── 이벤트 바인딩 ────────────────────────────────────────────
function bindEvents() {
  // 날짜 범위 버튼
  document.querySelectorAll('.range-btn[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range; // 'week' | 'month' | '0' | 숫자 문자열
      // 프리셋 클릭 시 임의 기간 해제
      customFromDate = null;
      customToDate = null;
      const fromEl = document.getElementById('rangeFrom');
      const toEl   = document.getElementById('rangeTo');
      if (fromEl) fromEl.value = '';
      if (toEl)   toEl.value   = '';
      updateDashboard();
    });
  });

  // 2026-05-26 #OB-DATE-PICKER-001 — 임의 기간 적용
  document.getElementById('rangeApply')?.addEventListener('click', () => {
    const from = document.getElementById('rangeFrom')?.value;
    const to   = document.getElementById('rangeTo')?.value;
    if (!from || !to) { alert('시작일과 종료일을 모두 입력하세요'); return; }
    if (from > to) { alert('시작일이 종료일보다 늦을 수 없습니다'); return; }
    customFromDate = from;
    customToDate   = to;
    document.querySelectorAll('.range-btn[data-range]').forEach(b => b.classList.remove('active'));
    document.getElementById('rangeApply')?.classList.add('active');
    updateDashboard();
  });

  // 채널 탭 — 실데이터 전환 (다중 gid 비동기 로드)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChannel = btn.dataset.channel;
      const notice = document.getElementById('channelNotice');

      const cols = CHANNEL_COL_MAP[currentChannel];
      if (!cols) {
        if (notice) {
          notice.style.display = 'block';
          const spanEl = notice.querySelector('span');
          if (spanEl) spanEl.textContent = `⚠️ ${currentChannel} 채널 연동 준비 중입니다.`;
        }
        return;
      }

      // 로딩 표시
      const srcEl = document.getElementById('dataSource');
      if (srcEl && cols.gid !== 0) srcEl.textContent = `로딩 중... (gid=${cols.gid})`;

      try {
        // 2026-05-26 #OB-DOUBLE-MERGE-FIX — 채널별 머지는 loadChannelData 내부에서 1회만 처리. 여기서 다시 머지하면 이중 합산
        allData = await loadChannelData(currentChannel);
      } catch (e) {
        console.warn(`[OneBoard] ${currentChannel} 로드 실패:`, e.message);
        allData = [];
      }

      if (allData.length === 0) {
        // 데이터 없는 채널 — 안내 표시
        if (notice) {
          notice.style.display = 'block';
          const spanEl = notice.querySelector('span');
          if (spanEl) spanEl.textContent = `⚠️ ${currentChannel} 채널 데이터 미연동 — API 키 설정 후 사용 가능합니다.`;
        }
      } else {
        if (notice) notice.style.display = 'none';
      }
      updateDashboard();

      // 유입 없는 채널 처리 (현재 매핑상 META만 해당)
      if (!cols.hasTraffic) {
        setText('val-traffic', '—');
        const chgEl = document.getElementById('chg-traffic');
        if (chgEl) { chgEl.textContent = '유입 미집계 채널'; chgEl.className = 'kpi-change neutral'; }
      }
    });
  });

  // CSV 내보내기
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    exportCSV(filteredData);
  });

  // 채널 매트릭스 CSV
  document.getElementById('matrixExportBtn')?.addEventListener('click', exportChannelMatrixCSV);

  // 일자 상세 모달 닫기 (오버레이 클릭)
  document.getElementById('dayDetailModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dayDetailModal') closeDayDetailModal();
  });
}

// ─── 초기화 ──────────────────────────────────────────────────
// 데이터 소스 우선순위:
//   1순위 — oneboard-server API (JWT 토큰 있을 때)
//   2순위 — Google Sheets CSV (공개 시트)
//   3순위 — mock 데이터 (graceful degradation)
async function init() {
  const lifecycleSignal = legacyLifecycleController?.signal;
  const srcEl = document.getElementById('dataSource');

  // 1순위: API 연동 시도
  try {
    const apiRows = await fetchAPIDailyData(rangeToDays(currentRange));
    if (lifecycleSignal?.aborted) return;
    if (apiRows && apiRows.length > 0) {
      allData = apiRows;
      channelDataCache['통합'] = allData;
      if (srcEl) srcEl.textContent = `API 실시간 연동 ✓  (${allData.length}일)`;
      console.log('[OneBoard] API 데이터 로드:', allData.length, '일');
      updateDashboard();
      return;
    }
  } catch (err) {
    if (isSessionExpired(err) || lifecycleSignal?.aborted) return;
    console.warn('[OneBoard] API 연동 실패:', err.message);
  }

  // 2순위: Google Sheets CSV 시도
  try {
    // 2026-05-26 #OB-DOUBLE-MERGE-FIX — loadChannelData가 머지+캐시까지 처리 (이중 머지 방지)
    allData = await loadChannelData('통합');
    if (lifecycleSignal?.aborted) return;
    if (allData.length === 0) throw new Error('파싱된 데이터 없음');
    if (srcEl) srcEl.textContent = `Google Sheets 실시간 연동 ✓  (${allData.length}일 · 채널 8개)`;
    console.log('[OneBoard] Sheets 데이터 로드:', allData.length, '일, 채널:', Object.keys(CHANNEL_COL_MAP).join(', '));
  } catch (err) {
    if (lifecycleSignal?.aborted) return;
    // 3순위: mock 데이터 (graceful degradation)
    console.warn('[OneBoard] Sheets 연동 실패 → 목업 데이터 사용:', err.message);
    allData = buildMockData();
    channelDataCache['통합'] = allData;
    if (srcEl) srcEl.textContent = '목업 데이터 (API 또는 시트 공개 후 자동 연동)';
  }

  updateDashboard();
}

async function waitForAuthenticatedSession() {
  if (!window.ONEBOARD_SESSION_READY) {
    await new Promise((resolve) => {
      window.addEventListener('oneboard:session-ready', resolve, { once: true });
    });
  }
  return window.ONEBOARD_SESSION_READY;
}

document.addEventListener('DOMContentLoaded', async () => {
  legacyDomReady = true;
  await waitForAuthenticatedSession();
  await startAuthenticatedLifecycle();
});




// ═══════════════════════════════════════════════════════════════
// 팀 캘린더 + 회의록 + KPI — 월간뷰 + Sheets 데이터 연동
// ═══════════════════════════════════════════════════════════════

const TEAM_MEMBERS = [
  { id: '찰스', name: '찰스', role: '대표 기획운영', color: '#EF4444', bg: '#FEF2F2' },
  { id: '이한수', name: '이한수', role: '차장', color: '#3B82F6', bg: '#EFF6FF' },
  { id: '권나경', name: '권나경', role: '과장', color: '#10B981', bg: '#F0FDF4' },
  { id: '권수지', name: '권수지', role: '대리', color: '#F59E0B', bg: '#FFFBEB' },
  { id: '컨텐츠팀', name: '컨텐츠팀', role: '콘텐츠', color: '#8B5CF6', bg: '#F5F3FF' },
];

// localStorage `ob_team_members` 마이그레이션 (2026-05-13 찰스 결정 — 옵션 B, 표기 1번):
//  (a) 별개 ID로 추가된 "찰스 대표" 멤버 제거
//  (b) 찰스 중복이 있으면 마지막(=뒤엣것)만 보존
//  (c) 찰스가 아예 없는 옛 사용자만 prepend
//  최종 형태는 id='찰스', name='찰스', role='대표 기획운영' 하나로 통일.
(function migrateTeamMembersCharles() {
  try {
    const saved = JSON.parse(localStorage.getItem('ob_team_members') || 'null');
    if (!Array.isArray(saved) || !saved.length) return;

    let dedup = saved.slice();

    // (a) 수동으로 추가된 "찰스 대표" 별개 멤버 제거
    dedup = dedup.filter(m => !(m && m.id === '찰스 대표'));

    // (b) id='찰스' 중복 시 마지막만 보존
    const lastCharlesIdx = dedup.map(m => (m && m.id) || '').lastIndexOf('찰스');
    dedup = dedup.filter((m, i) => !(m && m.id === '찰스' && i !== lastCharlesIdx));

    // (c) 찰스가 한 번도 없는 옛 사용자 케이스만 prepend
    if (!dedup.some(m => m && m.id === '찰스')) {
      dedup = [{ id: '찰스', name: '찰스', role: '대표 기획운영', color: '#EF4444', bg: '#FEF2F2' }, ...dedup];
    }

    if (dedup.length !== saved.length) {
      localStorage.setItem('ob_team_members', JSON.stringify(dedup));
      console.log('[migrate] 찰스 멤버 정리 — 별개 "찰스 대표" 제거 + 중복 dedup');
    }
  } catch {}
})();

const DAYS_KO = ['일','월','화','수','목','금','토'];

// ── 상태 ──────────────────────────────────────────────────────
let calMonth = (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); })(); // 기본값: 오늘이 속한 월
let calView = 'month';
let calSelectedDate = null;
let teamTasks = [];
let editingTaskId = null;
let currentMemberTab = '통합'; // 현재 선택된 팀원 탭

// ── Sheets 데이터 (curl로 가져온 원본 → 3월/4월 분배) ─────────
const SHEET_TASKS_PRESET = [
  { date:'2026-03-02', who:'박지현',    task:'마스터마인딩 2026년 업무계획',   status:'완료', priority:'높음' },
  { date:'2026-03-03', who:'박지현',    task:'연매출 30억 세부 계획안',         status:'완료', priority:'높음' },
  { date:'2026-03-04', who:'권나경',    task:'자금 계획 정부지원사업 신청',     status:'진행', priority:'높음' },
  { date:'2026-03-05', who:'권수지',    task:'인력 및 시스템 구축',             status:'진행', priority:'보통' },
  { date:'2026-03-07', who:'박지현',    task:'에벤에셀 미팅 회의록',            status:'완료', priority:'높음' },
  { date:'2026-03-10', who:'권나경',    task:'MMG 팀 빌딩',                    status:'완료', priority:'보통' },
  { date:'2026-03-12', who:'권수지',    task:'쥬얼아이스 업무 참고자료 정리',   status:'완료', priority:'낮음' },
  { date:'2026-03-14', who:'권수지',    task:'쥬얼아이스 월별 재고파악',        status:'완료', priority:'보통' },
  { date:'2026-03-17', who:'권나경',    task:'쥬얼아이스 월별 매출파악',        status:'완료', priority:'보통' },
  { date:'2026-03-19', who:'컨텐츠팀', task:'메타광고 배너 소재 제작',         status:'완료', priority:'높음' },
  { date:'2026-03-21', who:'박지현',    task:'재구매 상승 프로세스 설계',       status:'진행', priority:'높음' },
  { date:'2026-03-24', who:'권나경',    task:'쥬얼아이스 온라인 유통 정리',     status:'진행', priority:'높음' },
  { date:'2026-03-26', who:'컨텐츠팀', task:'쥬얼아이스 이벤트 기획',          status:'진행', priority:'높음' },
  { date:'2026-03-28', who:'권수지',    task:'쥬얼아이스 리뷰 정리',            status:'예정', priority:'보통' },
  { date:'2026-03-31', who:'권수지',    task:'해피홈 3월 재고파악 리스트',      status:'완료', priority:'보통' },
  { date:'2026-04-01', who:'권수지',    task:'쥬얼아이스 4월 재고파악',         status:'완료', priority:'보통' },
  { date:'2026-04-03', who:'권나경',    task:'4월 월별 매출파악',               status:'진행', priority:'보통' },
  { date:'2026-04-07', who:'박지현',    task:'연매출 30억 1분기 점검',          status:'완료', priority:'높음' },
  { date:'2026-04-09', who:'컨텐츠팀', task:'메타광고 소재 2차 제작',          status:'진행', priority:'높음' },
  { date:'2026-04-11', who:'권나경',    task:'정부지원사업 서류 마감',          status:'진행', priority:'높음' },
  { date:'2026-04-14', who:'박지현',    task:'신규 인력 채용 진행',             status:'진행', priority:'높음' },
  { date:'2026-04-16', who:'권나경',    task:'온라인 유통 채널 확장 검토',      status:'예정', priority:'보통' },
  { date:'2026-04-18', who:'컨텐츠팀', task:'4월 이벤트 기획 확정',            status:'완료', priority:'높음' },
  { date:'2026-04-20', who:'권수지',    task:'시스템 구축 1차 완료 점검',       status:'진행', priority:'보통' },
  { date:'2026-04-21', who:'컨텐츠팀', task:'5월 콘텐츠 캘린더 작성',          status:'예정', priority:'높음' },
  { date:'2026-04-23', who:'권나경',    task:'재구매 캠페인 소재 준비',         status:'예정', priority:'높음' },
  { date:'2026-04-25', who:'박지현',    task:'MMG 2차 팀 빌딩',                status:'예정', priority:'보통' },
  { date:'2026-04-28', who:'권수지',    task:'쥬얼아이스 리뷰 2차 정리',       status:'예정', priority:'보통' },
  // ── 4월 후반 + 5월 첫 주 (회의록 시트 13yy1Mt... 4/30·5/4·5/8 추출) ──
  { date:'2026-04-30', who:'권나경',    task:'대행사 에프로드로 이전 (수수료 15%)', status:'진행', priority:'높음' },
  { date:'2026-04-30', who:'권나경',    task:'GFA→디스플레이/브랜드검색 광고 60만원 검토', status:'예정', priority:'보통' },
  { date:'2026-04-30', who:'권수지',    task:'사방넷-이지어드민 안정화 2개월 운영',  status:'진행', priority:'보통' },
  { date:'2026-05-04', who:'권나경',    task:'사방넷 후속 세팅 + 와디즈 건 진행',   status:'진행', priority:'높음' },
  { date:'2026-05-04', who:'권나경',    task:'미스터스티키·어쿠스틱 큐브 정산 상신', status:'진행', priority:'높음' },
  { date:'2026-05-04', who:'권수지',    task:'재고 업데이트 + 피플스토리 수량 관리', status:'진행', priority:'보통' },
  { date:'2026-05-04', who:'권수지',    task:'B2B 업체 단가 인상 안내 (8건 후 인상)', status:'예정', priority:'보통' },
  { date:'2026-05-04', who:'컨텐츠팀', task:'어버이날 카카오톡 알림톡 + 랜딩 페이지', status:'진행', priority:'높음' },
  { date:'2026-05-06', who:'권수지',    task:'아블러(피플스토리)·듀오메이커(해피홈) 실링 출고', status:'예정', priority:'높음' },
  { date:'2026-05-07', who:'권수지',    task:'해피홈 컬러박스 입고 후 조립',         status:'예정', priority:'높음' },
  { date:'2026-05-07', who:'권나경',    task:'피플스토리 신규 물량 입고 + 몰드 수량 합산 반영', status:'예정', priority:'보통' },
  { date:'2026-05-08', who:'권수지',    task:'해피홈 최종 출고',                     status:'예정', priority:'높음' },
  { date:'2026-05-08', who:'이한수',    task:'팀장 합류 — 업무 인수인계 (or 5/12)', status:'예정', priority:'높음' },
  { date:'2026-05-09', who:'이한수',    task:'주간 업무 진행 상황 공유 + 5월 말 거래처 방문 일정 수립', status:'예정', priority:'보통' },
];

// 2026-05-29 #OB-MIN-EDIT-002 — MINUTES_PRESET 제거. 회의록은 minutes 시트 단일 출처(113건 마이그레이션 완료).

// ── localStorage / API ───────────────────────────────────────
function loadLocalTasks() {
  try { return JSON.parse(localStorage.getItem('ob_tasks') || '[]'); } catch { return []; }
}
function saveLocalTasks(list) { localStorage.setItem('ob_tasks', JSON.stringify(list)); }
function loadMinutesLocal() {
  try { return JSON.parse(localStorage.getItem('ob_minutes') || '[]'); } catch { return []; }
}
function saveMinutesLocal(list) { localStorage.setItem('ob_minutes', JSON.stringify(list)); }

// ── 인앱 알림 ────────────────────────────────────────────────
async function fetchNotifications() {
  try {
    const data = await apiFetch('/notifications');
    return data.notifications || [];
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    return [];
  }
}

function renderNotifications(notifs) {
  const badge = document.getElementById('notifBadge');
  const list  = document.getElementById('notifList');
  if (!badge || !list) return;
  const unread = notifs.filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 9 ? '9+' : unread;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
  if (!notifs.length) {
    const empty = document.createElement('div');
    empty.className = 'notif-empty';
    empty.textContent = '알림 없음';
    list.replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  notifs.forEach(n => {
    const t = new Date(n.createdAt);
    const timeStr = t.toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const item = document.createElement('div');
    item.className = `notif-item ${n.read ? '' : 'unread'}`;
    [['notif-item-title', n.title], ['notif-item-body', n.body], ['notif-item-time', timeStr]]
      .forEach(([className, text]) => {
        const child = document.createElement('div');
        child.className = className;
        child.textContent = String(text || '');
        item.appendChild(child);
      });
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
}

function bindNotifEvents() {
  const bell     = document.getElementById('notifBell');
  const dropdown = document.getElementById('notifDropdown');
  const readAll  = document.getElementById('notifReadAll');
  if (!bell) return;

  bell.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== 'none';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      const notifs = await fetchNotifications();
      renderNotifications(notifs);
    }
  });

  readAll?.addEventListener('click', async () => {
    try { await apiFetch('/notifications/read', { method: 'POST' }); } catch {}
    const notifs = await fetchNotifications();
    renderNotifications(notifs);
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('notifWrap')?.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
}

let notificationPollTimer = null;
let notificationPollGeneration = 0;
function startNotificationPolling() {
  if (notificationPollTimer !== null) return;
  const generation = ++notificationPollGeneration;
  const poll = async () => {
    try {
      const notifs = await fetchNotifications();
      if (notificationPollTimer !== null && generation === notificationPollGeneration) {
        renderNotifications(notifs);
      }
    } catch (error) {
      if (!isSessionExpired(error)) console.warn('[OneBoard] notification request failed');
    }
  };
  notificationPollTimer = setInterval(poll, 5 * 60 * 1000);
  void poll();
}

function stopNotificationPolling() {
  notificationPollGeneration += 1;
  if (notificationPollTimer !== null) clearInterval(notificationPollTimer);
  notificationPollTimer = null;
}

function showAutoTasksToast(count, tasks) {
  const existing = document.getElementById('autoTasksToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'autoTasksToast';
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1e293b;color:#fff;padding:16px 20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);z-index:9999;max-width:340px;font-size:14px;line-height:1.5';
  const lines = tasks.slice(0,5).map(t=>`<div style="margin-top:4px;color:#94a3b8">· [${t.assignee}] ${t.task}</div>`).join('');
  toast.innerHTML = `<div style="font-weight:700;margin-bottom:4px">✅ AI가 업무 ${count}건 자동 생성</div>${lines}${tasks.length>5?`<div style="color:#64748b;margin-top:4px">외 ${tasks.length-5}건...</div>`:''}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// 저장 상태 추적 (헤더 배지에 표시)
let dataSourceStatus = 'unknown'; // 'db' | 'local' | 'unknown'

// 2026-05-21 OneBoard 백엔드 폐기 (#OB-SUSPEND-001 / #OB-DRIVE-001) →
// 팀 업무 데이터 소스를 Google Sheets로 전환. 백엔드 호출 제거.
async function fetchTeamTasks(from, to) {
  let sheetTasks = null;
  try {
    // 2026-05-26 #OB-CSV-FIX-001 — export?format=csv 익명 GET이 HTTP 400 → GViz API로 교체
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_TEAM_TASKS_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_TEAM_TASKS_GID}`;
    const res = await lifecycleFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const lines = csv.trim().split('\n').filter(l => l);
    const rows = lines.slice(1).map(line => {
      // CSV 단순 파싱 (쉼표 분리 + 따옴표 처리)
      const cells = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
        cur += ch;
      }
      cells.push(cur);
      return cells;
    });
    // 중복 제거: (date|who|task) 키 기준 첫 행만 유지 (Sheet 직접 입력 시 발생할 수 있는 중복 방지)
    const seen = new Set();
    sheetTasks = rows
      .filter(r => r[0] && r[1] && r[2]) // date, who, task 필수
      .map((r, i) => ({
        id: `sheet-${i}`,
        date: r[0].trim(),
        who: r[1].trim(),
        task: r[2].trim(),
        status: r[3]?.trim() || '대기',
        priority: r[4]?.trim() || '보통',
        memo: r[5]?.trim() || '',
        _origin: 'sheet',
      }))
      .filter(t => {
        const key = `${t.date}|${t.who}|${t.task}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    dataSourceStatus = 'sheets';
  } catch (e) {
    console.warn('[OneBoard] 팀 업무 Sheets fetch 실패:', e.message);
    dataSourceStatus = 'local';
  }

  // Sheets 성공: Sheets tasks + (Sheets에 없는) PRESET ghost + localStorage 잔여
  if (sheetTasks) {
    const sheetKeys = new Set(sheetTasks.map(t => `${t.date}|${t.who}|${t.task}`));
    const presetGhost = SHEET_TASKS_PRESET
      .filter(t => !sheetKeys.has(`${t.date}|${t.who}|${t.task}`))
      .map((t,i) => ({ id:`preset-${i}`, ...t, memo:'', _origin:'preset_ghost' }));
    const local = loadLocalTasks()
      .map(t => ({ ...t, _origin: 'local' }))
      .filter(t => !sheetKeys.has(`${t.date}|${t.who}|${t.task}`));
    const merged = [...sheetTasks, ...presetGhost, ...local];
    return merged.filter(t => (!from||t.date>=from) && (!to||t.date<=to));
  }

  // Sheets 실패: PRESET + localStorage
  const local = loadLocalTasks().map(t => ({ ...t, _origin: 'local' }));
  const preset = SHEET_TASKS_PRESET.map((t,i) => ({ id:`preset-${i}`, ...t, memo:'', _origin:'preset_ghost' }));
  const all = [...preset, ...local];
  return all.filter(t => (!from||t.date>=from) && (!to||t.date<=to));
}

function refreshStatusBadge() {
  const el = document.getElementById('dataStatusBadge');
  if (!el) return;
  if (dataSourceStatus === 'sheets') {
    el.textContent = '📊 Google Sheets 동기화';
    el.title = `팀 업무 데이터는 Google Sheets에서 직접 관리됩니다.\n입력은 Sheets에서: ${SHEET_TEAM_TASKS_URL}`;
    el.style.cssText = 'background:#DBEAFE;color:#1E40AF;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;';
    el.onclick = () => window.open(SHEET_TEAM_TASKS_URL, '_blank');
  } else if (dataSourceStatus === 'local') {
    el.textContent = '⚠ 로컬 임시저장 (Sheets 연결 실패)';
    el.title = 'Google Sheets fetch 실패 — 데이터가 이 브라우저에만 저장됩니다.';
    el.style.cssText = 'background:#FEE2E2;color:#991B1B;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;';
  } else {
    el.textContent = '… 확인 중';
    el.style.cssText = 'background:#F3F4F6;color:#4B5563;padding:3px 10px;border-radius:999px;font-size:11px;';
  }
}

// 2026-05-21 OneBoard 양방향 동기화 (#OB-DRIVE-001) — Apps Script Web App 경유
// 성공: Sheets에 row 추가/수정/삭제 → CSV 캐시 무효화 → 다음 fetch 자동 반영
// 실패: localStorage fallback (이 브라우저에만 임시 저장)
async function createTask(payload) {
  const sync = await syncToSheet('create', payload);
  if (sync.ok) {
    rawCSVByGid = {}; // CSV 캐시 무효화 → 다음 fetchTeamTasks 호출 시 Sheets에서 새로 가져옴
    return { id: `sheet-pending-${Date.now()}`, ...payload, _origin: 'sheet' };
  }
  // Apps Script 미배포 또는 실패 → localStorage fallback
  const local = loadLocalTasks();
  const t = { id:`local-${Date.now()}`, ...payload };
  local.push(t);
  saveLocalTasks(local);
  if (sync.reason === 'apps_script_not_deployed' && !sessionStorage.getItem('oneboard_apps_script_notice_shown')) {
    sessionStorage.setItem('oneboard_apps_script_notice_shown', '1');
    setTimeout(() => alert(
      '⚠️ Apps Script 양방향 동기화가 아직 배포되지 않았습니다.\n\n' +
      '입력하신 내용은 이 브라우저에만 임시 저장됩니다.\n' +
      'Sheets에 직접 입력하시려면 아래 링크를 사용하세요:\n\n' +
      SHEET_TEAM_TASKS_URL
    ), 100);
  }
  return t;
}

async function updateTask(id, patch) {
  // sheet/preset/sheet-pending 항목 → Apps Script로 patch 전송 (key 기반)
  if (id.startsWith('sheet-') || id.startsWith('preset-')) {
    const src = teamTasks.find(t => t.id === id);
    if (src) {
      const key = teamTaskKey(src);
      const sync = await syncToSheet('update', { key, patch });
      if (sync.ok) {
        rawCSVByGid = {};
        return;
      }
    }
  }
  // local 또는 sync 실패 → localStorage
  const local = loadLocalTasks();
  const idx = local.findIndex(t => t.id===id);
  if (idx>=0) { local[idx]={...local[idx],...patch}; saveLocalTasks(local); return; }
  if (id.startsWith('sheet-') || id.startsWith('preset-')) {
    const src = id.startsWith('sheet-')
      ? teamTasks.find(t => t.id === id)
      : SHEET_TASKS_PRESET.find((_,i)=>`preset-${i}`===id);
    if (src) {
      const updated = {...src, id:`local-${Date.now()}`, ...patch};
      const newLocal = loadLocalTasks().filter(t=>t.id!==id);
      newLocal.push(updated);
      saveLocalTasks(newLocal);
    }
  }
}

async function deleteTask(id) {
  // sheet 항목 → Apps Script로 delete (key 기반)
  if (id.startsWith('sheet-')) {
    const src = teamTasks.find(t => t.id === id);
    if (src) {
      const sync = await syncToSheet('delete', { key: teamTaskKey(src) });
      if (sync.ok) {
        rawCSVByGid = {};
        teamTasks = teamTasks.filter(t=>t.id!==id);
        renderMonthCalendar();
        return;
      }
    }
  }
  if (id.startsWith('local-')) {
    const local = loadLocalTasks().filter(t=>t.id!==id);
    saveLocalTasks(local);
  }
  // preset 항목은 그냥 화면에서 숨김
  teamTasks = teamTasks.filter(t=>t.id!==id);
  renderMonthCalendar();
}

// ── 회의록 추적 상태 (preset 용 localStorage) ────────────────
function loadMinuteStates() {
  try { return JSON.parse(localStorage.getItem('minute_states') || '{}'); }
  catch { return {}; }
}
function saveMinuteStates(map) {
  try { localStorage.setItem('minute_states', JSON.stringify(map)); }
  catch {}
}
function getMinuteState(id) {
  const all = loadMinuteStates();
  return all[id] || {};
}
function setMinuteStateLocal(id, patch) {
  const all = loadMinuteStates();
  all[id] = { ...(all[id]||{}), ...patch };
  saveMinuteStates(all);
}

// 지시사항 카운트 (전체/완료) 계산
function dirCount(m) {
  const dirs = m.directives ? m.directives.trim().split('\n').filter(Boolean) : [];
  const states = Array.isArray(m.directive_states) ? m.directive_states : [];
  const done = dirs.reduce((acc, _, i) => acc + (states[i] ? 1 : 0), 0);
  return { total: dirs.length, done };
}

// 자동 상태 — 지시사항 모두 ✓ 시 완료, 일부 ✓ 시 진행, 0 ✓ 시 진행 (기본)
function autoStatusFromStates(m) {
  const { total, done } = dirCount(m);
  if (m.status === '보류') return '보류';
  if (total > 0 && done === total) return '완료';
  return '진행';
}

async function fetchMinutes() {
  let raw;
  let sheetList = [];

  // 2026-05-26 #OB-MW-001 후속 — 신규: OneBoard 팀 업무 매뉴얼 spreadsheet의 `minutes` 시트
  // 컬럼: date | title | attendees | summary | directives | content | id
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_TEAM_TASKS_ID}/gviz/tq?tqx=out:csv&sheet=minutes`;
    const res = await lifecycleFetch(url);
    if (res.ok) {
      const csv = await res.text();
      // 2026-05-29 #OB-MIN-EDIT-002 핫픽스 — content에 줄바꿈이 많아 parseSimpleCSV가
      //   한 회의를 여러 조각으로 쪼개던 버그. 멀티라인 따옴표 셀을 처리하는 parseCSVMultiline로 교체.
      const rows = parseCSVMultiline(csv);
      for (let i = 1; i < rows.length; i++) { // i=0은 헤더행
        const r = rows[i];
        if (!r[0] || !r[1]) continue;
        sheetList.push({
          id: r[6] || `min-sheet-${r[0]}-${r[1].slice(0,20)}`,
          date: r[0],
          title: r[1],
          attendees: r[2] || '',
          summary: r[3] || '',
          directives: r[4] || '',
          content: r[5] || '',
          status: '진행',
          directive_states: [],
          _origin: 'sheet_v2',
        });
      }
    }
  } catch (e) { console.warn('[OneBoard] minutes 신규 시트 fetch 실패:', e.message); }

  // 2026-05-29 #OB-MIN-EDIT-002 — 회의록 단일 출처로 통합.
  //   기존: minutes 시트(sheet_v2) + Legacy 별도 시트(13yy1Mt...) + 하드코딩 MINUTES_PRESET 3출처 머지.
  //   문제: Legacy/preset 항목은 백엔드가 손댈 수 없는 id라 수정/삭제 불가(조용히 실패).
  //   해결: Legacy(81) + preset(104) → 날짜 dedup 113건을 minutes 시트로 1회 마이그레이션 완료.
  //         이제 minutes 시트(sheet_v2)만 출처 = 모든 회의록이 실제 id 보유 = 수정·삭제 가능.
  //   local: OneBoard 화면에서 막 만든 회의록(시트 반영 직전) fallback — 시트에 있으면 dedup.
  const local = loadMinutesLocal();
  const keyOf = (m) => `${m.date}::${(m.title || '').slice(0, 40)}`;
  const sheetKeys = new Set(sheetList.map(keyOf));
  const merged = [...sheetList];
  for (const l of local) {
    if (!sheetKeys.has(keyOf(l))) merged.push({ ...l, _origin: l._origin || 'local' });
  }
  merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  raw = merged;
  // localStorage 상태 병합 (preset/local 회의록 추적 — DB 없는 경우)
  const states = loadMinuteStates();
  return raw.map(m => {
    const local = states[m.id] || {};
    const merged = {
      ...m,
      status: m.status || local.status || '진행',
      directive_states: (m.directive_states && m.directive_states.length)
        ? m.directive_states
        : (local.directive_states || []),
    };
    return merged;
  });
}

async function patchMinute(id, patch, origin) {
  // 2026-05-21 백엔드 폐기 → 모두 localStorage 상태로 (sheet/preset/local 동일)
  // Sheet 회의록 자체 수정은 권수지·이한수가 시트에 직접 (양방향 sync는 별도 Apps Script 필요)
  setMinuteStateLocal(id, patch);
  return true;
}

async function createMinutes(payload) {
  // 2026-05-26 #OB-MW-001 후속 — Google Sheets `minutes` 시트 양방향 sync
  const list = loadMinutesLocal();
  const id = `min-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const m = { id, ...payload };
  list.unshift(m);
  saveMinutesLocal(list);
  // Sheets POST (실패 시 localStorage 잔존 — 다음 fetch에서 머지)
  const sync = await syncToSheet('minutes_create', {
    id,
    date: payload.date || '',
    title: payload.title || '',
    attendees: payload.attendees || '',
    summary: payload.summary || '',
    directives: payload.directives || '',
    content: payload.content || '',
  });
  // 2026-05-29 #OB-MIN-EDIT-002 — 동기화 결과 사용자에 표시 (조용한 실패 제거)
  if (!sync || !sync.ok) {
    setTimeout(() => alert(
      '⚠️ 회의록 저장 동기화 실패: ' + ((sync && (sync.error || sync.reason)) || '알 수 없음') + '\n\n' +
      '이 브라우저에 임시 저장됐습니다. 잠시 후 다시 시도해 주세요.'
    ), 100);
  } else if (!sessionStorage.getItem('oneboard_minutes_notice_shown')) {
    sessionStorage.setItem('oneboard_minutes_notice_shown', '1');
    setTimeout(() => alert(
      '✅ 회의록이 공유 시트에 저장됐습니다.\n팀원 화면에도 자동 반영되며, 여기서 바로 수정·삭제할 수 있습니다.'
    ), 100);
  }
  return { minutes: m, autoCount: 0, autoTasks: [] };
}

// 2026-05-26 #OB-MIN-EDIT-001 — 회의록 수정 (Sheets `minutes` 시트 + localStorage 동시)
async function updateMinutes(id, patch) {
  if (!id) return { ok: false, reason: 'no id' };
  // localStorage 갱신 (있는 경우)
  const list = loadMinutesLocal();
  const idx = list.findIndex(m => String(m.id) === String(id));
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch };
    saveMinutesLocal(list);
  }
  // Apps Script POST
  const result = await syncToSheet('minutes_update', { id, patch });
  if (!result || !result.ok) {
    alert('⚠️ 회의록 수정 실패: ' + ((result && (result.error || result.reason)) || '알 수 없음'));
  }
  return result;
}

// 2026-05-26 #OB-MIN-EDIT-001 — 회의록 삭제
async function deleteMinutes(id) {
  if (!id) return { ok: false, reason: 'no id' };
  const list = loadMinutesLocal();
  const filtered = list.filter(m => String(m.id) !== String(id));
  if (filtered.length !== list.length) saveMinutesLocal(filtered);
  const result = await syncToSheet('minutes_delete', { id });
  if (!result || !result.ok) {
    alert('⚠️ 회의록 삭제 실패: ' + ((result && (result.error || result.reason)) || '알 수 없음'));
  }
  return result;
}

// ── 날짜 유틸 ────────────────────────────────────────────────
function toYMD(d) {
  // 로컬 시간 기준 YYYY-MM-DD (toISOString은 UTC 변환되어 KST에서 1일 어긋남)
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function isToday(d) { return toYMD(d)===toYMD(new Date()); }
function isSameMonth(d, ref) { return d.getFullYear()===ref.getFullYear() && d.getMonth()===ref.getMonth(); }
function getMemberStyle(who) {
  return TEAM_MEMBERS.find(m=>m.id===who||m.name===who) || { color:'#94A3B8', bg:'#F8FAFC' };
}

// ── 월간 캘린더 ──────────────────────────────────────────────
function getMonthCalDates(monthDate) {
  const year = monthDate.getFullYear(), month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const last  = new Date(year, month+1, 0);
  // 일요일 시작 (Google Calendar 방식)
  const startDow = first.getDay(); // 일=0, 월=1, ..., 토=6
  const start = new Date(first); start.setDate(first.getDate()-startDow);
  const endDow = 6 - last.getDay(); // 토요일까지 채움
  const end = new Date(last); end.setDate(last.getDate()+endDow);
  const dates = [];
  for (let d=new Date(start); d<=end; d.setDate(d.getDate()+1)) dates.push(new Date(d));
  return dates;
}

// 2026-05-29 #OB-CAL-DND-001 — 캘린더 일정 드래그&드롭 이동 (구글 캘린더식)
function makeTaskDraggable(el, taskId) {
  el.draggable = true;
  el.style.cursor = 'grab';
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', String(taskId));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('cal-dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('cal-dragging'));
}
function makeCellDropTarget(cell, ymd, rerender) {
  cell.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cell.classList.add('cal-drop-over');
  });
  cell.addEventListener('dragleave', e => { if (e.target === cell) cell.classList.remove('cal-drop-over'); });
  cell.addEventListener('drop', async e => {
    e.preventDefault();
    cell.classList.remove('cal-drop-over');
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    const task = teamTasks.find(t => String(t.id) === String(id));
    if (!task || task.date === ymd) return;
    // updateTask는 현재 date로 시트 key를 계산하므로 mutate 전에 호출
    await updateTask(id, { date: ymd });
    task.date = ymd;
    rerender();
  });
}

function renderMonthCalendar() {
  const grid = document.getElementById('calGrid');
  if (!grid) return;
  const dates = getMonthCalDates(calMonth);
  const fragment = document.createDocumentFragment();

  // 요일 헤더 (일=빨강, 토=파랑)
  DAYS_KO.forEach((day, i) => {
    const th = document.createElement('div');
    th.className = 'cal-col-header' + (i===0?' sun':'') + (i===6?' sat':'');
    th.style.cssText = 'border-right:1px solid var(--border);padding:8px 10px;text-align:center';
    const dn = document.createElement('div');
    dn.className = 'cal-day-name';
    dn.textContent = day;
    th.appendChild(dn);
    fragment.appendChild(th);
  });

  // 날짜 셀
  const visibleTasks = currentMemberTab === '통합' ? teamTasks : teamTasks.filter(t=>t.who===currentMemberTab||t.who===currentMemberTab);
  dates.forEach(d => {
    const ymd = toYMD(d);
    const dayTasks = visibleTasks.filter(t=>t.date===ymd);
    const inMonth = isSameMonth(d, calMonth);
    const dow = d.getDay();

    const cell = document.createElement('div');
    cell.className = 'cal-month-cell'
      + (isToday(d)?' today':'')
      + (inMonth?'':' other-month')
      + (dow===0?' sun':'')
      + (dow===6?' sat':'');

    const dayNum = document.createElement('div');
    dayNum.className = 'cal-month-day-num';
    dayNum.textContent = d.getDate();
    cell.appendChild(dayNum);
    makeCellDropTarget(cell, ymd, renderMonthCalendar);

    // 업무 표시 (최대 3개 + 더보기)
    const visible = dayTasks.slice(0, 3);
    visible.forEach(t => {
      const style = getMemberStyle(t.who);
      const el = document.createElement('div');
      el.className = `cal-month-task${t.status==='완료'?' done':''}`;
      el.style.cssText = `background:${style.bg};border-left:2px solid ${style.color};color:${style.color}`;
      el.textContent = `${t.who.slice(0,2)} ${t.task}`;
      el.title = `${t.who}: ${t.task} (${t.status})`;
      makeTaskDraggable(el, t.id);
      el.addEventListener('click', e=>{ e.stopPropagation(); openTaskEditModal(t); });
      // 삭제 버튼 (구글 캘린더 패턴: 항목 hover 시 ✕ 노출)
      const delBtn = document.createElement('span');
      delBtn.textContent = '✕';
      delBtn.title = '삭제';
      delBtn.style.cssText = 'float:right;cursor:pointer;opacity:0;transition:opacity .12s;padding:0 4px;font-weight:600';
      el.addEventListener('mouseenter', ()=>delBtn.style.opacity='1');
      el.addEventListener('mouseleave', ()=>delBtn.style.opacity='0');
      delBtn.addEventListener('click', async e=>{ e.stopPropagation(); if(confirm('이 업무를 삭제하시겠습니까?')) await deleteTask(t.id); });
      el.appendChild(delBtn);
      cell.appendChild(el);
    });

    if (dayTasks.length > 3) {
      const more = document.createElement('div');
      more.className = 'cal-month-more';
      more.textContent = `+${dayTasks.length-3}개 더`;
      more.addEventListener('click', ()=>{ calSelectedDate=d; switchCalView('week'); });
      cell.appendChild(more);
    }

    // + 추가 (호버 시 노출)
    const addBtn = document.createElement('button');
    addBtn.className = 'cal-month-add';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e=>{ e.stopPropagation(); openQuickAdd(ymd, cell); });
    cell.appendChild(addBtn);

    // 셀 빈 공간 클릭 → 캘린더식 인라인 입력 (Google Calendar 패턴)
    cell.addEventListener('click', e=>{
      if (e.target === cell
          || e.target === dayNum
          || e.target.classList.contains('cal-month-day-num')) {
        openQuickAdd(ymd, cell);
      }
    });

    fragment.appendChild(cell);
  });

  grid.replaceChildren(fragment);
  grid.style.gridTemplateColumns = 'repeat(7, minmax(0, 1fr))';

  const labelEl = document.getElementById('calWeekLabel');
  if (labelEl) {
    labelEl.textContent = `${calMonth.getFullYear()}년 ${calMonth.getMonth()+1}월`;
  }
}

// ── 주간 뷰 (월~일 7일 가로 그리드) ──────────────────────────
function fmtKo(d) { return d.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'}); }

function getWeekStart(d) {
  const dt = new Date(d);
  const dow = dt.getDay(); // 일=0 시작 (Google Calendar 방식)
  dt.setDate(dt.getDate() - dow);
  dt.setHours(0,0,0,0);
  return dt;
}

function renderWeekCalendar() {
  const grid = document.getElementById('calWeekGrid');
  if (!grid) return;
  const start = getWeekStart(calSelectedDate || calMonth || new Date());
  const dates = [];
  for (let i=0; i<7; i++) {
    const d = new Date(start); d.setDate(start.getDate()+i);
    dates.push(d);
  }

  const fragment = document.createDocumentFragment();

  // 요일 헤더 (일=빨강, 토=파랑)
  DAYS_KO.forEach((day, i) => {
    const th = document.createElement('div');
    th.className = 'cal-col-header' + (i===0?' sun':'') + (i===6?' sat':'');
    th.style.cssText = 'border-right:1px solid var(--border);padding:8px 10px;text-align:center';
    const dn = document.createElement('div');
    dn.className = 'cal-day-name';
    dn.textContent = `${day} · ${dates[i].getMonth()+1}/${dates[i].getDate()}`;
    th.appendChild(dn);
    fragment.appendChild(th);
  });

  const visibleTasks = currentMemberTab === '통합'
    ? teamTasks
    : teamTasks.filter(t => t.who === currentMemberTab);

  dates.forEach(d => {
    const ymd = toYMD(d);
    const dayTasks = visibleTasks.filter(t => t.date === ymd);
    const dow = d.getDay();

    const cell = document.createElement('div');
    cell.className = 'cal-month-cell cal-week-cell'
      + (isToday(d) ? ' today' : '')
      + (dow===0?' sun':'')
      + (dow===6?' sat':'');

    const dayNum = document.createElement('div');
    dayNum.className = 'cal-month-day-num';
    dayNum.textContent = d.getDate();
    cell.appendChild(dayNum);
    makeCellDropTarget(cell, ymd, renderWeekCalendar);

    // 주간뷰는 모든 task 표시 (제한 X)
    dayTasks.forEach(t => {
      const style = getMemberStyle(t.who);
      const el = document.createElement('div');
      el.className = `cal-month-task${t.status==='완료'?' done':''}`;
      el.style.cssText = `background:${style.bg};border-left:3px solid ${style.color};color:${style.color}`;
      el.textContent = `${t.who.slice(0,3)} ${t.task}`;
      el.title = `${t.who}: ${t.task} (${t.status} · ${t.priority})`;
      makeTaskDraggable(el, t.id);
      el.addEventListener('click', e => { e.stopPropagation(); openTaskEditModal(t); });

      const delBtn = document.createElement('span');
      delBtn.textContent = '✕';
      delBtn.title = '삭제';
      delBtn.style.cssText = 'float:right;cursor:pointer;opacity:0;transition:opacity .12s;padding:0 4px;font-weight:600';
      el.addEventListener('mouseenter', () => delBtn.style.opacity='1');
      el.addEventListener('mouseleave', () => delBtn.style.opacity='0');
      delBtn.addEventListener('click', async e => { e.stopPropagation(); if (confirm('이 업무를 삭제하시겠습니까?')) await deleteTask(t.id); });
      el.appendChild(delBtn);
      cell.appendChild(el);
    });

    // + 버튼
    const addBtn = document.createElement('button');
    addBtn.className = 'cal-month-add';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => { e.stopPropagation(); openQuickAdd(ymd, cell); });
    cell.appendChild(addBtn);

    // 셀 빈 공간 클릭
    cell.addEventListener('click', e => {
      if (e.target === cell || e.target === dayNum
          || e.target.classList.contains('cal-month-day-num')) {
        openQuickAdd(ymd, cell);
      }
    });

    fragment.appendChild(cell);
  });

  grid.replaceChildren(fragment);
  grid.style.gridTemplateColumns = 'repeat(7, minmax(0, 1fr))';

  const labelEl = document.getElementById('calWeekLabel');
  if (labelEl) {
    const last = dates[6];
    labelEl.textContent = `${start.getMonth()+1}/${start.getDate()} ~ ${last.getMonth()+1}/${last.getDate()}`;
  }
}

// (보존: 일간 뷰는 비활성. 향후 재사용 대비)
function renderDayView(date) {
  const dateEl = document.getElementById('calDayDate');
  if (dateEl) dateEl.textContent = fmtKo(date);
  const list = document.getElementById('calDayList');
  if (!list) return;
  list.innerHTML = '';
  const ymd = toYMD(date);
  const dayTasks = teamTasks.filter(t=>t.date===ymd);

  const addRow = document.createElement('div');
  addRow.style.cssText = 'padding:12px 24px;border-bottom:1px solid var(--border)';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.style.fontSize='13px';
  addBtn.textContent = `+ ${fmtKo(date)} 업무 추가`;
  addBtn.addEventListener('click', ()=>openQuickAdd(ymd, addBtn));
  addRow.appendChild(addBtn);
  list.appendChild(addRow);

  if (!dayTasks.length) {
    const empty = document.createElement('div');
    empty.className='cal-empty';
    empty.textContent='이 날 등록된 업무가 없습니다.';
    list.appendChild(empty);
    return;
  }
  TEAM_MEMBERS.forEach(member=>{
    const tasks = dayTasks.filter(t=>t.who===member.id||t.who===member.name);
    if (!tasks.length) return;
    const section = document.createElement('div');
    section.className='cal-day-member-section';
    const mName = document.createElement('div');
    mName.className='cal-day-member-name';
    mName.style.color=member.color;
    mName.textContent=`${member.name} · ${member.role}`;
    section.appendChild(mName);
    tasks.forEach(t=>{
      const row = document.createElement('div');
      row.className=`cal-day-task${t.status==='완료'?' done':''}`;
      row.style.cursor='pointer';
      const dot = document.createElement('div');
      dot.className='cal-day-dot';
      dot.style.background=member.color;
      const body = document.createElement('div');
      body.className='cal-day-task-body';
      const text = document.createElement('div');
      text.className='cal-day-task-text';
      text.textContent=t.task;
      const meta = document.createElement('div');
      meta.className='cal-day-task-meta';
      meta.textContent=[t.status, t.priority!=='보통'?t.priority:'', t.memo].filter(Boolean).join(' · ');
      body.appendChild(text);
      body.appendChild(meta);
      row.appendChild(dot);
      row.appendChild(body);
      row.addEventListener('click',()=>openTaskEditModal(t));
      section.appendChild(row);
    });
    list.appendChild(section);
  });
}

function switchCalView(view) {
  if (view !== 'month' && view !== 'week') view = 'month';
  calView = view;
  document.querySelectorAll('[data-calview]').forEach(b=>b.classList.toggle('active',b.dataset.calview===view));
  const monthWrap = document.getElementById('calMonthView');
  const weekWrap  = document.getElementById('calWeekView');
  if (view==='month') {
    if (monthWrap) monthWrap.style.display='';
    if (weekWrap)  weekWrap.style.display='none';
    renderMonthCalendar();
  } else {
    if (monthWrap) monthWrap.style.display='none';
    if (weekWrap)  weekWrap.style.display='';
    renderWeekCalendar();
  }
}

// ── 팀원 탭 전환 ─────────────────────────────────────────────
function switchMemberTab(member) {
  currentMemberTab = member;
  document.querySelectorAll('.member-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.member === member);
  });
  const intView = document.getElementById('integratedView');
  const calView = document.getElementById('memberCalView');
  const importBar = document.getElementById('importBar');
  if (member === '통합') {
    if (intView) intView.style.display = '';
    if (calView) calView.style.display = 'none';
    if (importBar) importBar.style.display = 'none';
    renderIntegratedView();
  } else {
    if (intView) intView.style.display = 'none';
    if (calView) calView.style.display = '';
    if (importBar) importBar.style.display = '';
    renderMonthCalendar();
    const addBtn = document.getElementById('calAddMemberBtn');
    if (addBtn) {
      addBtn.onclick = () => openTaskModal(toYMD(new Date()), member);
    }
  }
}

// ── 통합 뷰 렌더링 (3컬럼: 좌 우선순위 / 가운데 캘린더 / 우 알림) ──
let intCalMonth = null;
let intShowArchive = false;

function isCurrentMonth(ymd, ref) {
  if (!ymd) return false;
  const [y,m] = ymd.split('-').map(n=>parseInt(n,10));
  return y === ref.getFullYear() && m === ref.getMonth()+1;
}

function renderIntegratedView() {
  const today = new Date();
  if (!intCalMonth) intCalMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  // ── 좌측: 우선순위 (현재월 미완료, 우선순위·날짜 정렬) ──
  const monthLabel = `${intCalMonth.getFullYear()}년 ${intCalMonth.getMonth()+1}월`;
  const monthLbl = document.getElementById('intPriorityMonth');
  if (monthLbl) monthLbl.textContent = `${monthLabel} 기준`;

  const priOrder = { '높음':0, '보통':1, '낮음':2 };
  const statusOrder = { '진행':0, '예정':1, '완료':2 };
  const monthly = teamTasks
    .filter(t => intShowArchive || isCurrentMonth(t.date, intCalMonth))
    .filter(t => intShowArchive || t.status !== '완료')
    .sort((a,b) => {
      const p = (priOrder[a.priority]??1) - (priOrder[b.priority]??1);
      if (p !== 0) return p;
      const s = (statusOrder[a.status]??1) - (statusOrder[b.status]??1);
      if (s !== 0) return s;
      return (a.date||'').localeCompare(b.date||'');
    });

  const blockersEl = document.getElementById('intBlockers');
  if (blockersEl) {
    if (!monthly.length) {
      blockersEl.innerHTML = `<div class="int3-empty">${intShowArchive?'표시할 항목 없음':'이번 달 미완료 없음 ✅'}</div>`;
    } else {
      blockersEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      monthly.forEach(t => {
        const style = getMemberStyle(t.who);
        const row = document.createElement('div');
        row.className = 'int3-pri-item';
        if (t.priority === '높음') row.classList.add('hi');
        row.innerHTML = `
          <span class="int3-mb" style="background:${style.bg};color:${style.color}">${escapeAttr(t.who)}</span>
          <span class="int3-pt">${escapeAttr(t.task)}</span>
          <span class="int3-st int3-st-${t.status==='진행'?'progress':(t.status==='완료'?'done':'todo')}">${t.status}</span>
          <span class="int3-dt">${t.date||''}</span>
        `;
        row.addEventListener('click', () => openTaskEditModal(t));
        frag.appendChild(row);
      });
      blockersEl.appendChild(frag);
    }
  }

  // ── 가운데: 통합 캘린더 (모든 멤버 색상 dot) ──
  renderIntegratedCalendar();

  // ── 우측: 최근 회의록 ──
  fetchMinutes().then(minutes => {
    const minEl = document.getElementById('intMinutes');
    if (!minEl) return;
    if (!minutes.length) {
      minEl.innerHTML = '<div class="int3-empty">회의록 없음</div>';
      return;
    }
    minEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    minutes.slice(0,5).forEach(m => {
      const c = dirCount(m);
      const status = autoStatusFromStates(m);
      const card = document.createElement('div');
      card.className = 'int3-min-card';
      card.innerHTML = `
        <div class="int3-min-head">
          <span class="int3-min-date">${m.date}</span>
          ${statusBadgeHtml(status)}
        </div>
        <div class="int3-min-title">${escapeAttr(m.title)}</div>
        ${c.total ? `<div class="int3-min-counter">지시 <strong>${c.done}/${c.total}</strong></div>` : ''}
      `;
      card.addEventListener('click', () => {
        switchSection('minutes');
        setTimeout(() => showMinutesDoc(m), 100);
      });
      frag.appendChild(card);
    });
    minEl.appendChild(frag);
  }).catch(()=>{});

  // ── 우측: 협업 알림 (지연 task) ──
  const delayed = teamTasks.filter(t => t.status==='진행' && t.date && t.date < toYMD(today));
  const alertsEl = document.getElementById('intAlerts');
  if (alertsEl) {
    if (!delayed.length) {
      alertsEl.innerHTML = '<div class="int3-empty">지연 항목 없음 ✅</div>';
    } else {
      alertsEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      delayed.slice(0,8).forEach(t => {
        const style = getMemberStyle(t.who);
        const row = document.createElement('div');
        row.className = 'int3-pri-item int3-delay';
        row.innerHTML = `
          <span class="int3-mb" style="background:${style.bg};color:${style.color}">${escapeAttr(t.who)}</span>
          <span class="int3-pt">${escapeAttr(t.task)}</span>
          <span class="int3-dt">${t.date} 지연</span>
        `;
        row.addEventListener('click', () => openTaskEditModal(t));
        frag.appendChild(row);
      });
      alertsEl.appendChild(frag);
    }
  }

  // 범례
  const legend = document.getElementById('intCalLegend');
  if (legend) {
    legend.innerHTML = TEAM_MEMBERS.map(m =>
      `<span class="int3-legend-item"><span class="int3-legend-dot" style="background:${m.color}"></span>${escapeAttr(m.name)} ${escapeAttr(m.role||'')}</span>`
    ).join('');
  }
}

// 통합 캘린더 (모든 멤버 task 한 그리드에)
function renderIntegratedCalendar() {
  const grid = document.getElementById('intCalGrid');
  if (!grid) return;
  const dates = getMonthCalDates(intCalMonth);
  const fragment = document.createDocumentFragment();

  // 요일 헤더 (일=빨강, 토=파랑)
  DAYS_KO.forEach((day, i) => {
    const th = document.createElement('div');
    th.className = 'cal-col-header' + (i===0?' sun':'') + (i===6?' sat':'');
    th.style.cssText = 'border-right:1px solid var(--border);padding:6px 10px;text-align:center';
    th.innerHTML = `<div class="cal-day-name">${day}</div>`;
    fragment.appendChild(th);
  });

  dates.forEach(d => {
    const ymd = toYMD(d);
    const dayTasks = teamTasks.filter(t => t.date === ymd);
    const inMonth = isSameMonth(d, intCalMonth);
    const dow = d.getDay(); // 0=일, 6=토

    const cell = document.createElement('div');
    cell.className = 'cal-month-cell int3-cal-cell'
      + (isToday(d)?' today':'')
      + (inMonth?'':' other-month')
      + (dow===0?' sun':'')
      + (dow===6?' sat':'');

    const dayNum = document.createElement('div');
    dayNum.className = 'cal-month-day-num';
    dayNum.textContent = d.getDate();
    cell.appendChild(dayNum);

    // 최대 4개 표시 + 더보기
    dayTasks.slice(0,4).forEach(t => {
      const style = getMemberStyle(t.who);
      const el = document.createElement('div');
      el.className = `cal-month-task${t.status==='완료'?' done':''}`;
      el.style.cssText = `background:${style.bg};border-left:3px solid ${style.color};color:${style.color}`;
      el.textContent = `${(t.who||'').slice(0,2)} ${t.task}`;
      el.title = `${t.who}: ${t.task} (${t.status})`;
      el.addEventListener('click', e => { e.stopPropagation(); openTaskEditModal(t); });
      cell.appendChild(el);
    });
    if (dayTasks.length > 4) {
      const more = document.createElement('div');
      more.className = 'cal-month-more';
      more.textContent = `+${dayTasks.length-4}개 더`;
      cell.appendChild(more);
    }

    // + 추가 (호버 시 노출)
    const addBtn = document.createElement('button');
    addBtn.className = 'cal-month-add';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => { e.stopPropagation(); openQuickAdd(ymd, cell); });
    cell.appendChild(addBtn);

    cell.addEventListener('click', e => {
      if (e.target === cell || e.target === dayNum
          || e.target.classList.contains('cal-month-day-num')) {
        openQuickAdd(ymd, cell);
      }
    });

    fragment.appendChild(cell);
  });

  grid.replaceChildren(fragment);
  grid.style.gridTemplateColumns = 'repeat(7, minmax(0, 1fr))';

  const lbl = document.getElementById('intCalLabel');
  if (lbl) lbl.textContent = `${intCalMonth.getFullYear()}년 ${intCalMonth.getMonth()+1}월`;
}

// ── 범례 ─────────────────────────────────────────────────────
function renderMemberLegend() {
  const el = document.getElementById('memberLegend');
  if (!el) return;
  el.innerHTML='';
  TEAM_MEMBERS.forEach(m=>{
    const item=document.createElement('div');
    item.className='legend-member';
    const dot=document.createElement('div');
    dot.className='legend-dot-member';
    dot.style.background=m.color;
    const label=document.createElement('span');
    label.textContent=`${m.name} ${m.role}`;
    item.appendChild(dot);
    item.appendChild(label);
    el.appendChild(item);
  });
}

// ── 팀 섹션 초기화 ───────────────────────────────────────────
async function renderTeamSection() {
  // 현재 월 ±3개월 — 과거 3개월 + 미래 3개월
  const today = new Date();
  const from = toYMD(new Date(today.getFullYear(), today.getMonth()-3, 1));
  const to   = toYMD(new Date(today.getFullYear(), today.getMonth()+4, 0));
  teamTasks = await fetchTeamTasks(from, to);
  refreshStatusBadge();
  // 백엔드 연결됐는데 localStorage에 옛날 입력 남아있으면 1회 자동 이전
  if (dataSourceStatus === 'db') {
    await migrateLocalToBackend();
    await migrateMonthlyLocalToBackend();
    await migrateWeeklyLocalToBackend();
  }
  switchMemberTab(currentMemberTab);
}

// ── localStorage → 백엔드 1회 자동 이전 ──────────────────────
let _localMigrationDone = false;
async function migrateLocalToBackend() {
  if (_localMigrationDone) return;
  _localMigrationDone = true;
  const local = loadLocalTasks();
  if (!local.length) return;
  // 백엔드 현재 데이터로 dedup
  const dbKeys = new Set(teamTasks
    .filter(t => t._origin === 'db')
    .map(t => `${t.date}|${t.who}|${t.task}`));
  const toMigrate = local.filter(t => t.date && t.who && t.task
    && !dbKeys.has(`${t.date}|${t.who}|${t.task}`));
  if (!toMigrate.length) {
    saveLocalTasks([]); // 이미 백엔드에 다 있으면 localStorage 비우기
    return;
  }
  try {
    const payload = toMigrate.map(t => ({
      date: t.date, assignee: t.who, task: t.task,
      status: t.status || '예정', priority: t.priority || '보통',
      memo: t.memo || ''
    }));
    const result = await apiFetch('/team/import-sheet', {
      method: 'POST',
      body: JSON.stringify({ tasks: payload })
    });
    saveLocalTasks([]);
    console.log(`[migrate] localStorage → 백엔드 ${result.imported || toMigrate.length}건 이전 완료`);
    showMigrationToast(result.imported || toMigrate.length);
    // refetch
    const today = new Date();
    const from = toYMD(new Date(today.getFullYear(), today.getMonth()-3, 1));
    const to   = toYMD(new Date(today.getFullYear(), today.getMonth()+4, 0));
    teamTasks = await fetchTeamTasks(from, to);
  } catch (err) {
    console.warn('[migrate] 이전 실패 — localStorage 보존:', err);
    _localMigrationDone = false;
  }
}

function showMigrationToast(count) {
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;
    background:#10B981;color:#fff;padding:12px 20px;border-radius:8px;
    box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:14px;font-weight:600;`;
  toast.textContent = `✅ 이전 임시저장 ${count}건 백엔드 영구 저장 완료`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── 월간 주관업무 localStorage → 백엔드 1회 이전 (원본 키 보존) ─
async function migrateMonthlyLocalToBackend() {
  if (localStorage.getItem('ob_monthly_migrated') === '1') return;
  let all;
  try { all = JSON.parse(localStorage.getItem('ob_team_monthly') || '{}'); }
  catch { all = {}; }
  const payload = [];
  for (const [memberId, byYm] of Object.entries(all)) {
    for (const [ym, rows] of Object.entries(byYm||{})) {
      (rows||[]).forEach((r, i) => {
        if (!r) return;
        const hasContent = (r.task||'').trim() || (r.platform||'').trim() || (r.automation||'').trim();
        if (!hasContent) return;
        payload.push({
          member_id: memberId, ym,
          task: r.task||'', platform: r.platform||'', automation: r.automation||'',
          sort_order: i,
        });
      });
    }
  }
  if (!payload.length) { localStorage.setItem('ob_monthly_migrated', '1'); return; }
  try {
    const r = await apiFetch('/team/monthly/import', {
      method: 'POST', body: JSON.stringify({ rows: payload })
    });
    localStorage.setItem('ob_monthly_migrated', '1');
    console.log(`[migrate] 월간 주관업무 ${r.imported||0}건 백엔드 이전 완료`);
  } catch (err) {
    console.warn('[migrate] 월간 이전 실패 — 다음 로그인 재시도:', err.message);
  }
}

// ── 주간 업무 localStorage → 백엔드 1회 이전 (원본 키 보존) ───
async function migrateWeeklyLocalToBackend() {
  if (localStorage.getItem('ob_weekly_migrated') === '1') return;
  let all;
  try { all = JSON.parse(localStorage.getItem('ob_team_weekly') || '{}'); }
  catch { all = {}; }
  const payload = [];
  for (const [memberId, byYm] of Object.entries(all)) {
    for (const [ym, slots] of Object.entries(byYm||{})) {
      for (const [slot, items] of Object.entries(slots||{})) {
        if (!WEEK_SLOTS.includes(slot)) continue;
        (items||[]).forEach((it, i) => {
          if (!it || !(it.text||'').trim()) return;
          payload.push({
            member_id: memberId, ym, slot,
            text: it.text||'', done: !!it.done, sort_order: i,
          });
        });
      }
    }
  }
  if (!payload.length) { localStorage.setItem('ob_weekly_migrated', '1'); return; }
  try {
    const r = await apiFetch('/team/weekly/import', {
      method: 'POST', body: JSON.stringify({ rows: payload })
    });
    localStorage.setItem('ob_weekly_migrated', '1');
    console.log(`[migrate] 주간 업무 ${r.imported||0}건 백엔드 이전 완료`);
  } catch (err) {
    console.warn('[migrate] 주간 이전 실패 — 다음 로그인 재시도:', err.message);
  }
}

// ── Quick Add Popover (Google Calendar 식 인라인 입력) ──────
let quickAddEl = null;

function closeQuickAdd() {
  if (quickAddEl) { quickAddEl.remove(); quickAddEl = null; }
  document.removeEventListener('mousedown', quickAddOutsideClick, true);
  document.removeEventListener('keydown', quickAddKeydown);
}
function quickAddOutsideClick(e) {
  if (quickAddEl && !quickAddEl.contains(e.target)) closeQuickAdd();
}
function quickAddKeydown(e) {
  if (e.key === 'Escape') closeQuickAdd();
}

function openQuickAdd(date, anchorEl) {
  closeQuickAdd();
  const ymd = typeof date === 'string' ? date : toYMD(date);
  const dateObj = typeof date === 'string' ? new Date(date+'T00:00:00') : date;
  // 자동 담당자: 멤버 탭이면 그 사람 (select 숨김), '통합'이면 dropdown 노출
  const isAutoMode = currentMemberTab !== '통합';
  const memberList = loadTeamMembers();
  const autoAssignee = isAutoMode ? currentMemberTab : (memberList[0]?.id || '');
  const autoMember = memberList.find(m => m.id === autoAssignee);
  const autoLabel = autoMember ? (autoMember.role ? `${autoMember.name} (${autoMember.role})` : autoMember.name) : autoAssignee;

  const pop = document.createElement('div');
  pop.className = 'quick-add-popover';
  pop.innerHTML = `
    <div class="quick-add-header">
      <span class="quick-add-date">${fmtKo(dateObj)}</span>
      <button class="quick-add-close" type="button" aria-label="닫기">×</button>
    </div>
    <input class="quick-add-input" type="text" placeholder="업무 내용 (Enter 저장 · Esc 취소)" maxlength="120">
    <div class="quick-add-row">
      ${isAutoMode ? `
        <div class="quick-add-assignee-auto" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:6px;font-size:13px;flex:1">
          <span style="font-weight:600;color:#111827">${escapeAttr(autoLabel)}</span>
          <button type="button" class="quick-add-assignee-change" style="font-size:11px;color:#3B82F6;background:none;border:none;cursor:pointer;text-decoration:underline;padding:0;margin-left:auto">변경</button>
        </div>
        <input type="hidden" class="quick-add-assignee" value="${escapeAttr(autoAssignee)}">
      ` : `
        <select class="quick-add-assignee" title="담당자">
          ${memberList.map(m => `<option value="${escapeAttr(m.id)}" ${m.id===autoAssignee?'selected':''}>${escapeAttr(m.name)} ${escapeAttr(m.role||'')}</option>`).join('')}
        </select>
      `}
      <select class="quick-add-priority" title="우선순위">
        <option value="낮음">낮음</option>
        <option value="보통" selected>보통</option>
        <option value="높음">높음</option>
      </select>
      <select class="quick-add-status" title="상태">
        <option value="예정" selected>예정</option>
        <option value="진행">진행</option>
        <option value="완료">완료</option>
      </select>
    </div>
    <div class="quick-add-foot">
      <button class="quick-add-detail" type="button">상세 편집…</button>
      <button class="quick-add-save btn-primary" type="button">저장</button>
    </div>
  `;
  document.body.appendChild(pop);
  quickAddEl = pop;

  // 위치 (anchor 셀 기준 — 우/하 오버플로 방지)
  const r = anchorEl.getBoundingClientRect();
  const popW = 320, popH = 200;
  let left = r.left + window.scrollX;
  if (left + popW > window.scrollX + window.innerWidth - 12) {
    left = window.scrollX + window.innerWidth - popW - 12;
  }
  let top = r.bottom + window.scrollY + 6;
  if (r.bottom + popH > window.innerHeight - 12) {
    top = r.top + window.scrollY - popH - 6;
  }
  pop.style.left = Math.max(12, left) + 'px';
  pop.style.top = Math.max(12, top) + 'px';

  const input = pop.querySelector('.quick-add-input');
  input.focus();

  pop.querySelector('.quick-add-close').onclick = closeQuickAdd;
  pop.querySelector('.quick-add-detail').onclick = () => {
    const who = pop.querySelector('.quick-add-assignee').value;
    const text = input.value.trim();
    closeQuickAdd();
    openTaskModal(ymd, who);
    if (text) {
      const c = document.getElementById('taskContent');
      if (c) c.value = text;
    }
  };
  pop.querySelector('.quick-add-save').onclick = saveQuick;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveQuick(); }
  });

  // 자동 모드 → 수동 select 전환 ("변경" 버튼)
  pop.querySelector('.quick-add-assignee-change')?.addEventListener('click', () => {
    const autoBox = pop.querySelector('.quick-add-assignee-auto');
    const hidden = pop.querySelector('input.quick-add-assignee');
    if (!autoBox || !hidden) return;
    const currentVal = hidden.value;
    const sel = document.createElement('select');
    sel.className = 'quick-add-assignee';
    sel.title = '담당자';
    sel.innerHTML = memberList.map(m =>
      `<option value="${escapeAttr(m.id)}" ${m.id===currentVal?'selected':''}>${escapeAttr(m.name)} ${escapeAttr(m.role||'')}</option>`
    ).join('');
    autoBox.replaceWith(sel);
    hidden.remove();
    sel.focus();
  });

  async function saveQuick() {
    const text = input.value.trim();
    if (!text) {
      input.style.borderColor = '#EF4444';
      setTimeout(()=>input.style.borderColor='',800);
      input.focus();
      return;
    }
    const who = pop.querySelector('.quick-add-assignee').value;
    const status = pop.querySelector('.quick-add-status').value;
    const priority = pop.querySelector('.quick-add-priority').value;
    const saveBtn = pop.querySelector('.quick-add-save');
    saveBtn.textContent='저장 중…'; saveBtn.disabled=true;
    try {
      const newTask = await createTask({date:ymd, who, task:text, status, priority, memo:''});
      teamTasks.push(newTask);
      closeQuickAdd();
      switchCalView(calView);
    } catch(err) {
      saveBtn.textContent='저장'; saveBtn.disabled=false;
      alert('저장 실패: ' + (err?.message || err));
    }
  }

  setTimeout(() => {
    document.addEventListener('mousedown', quickAddOutsideClick, true);
    document.addEventListener('keydown', quickAddKeydown);
  }, 0);
}

// ── 업무 입력 모달 ────────────────────────────────────────────

// 담당자 select option 동적 fill — loadTeamMembers() + 과거 task의 missing who 보조
function populateAssigneeOptions(currentValue) {
  const sel = document.getElementById('taskAssignee');
  if (!sel) return;
  const members = loadTeamMembers();
  const ids = new Set(members.map(m=>m.id));
  const extras = [];
  if (currentValue && !ids.has(currentValue)) extras.push({ id:currentValue, name:currentValue, role:'(과거)' });
  // (2026-05-13 찰스 요청) 하드코딩 legacy 자동 추가 제거 — 신규 업무 모달에서 항상 표시되던 박지현 (과거) 삭제.
  // 옛 task 편집 시 task.who 보존은 바로 위 currentValue 분기가 그대로 처리.
  const all = [...members, ...extras];
  sel.innerHTML = all.map(m => {
    const label = m.role ? `${m.name} (${m.role})` : m.name;
    return `<option value="${m.id}">${label}</option>`;
  }).join('');
  if (currentValue) sel.value = currentValue;
}

// 담당자 영역을 "자동 모드(라벨 + 변경 버튼)" vs "수동 모드(select)" 토글
function setAssigneeAutoMode(who) {
  const sel = document.getElementById('taskAssignee');
  const auto = document.getElementById('taskAssigneeAuto');
  const lbl = document.getElementById('taskAssigneeLabel');
  if (!sel || !auto || !lbl) return;
  if (who) {
    const m = loadTeamMembers().find(x => x.id === who);
    const display = m ? (m.role ? `${m.name} (${m.role})` : m.name) : who;
    lbl.textContent = display;
    auto.style.display = 'flex';
    sel.style.display = 'none';
    sel.value = who; // form 제출 시 사용
  } else {
    auto.style.display = 'none';
    sel.style.display = '';
  }
}

function openTaskModal(date, assignee) {
  editingTaskId = null;
  const modal = document.getElementById('taskModal');
  const el = id => document.getElementById(id);
  if (el('taskDate')) el('taskDate').value = date||toYMD(new Date());

  // 자동 담당자 결정: 인자 우선 → 현재 멤버 탭 (통합 아닐 때) → null(수동)
  const autoAssignee = assignee || (currentMemberTab !== '통합' ? currentMemberTab : null);
  populateAssigneeOptions(autoAssignee);
  setAssigneeAutoMode(autoAssignee);  // autoAssignee 있으면 자동 모드, 없으면 수동

  el('taskContent').value=''; el('taskMemo').value='';
  el('taskStatus').value='예정'; el('taskPriority').value='보통';
  el('saveTask').textContent='저장';
  const delBtn = el('deleteTask');
  if (delBtn) delBtn.style.display = 'none';
  if (modal) modal.style.display='flex';
  setTimeout(()=>el('taskContent')?.focus(),50);
}

function openTaskEditModal(task) {
  editingTaskId = task.id;
  const el = id => document.getElementById(id);
  el('taskDate').value=task.date;
  populateAssigneeOptions(task.who);
  // 편집 모드: task.who로 자동 표시. 사용자가 "변경" 누르면 수동 전환 가능
  setAssigneeAutoMode(task.who);
  el('taskContent').value=task.task;
  el('taskStatus').value=task.status;
  el('taskPriority').value=task.priority;
  el('taskMemo').value=task.memo||'';
  el('saveTask').textContent='수정';
  const delBtn = el('deleteTask');
  if (delBtn) delBtn.style.display = 'inline-block';
  document.getElementById('taskModal').style.display='flex';
}

function closeTaskModal() {
  const modal = document.getElementById('taskModal');
  if (modal) modal.style.display='none';
  const delBtn = document.getElementById('deleteTask');
  if (delBtn) delBtn.style.display = 'none';
  // 자동 모드 초기화
  const auto = document.getElementById('taskAssigneeAuto');
  const sel = document.getElementById('taskAssignee');
  if (auto) auto.style.display = 'none';
  if (sel) sel.style.display = '';
  editingTaskId=null;
}

async function handleDeleteTaskFromModal() {
  if (!editingTaskId) return;
  if (!confirm('이 업무를 삭제하시겠습니까?')) return;
  const id = editingTaskId;
  const btn = document.getElementById('deleteTask');
  if (btn) { btn.disabled = true; btn.textContent = '삭제 중...'; }
  try {
    await deleteTask(id);
    closeTaskModal();
    switchCalView(calView);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑 삭제'; }
  }
}

async function handleSaveTask() {
  const el = id => document.getElementById(id);
  const date=el('taskDate')?.value, who=el('taskAssignee')?.value,
        task=el('taskContent')?.value.trim(), status=el('taskStatus')?.value,
        priority=el('taskPriority')?.value, memo=el('taskMemo')?.value.trim();
  if (!date||!who||!task) { alert('날짜, 담당자, 업무 내용을 입력하세요'); return; }
  const btn=el('saveTask');
  if (btn) { btn.textContent='저장 중...'; btn.disabled=true; }
  try {
    if (editingTaskId) {
      await updateTask(editingTaskId,{task,status,priority,memo});
      const idx=teamTasks.findIndex(t=>t.id===editingTaskId);
      if (idx>=0) Object.assign(teamTasks[idx],{task,status,priority,memo});
    } else {
      const newTask = await createTask({date,who,task,status,priority,memo});
      teamTasks.push(newTask);
    }
    closeTaskModal();
    switchCalView(calView);
    // 통합 탭 좌측 우선순위·미완료 패널 즉시 반영 (2026-05-13 찰스 요청)
    if (currentMemberTab === '통합' && typeof renderIntegratedView === 'function') {
      renderIntegratedView();
    }
  } finally {
    if (btn) { btn.textContent=editingTaskId?'수정':'저장'; btn.disabled=false; }
  }
}

// ── 회의록 ───────────────────────────────────────────────────
async function renderMinutesSection() {
  const minutes = await fetchMinutes();
  renderMinutesList(minutes);
  if (minutes.length) showMinutesDoc(minutes[0]);
}

function statusBadgeHtml(status) {
  const map = {
    '진행': { icon:'🟡', label:'진행', cls:'mb-progress' },
    '완료': { icon:'🟢', label:'완료', cls:'mb-done' },
    '보류': { icon:'⚪', label:'보류', cls:'mb-hold' },
  };
  const s = map[status] || map['진행'];
  return `<span class="minutes-badge ${s.cls}" title="${s.label}">${s.icon} ${s.label}</span>`;
}

function renderMinutesList(minutes) {
  const list = document.getElementById('minutesList');
  if (!list) return;
  if (!minutes.length) { list.innerHTML='<div class="empty-state">회의록이 없습니다.\n+ 새 회의록으로 시작하세요.</div>'; return; }
  const fragment = document.createDocumentFragment();
  minutes.forEach((m,idx)=>{
    const item=document.createElement('div');
    item.className=`minutes-list-item${idx===0?' active':''}`;
    item.dataset.minuteId = m.id;

    const headRow=document.createElement('div');
    headRow.className='minutes-item-headrow';
    const dateEl=document.createElement('div'); dateEl.className='minutes-item-date'; dateEl.textContent=m.date;
    headRow.innerHTML = '';
    headRow.appendChild(dateEl);
    headRow.insertAdjacentHTML('beforeend', statusBadgeHtml(autoStatusFromStates(m)));

    const titleEl=document.createElement('div'); titleEl.className='minutes-item-title'; titleEl.textContent=m.title;
    const preview=document.createElement('div'); preview.className='minutes-item-preview';
    const c = dirCount(m);
    if (c.total) {
      preview.innerHTML = `지시 <span class="minutes-counter">${c.done}/${c.total}</span>${c.done===c.total?' · 마무리됨':''}`;
    } else {
      preview.textContent = '지시사항 없음';
    }
    item.appendChild(headRow); item.appendChild(titleEl); item.appendChild(preview);
    item.addEventListener('click',()=>{
      document.querySelectorAll('.minutes-list-item').forEach(el=>el.classList.remove('active'));
      item.classList.add('active'); showMinutesDoc(m);
    });
    fragment.appendChild(item);
  });
  list.replaceChildren(fragment);
}

function showMinutesDoc(m) {
  const viewer=document.getElementById('minutesViewer');
  if (!viewer) return;
  viewer.innerHTML='';

  // 헤더
  const headerWrap = document.createElement('div');
  headerWrap.className = 'minutes-doc-header';
  const dateEl=document.createElement('div'); dateEl.className='minutes-doc-date'; dateEl.textContent=m.date;
  headerWrap.appendChild(dateEl);
  const status = autoStatusFromStates(m);
  headerWrap.insertAdjacentHTML('beforeend', statusBadgeHtml(status));
  const c0 = dirCount(m);
  if (c0.total) {
    const counter = document.createElement('span');
    counter.className = 'minutes-doc-counter';
    counter.innerHTML = `지시사항 <strong>${c0.done}/${c0.total}</strong>${c0.done===c0.total?' · 마무리됨':''}`;
    headerWrap.appendChild(counter);
  }
  // 보류 토글 / 다시 진행
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'minutes-status-toggle';
  toggleBtn.textContent = status === '보류' ? '↻ 다시 진행' : '⏸ 보류';
  toggleBtn.addEventListener('click', async () => {
    const newStatus = status === '보류' ? autoStatusFromStates({...m, status: null}) : '보류';
    m.status = newStatus;
    await patchMinute(m.id, { status: newStatus }, m._origin);
    showMinutesDoc(m);
    refreshMinutesListBadge(m);
  });
  headerWrap.appendChild(toggleBtn);

  // 2026-05-26 #OB-MIN-EDIT-001 — 수정/삭제 버튼
  const editBtn = document.createElement('button');
  editBtn.className = 'minutes-status-toggle';
  editBtn.style.marginLeft = '6px';
  editBtn.textContent = '✏️ 수정';
  editBtn.addEventListener('click', () => openMinutesModalForEdit(m));
  headerWrap.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'minutes-status-toggle';
  delBtn.style.marginLeft = '6px';
  delBtn.style.color = '#dc2626';
  delBtn.textContent = '🗑️ 삭제';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`회의록 "${m.title}" 삭제할까요?\n(되돌릴 수 없습니다)`)) return;
    delBtn.disabled = true;
    delBtn.textContent = '삭제 중…';
    await deleteMinutes(m.id);
    renderMinutesSection();
  });
  headerWrap.appendChild(delBtn);

  viewer.appendChild(headerWrap);

  const titleEl=document.createElement('div'); titleEl.className='minutes-doc-title'; titleEl.textContent=m.title;
  viewer.appendChild(titleEl);

  if (m.attendees) {
    const att=document.createElement('div'); att.className='minutes-doc-attendees';
    att.textContent=`👥 참석: ${m.attendees}`;
    viewer.appendChild(att);
  }

  // 📌 요약 박스 (있을 때만)
  if (m.summary && m.summary.trim()) {
    const sb = document.createElement('div'); sb.className = 'minutes-summary-block';
    const st = document.createElement('div'); st.className = 'minutes-summary-title'; st.textContent = '📌 요약';
    const sp = document.createElement('p'); sp.className = 'minutes-summary-text'; sp.textContent = m.summary.trim();
    sb.appendChild(st); sb.appendChild(sp); viewer.appendChild(sb);
  }

  const directives=m.directives?m.directives.trim().split('\n').filter(Boolean):[];
  if (directives.length) {
    const block=document.createElement('div'); block.className='minutes-directive-block';
    const bt=document.createElement('div'); bt.className='minutes-directive-title'; bt.textContent='찰스 지시사항 (판단 기준)';
    block.appendChild(bt);

    // directive_states 보장 (길이 맞춤)
    if (!Array.isArray(m.directive_states)) m.directive_states = [];
    while (m.directive_states.length < directives.length) m.directive_states.push(false);

    directives.forEach((d,i)=>{
      const row=document.createElement('div');
      row.className='directive-item' + (m.directive_states[i] ? ' done' : '');
      const cb = document.createElement('div');
      cb.className = 'directive-checkbox' + (m.directive_states[i] ? ' checked' : '');
      cb.setAttribute('role', 'checkbox');
      cb.setAttribute('aria-checked', m.directive_states[i] ? 'true' : 'false');
      cb.textContent = m.directive_states[i] ? '✓' : '';
      cb.addEventListener('click', async () => {
        m.directive_states[i] = !m.directive_states[i];
        const newStatus = autoStatusFromStates({...m, status: m.status === '보류' ? '보류' : null});
        m.status = newStatus;
        // optimistic UI
        showMinutesDoc(m);
        refreshMinutesListBadge(m);
        // persist
        await patchMinute(m.id, {
          directive_states: m.directive_states,
          status: newStatus,
        }, m._origin);
      });

      const text=document.createElement('span');
      text.className = 'directive-text';
      text.textContent=d.replace(/^\d+\.\s*/,'');
      row.appendChild(cb); row.appendChild(text); block.appendChild(row);
    });
    viewer.appendChild(block);
  }

  if (m.content) {
    const cb=document.createElement('div'); cb.className='minutes-content-block';
    const h3=document.createElement('h3'); h3.textContent='논의 내용';
    cb.appendChild(h3);
    renderDiscussionContent(cb, m.content);
    viewer.appendChild(cb);
  }
}

// 논의 내용을 "숫자. " 패턴 기반으로 항목 분리해서 가독성 ↑
// XSS 안전: textContent만 사용, innerHTML 금지
function renderDiscussionContent(container, raw) {
  const text = String(raw || '').trim();
  if (!text) return;

  // 1) "숫자. " 직전에 줄바꿈 강제 삽입 (한 덩어리 텍스트 대응)
  //    이미 줄바꿈이 있으면 그대로
  const normalized = text.replace(/([^\n])\s*(?=\d+\.\s)/g, '$1\n');

  // 2) "숫자. " 시작 패턴을 기준으로 split
  const parts = normalized.split(/\n(?=\d+\.\s)/);

  parts.forEach(part => {
    const piece = part.trim();
    if (!piece) return;

    const m = piece.match(/^(\d+)\.\s+([\s\S]*)$/);
    const row = document.createElement('div');
    if (m) {
      row.className = 'discussion-item';
      const num = document.createElement('span');
      num.className = 'discussion-num';
      num.textContent = `${m[1]}.`;
      const body = document.createElement('span');
      body.className = 'discussion-text';
      body.textContent = m[2].trim();
      row.appendChild(num);
      row.appendChild(body);
    } else {
      row.className = 'discussion-intro';
      row.textContent = piece;
    }
    container.appendChild(row);
  });
}

// 목록 카드의 배지·카운터만 갱신 (활성 상태 유지)
function refreshMinutesListBadge(m) {
  const item = document.querySelector(`.minutes-list-item[data-minute-id="${CSS.escape(String(m.id))}"]`);
  if (!item) return;
  const c = dirCount(m);
  const status = autoStatusFromStates(m);
  // 헤드 row 갱신
  const headRow = item.querySelector('.minutes-item-headrow');
  if (headRow) {
    const dateText = headRow.querySelector('.minutes-item-date')?.textContent || m.date;
    headRow.innerHTML = `<div class="minutes-item-date">${escapeAttr(dateText)}</div>${statusBadgeHtml(status)}`;
  }
  const preview = item.querySelector('.minutes-item-preview');
  if (preview) {
    if (c.total) {
      preview.innerHTML = `지시 <span class="minutes-counter">${c.done}/${c.total}</span>${c.done===c.total?' · 마무리됨':''}`;
    } else {
      preview.textContent = '지시사항 없음';
    }
  }
}

// ── KPI ──────────────────────────────────────────────────────
async function renderKpiSection() {
  const minutes = await fetchMinutes();
  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate()-(today.getDay()===0?6:today.getDay()-1));
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate()+4);
  const weekTasks = teamTasks.filter(t=>t.date>=toYMD(weekStart)&&t.date<=toYMD(weekEnd));
  const total=weekTasks.length, done=weekTasks.filter(t=>t.status==='완료').length;
  const setT=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  setT('kpi-completion',total?`${Math.round(done/total*100)}%`:'—');
  setT('kpi-deadline','—');
  setT('kpi-blockers',`${weekTasks.filter(t=>t.priority==='높음'&&t.status!=='완료').length}건`);
  setT('kpi-logs','—');
  const tbody=document.getElementById('memberKpiTable');
  if (tbody) {
    const fragment=document.createDocumentFragment();
    TEAM_MEMBERS.forEach(member=>{
      const mT=weekTasks.filter(t=>t.who===member.id||t.who===member.name);
      const mDone=mT.filter(t=>t.status==='완료').length;
      const mc=mT.length?Math.round(mDone/mT.length*100):null;
      const tr=document.createElement('tr');
      [{text:`${member.name} ${member.role}`,align:'left'},
       {text:mc!==null?`${mc}%`:'—',cls:mc===null?'':mc>=80?'td-up':mc<50?'td-down':''},
       {text:'—'},{text:mT.filter(t=>t.priority==='높음'&&t.status!=='완료').length+'건'},
       {text:'—'},{text:mc!==null?`${Math.round(mc*0.7+30)}점`:'—',cls:mc>=80?'td-up':mc<50?'td-down':''},
       {text:mT.find(t=>t.priority==='높음')?.task||mT[0]?.task||'—',align:'left',maxW:true}
      ].forEach(c=>{
        const td=document.createElement('td');
        td.textContent=c.text;
        if(c.cls) td.className=c.cls;
        if(c.align) td.style.textAlign=c.align;
        if(c.maxW) td.style.cssText='text-align:left;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    });
    tbody.replaceChildren(fragment);
  }
  const dirList=document.getElementById('directivesList');
  if (dirList) {
    const latest=minutes[0];
    if (!latest?.directives) { dirList.innerHTML='<div class="empty-state">회의록이 없습니다.</div>'; }
    else {
      const fragment=document.createDocumentFragment();
      latest.directives.trim().split('\n').filter(Boolean).forEach((d,i)=>{
        const row=document.createElement('div'); row.className='directive-row';
        const st=document.createElement('div'); st.className='directive-status todo'; st.textContent='?';
        const body=document.createElement('div');
        const text=document.createElement('div'); text.style.fontSize='13px'; text.textContent=d.replace(/^\d+\.\s*/,'');
        const who=document.createElement('div'); who.className='directive-who'; who.textContent=`지시 ${i+1} — ${latest.date}`;
        body.appendChild(text); body.appendChild(who); row.appendChild(st); row.appendChild(body);
        fragment.appendChild(row);
      });
      dirList.replaceChildren(fragment);
    }
  }
}

// ── 섹션 스위칭 ──────────────────────────────────────────────
function switchSection(section) {
  document.querySelectorAll('.section-content').forEach(el=>el.style.display='none');
  document.querySelectorAll('.section-btn').forEach(el=>el.classList.remove('active'));
  document.getElementById(`section-${section}`).style.display='';
  document.querySelector(`.section-btn[data-section="${section}"]`).classList.add('active');
  const dr=document.getElementById('dateRangeBtns');
  if(dr) dr.style.display=section==='sales'?'':'none';
  if(section==='team')    renderTeamSection();
  if(section==='minutes') renderMinutesSection();
  if(section==='kpi')     renderKpiSection();
}

// 2026-05-26 #OB-MIN-EDIT-001 — 수정 모드 추적 상태
let editingMinuteId = null;

function openMinutesModalForEdit(m) {
  editingMinuteId = m.id;
  document.querySelector('#minutesModal .modal-title').textContent = '회의록 수정';
  document.getElementById('saveMinutes').textContent = '수정';
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  setVal('minutesDate', m.date || '');
  setVal('minutesTitle', m.title || '');
  setVal('minutesAttendees', m.attendees || '');
  setVal('minutesSummary', m.summary || '');
  setVal('minutesDirectives', m.directives || '');
  setVal('minutesContent', m.content || '');
  document.getElementById('minutesModal').style.display = 'flex';
  setTimeout(() => document.getElementById('minutesTitle')?.focus(), 60);
}

// ── 이벤트 바인딩 ────────────────────────────────────────────
function bindMinutesEvents() {
  document.getElementById('addMinutesBtn')?.addEventListener('click',()=>{
    editingMinuteId = null;
    document.querySelector('#minutesModal .modal-title').textContent = '새 회의록 작성';
    document.getElementById('saveMinutes').textContent = '저장';
    const dateEl = document.getElementById('minutesDate');
    if (dateEl && !dateEl.value) dateEl.value = toYMD(new Date());
    document.getElementById('minutesModal').style.display='flex';
    setTimeout(()=>document.getElementById('minutesTitle')?.focus(), 60);
  });
  const closeModal=()=>{
    document.getElementById('minutesModal').style.display='none';
    editingMinuteId = null;
    ['minutesTitle','minutesAttendees','minutesSummary','minutesDirectives','minutesContent'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  };
  document.getElementById('closeMinutesModal')?.addEventListener('click',closeModal);
  document.getElementById('cancelMinutes')?.addEventListener('click',closeModal);
  document.getElementById('minutesModal')?.addEventListener('click',e=>{ if(e.target===document.getElementById('minutesModal')) closeModal(); });
  document.getElementById('saveMinutes')?.addEventListener('click',async()=>{
    const title=document.getElementById('minutesTitle')?.value.trim();
    if (!title) { alert('회의 제목을 입력하세요'); return; }
    const saveBtn = document.getElementById('saveMinutes');
    const isEdit = !!editingMinuteId;
    saveBtn.disabled = true;
    saveBtn.textContent = isEdit ? '수정 중…' : '저장 중…';
    const dateInput = document.getElementById('minutesDate')?.value;
    const meetingDate = dateInput || toYMD(new Date());
    const payload = { date: meetingDate, title,
      attendees: document.getElementById('minutesAttendees')?.value.trim() || '',
      summary:   document.getElementById('minutesSummary')?.value.trim()    || '',
      directives:document.getElementById('minutesDirectives')?.value.trim() || '',
      content:   document.getElementById('minutesContent')?.value.trim()    || '' };

    if (isEdit) {
      await updateMinutes(editingMinuteId, payload);
      saveBtn.disabled = false;
      saveBtn.textContent = '수정';
      closeModal();
      renderMinutesSection();
    } else {
      const result = await createMinutes(payload);
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
      closeModal();
      renderMinutesSection();
      if (result.autoCount > 0) {
        showAutoTasksToast(result.autoCount, result.autoTasks);
        loadTeamTasks();
      }
    }
  });
}

function bindSectionEvents() {
  document.querySelectorAll('.section-btn').forEach(btn=>btn.addEventListener('click',()=>switchSection(btn.dataset.section)));

  // 월/주 네비게이션 (현재 view에 따라 ±1개월 또는 ±7일)
  document.getElementById('calPrev')?.addEventListener('click',()=>{
    if (calView === 'week') {
      const base = calSelectedDate || new Date();
      calSelectedDate = new Date(base); calSelectedDate.setDate(base.getDate()-7);
      renderWeekCalendar();
    } else {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()-1, 1);
      syncPlanningToCalendar(); // 2026-05-26 #OB-MW-001 — 월간/주간 섹션 동기화
      renderMonthCalendar();
    }
  });
  document.getElementById('calNext')?.addEventListener('click',()=>{
    if (calView === 'week') {
      const base = calSelectedDate || new Date();
      calSelectedDate = new Date(base); calSelectedDate.setDate(base.getDate()+7);
      renderWeekCalendar();
    } else {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()+1, 1);
      syncPlanningToCalendar(); // 2026-05-26 #OB-MW-001 — 월간/주간 섹션 동기화
      renderMonthCalendar();
    }
  });
  document.getElementById('calToday')?.addEventListener('click',()=>{
    calMonth = new Date(); calMonth.setDate(1);
    calSelectedDate = new Date();
    syncPlanningToCalendar(); // 2026-05-26 #OB-MW-001 — 월간/주간 섹션 동기화
    switchCalView(calView);
  });
  document.getElementById('refreshTeamBtn')?.addEventListener('click',renderTeamSection);

  // 통합 뷰 캘린더 네비
  document.getElementById('intCalPrev')?.addEventListener('click', () => {
    if (!intCalMonth) intCalMonth = new Date();
    intCalMonth = new Date(intCalMonth.getFullYear(), intCalMonth.getMonth()-1, 1);
    renderIntegratedView();
  });
  document.getElementById('intCalNext')?.addEventListener('click', () => {
    if (!intCalMonth) intCalMonth = new Date();
    intCalMonth = new Date(intCalMonth.getFullYear(), intCalMonth.getMonth()+1, 1);
    renderIntegratedView();
  });
  document.getElementById('intCalToday')?.addEventListener('click', () => {
    intCalMonth = new Date(); intCalMonth.setDate(1);
    renderIntegratedView();
  });
  document.getElementById('intShowArchive')?.addEventListener('change', e => {
    intShowArchive = e.target.checked;
    renderIntegratedView();
  });

  // 팀원 탭 전환
  document.querySelectorAll('.member-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMemberTab(btn.dataset.member));
  });

  document.querySelectorAll('[data-calview]').forEach(btn=>btn.addEventListener('click',()=>{
    if (btn.dataset.calview === 'week' && !calSelectedDate) calSelectedDate = new Date();
    switchCalView(btn.dataset.calview);
  }));
  document.querySelectorAll('.kpi-period-btns .range-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.kpi-period-btns .range-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); renderKpiSection();
  }));

  // 업무 모달
  document.getElementById('closeTaskModal')?.addEventListener('click',closeTaskModal);
  document.getElementById('cancelTask')?.addEventListener('click',closeTaskModal);
  document.getElementById('taskModal')?.addEventListener('click',e=>{ if(e.target===document.getElementById('taskModal')) closeTaskModal(); });
  document.getElementById('saveTask')?.addEventListener('click',handleSaveTask);
  document.getElementById('deleteTask')?.addEventListener('click', handleDeleteTaskFromModal);
  // 담당자 자동 모드의 "변경" 버튼 → 수동 모드(select)로 전환
  document.getElementById('taskAssigneeChange')?.addEventListener('click', () => {
    const auto = document.getElementById('taskAssigneeAuto');
    const sel = document.getElementById('taskAssignee');
    if (auto) auto.style.display = 'none';
    if (sel) { sel.style.display = ''; sel.focus(); }
  });
  document.getElementById('taskContent')?.addEventListener('keydown',e=>{ if(e.key==='Enter') handleSaveTask(); });

  // CSV 백업 다운로드 (수동 즉시 백업)
  document.getElementById('csvDownloadBtn')?.addEventListener('click', () => {
    if (!teamTasks.length) { alert('내려받을 데이터가 없습니다.'); return; }
    const rows = [['date','assignee','task','status','priority','memo','origin']];
    teamTasks.forEach(t => {
      rows.push([t.date, t.who, t.task, t.status, t.priority, t.memo||'', t._origin||'db']);
    });
    const csv = rows.map(r => r.map(c => {
      const s = String(c||'').replace(/"/g,'""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    }).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oneboard-tasks-${toYMD(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  bindMinutesEvents();
}

let legacyLifecycleActive = false;
let legacyHandlersBound = false;
let legacyDomReady = document.readyState !== 'loading';

function bindLegacyHandlersOnce() {
  if (legacyHandlersBound) return;
  legacyHandlersBound = true;
  bindEvents();
  bindSectionEvents();
  bindNotifEvents();
  renderMemberTabs();
  bindMonthlyWeeklyEvents();
  bindManualEvents();
  bindSettingsEvents();
}

async function startAuthenticatedLifecycle() {
  if (legacyLifecycleActive) return;
  legacyLifecycleActive = true;
  legacyLifecycleController = new AbortController();
  bindLegacyHandlersOnce();
  calMonth = (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); })();
  startNotificationPolling();
  await init();
}

function stopAuthenticatedLifecycle() {
  if (!legacyLifecycleActive && notificationPollTimer === null) return;
  legacyLifecycleActive = false;
  legacyLifecycleController?.abort();
  legacyLifecycleController = null;
  stopNotificationPolling();
}

window.addEventListener('oneboard:auth-changed', ({ detail } = {}) => {
  if (detail?.user && legacyDomReady) void startAuthenticatedLifecycle();
  else stopAuthenticatedLifecycle();
});

// ═══════════════════════════════════════════════════════════════════════
// v2 신규 기능: 팀원 탭 동적 / 월간·주간 패널 / 운영매뉴얼 / 설정
// ═══════════════════════════════════════════════════════════════════════

// ── 팀원 관리 (localStorage) ──────────────────────────────────
function loadTeamMembers() {
  try {
    const saved = JSON.parse(localStorage.getItem('ob_team_members') || 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return TEAM_MEMBERS.map(m => ({...m})); // 기본값
}
function saveTeamMembers(list) {
  localStorage.setItem('ob_team_members', JSON.stringify(list));
}
function getActiveMembers() {
  return loadTeamMembers();
}
// TEAM_MEMBERS 배열을 동기화 (기존 렌더 함수들이 사용)
function syncTeamMembersGlobal() {
  const list = loadTeamMembers();
  TEAM_MEMBERS.length = 0;
  list.forEach(m => TEAM_MEMBERS.push(m));
}

const MEMBER_COLORS = [
  { color:'#3B82F6', bg:'#EFF6FF' },
  { color:'#10B981', bg:'#F0FDF4' },
  { color:'#F59E0B', bg:'#FFFBEB' },
  { color:'#8B5CF6', bg:'#F5F3FF' },
  { color:'#EF4444', bg:'#FEF2F2' },
  { color:'#EC4899', bg:'#FDF2F8' },
  { color:'#14B8A6', bg:'#F0FDFA' },
];

function renderMemberTabs() {
  syncTeamMembersGlobal();
  const container = document.getElementById('memberTabs');
  if (!container) return;
  container.innerHTML = '';
  // 통합 탭
  const int = document.createElement('button');
  int.className = 'member-tab-btn' + (currentMemberTab==='통합'?' active':'');
  int.dataset.member = '통합';
  int.textContent = '🔗 통합';
  int.addEventListener('click', () => switchMemberTab('통합'));
  container.appendChild(int);
  // 팀원 탭
  const members = loadTeamMembers();
  members.forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'member-tab-btn' + (currentMemberTab===m.id?' active':'');
    btn.dataset.member = m.id;
    const label = document.createElement('span');
    label.textContent = `${m.name}${m.role?' '+m.role:''}`;
    btn.appendChild(label);
    const del = document.createElement('span');
    del.className = 'member-tab-del';
    del.textContent = '✕';
    del.title = '삭제';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`"${m.name} ${m.role||''}" 탭을 삭제할까요?\n(해당 팀원의 월간/주간 로컬 데이터도 함께 삭제됩니다. 서버 DB 데이터는 보존)`)) return;
      const next = loadTeamMembers().filter(x => x.id !== m.id);
      saveTeamMembers(next);
      // 월간·주간 — 로컬 잔여 + 메모리 캐시 정리 (서버 DB 데이터는 보존)
      const mo = loadMonthlyLocalAll(); delete mo[m.id]; saveMonthlyLocalAll(mo);
      const wk = loadWeeklyLocalAll(); delete wk[m.id]; saveWeeklyLocalAll(wk);
      delete _monthlyCache[m.id]; delete _weeklyCache[m.id];
      if (currentMemberTab === m.id) currentMemberTab = '통합';
      renderMemberTabs();
      renderTeamMgmtList();
      switchMemberTab(currentMemberTab);
    });
    btn.appendChild(del);
    btn.addEventListener('click', () => switchMemberTab(m.id));
    container.appendChild(btn);
  });
  // + 탭 추가
  const add = document.createElement('button');
  add.className = 'member-tab-add';
  add.textContent = '+ 탭 추가';
  add.addEventListener('click', () => {
    const name = prompt('새 팀원/팀 이름:');
    if (!name || !name.trim()) return;
    const role = prompt('직책 (예: 팀장, 과장, 팀) — 생략 가능:') || '';
    addTeamMember(name.trim(), role.trim());
  });
  container.appendChild(add);
}

function addTeamMember(name, role) {
  const list = loadTeamMembers();
  const id = name;
  if (list.some(m => m.id === id)) { alert('이미 존재하는 이름입니다.'); return; }
  const col = MEMBER_COLORS[list.length % MEMBER_COLORS.length];
  list.push({ id, name, role, ...col });
  saveTeamMembers(list);
  renderMemberTabs();
  renderTeamMgmtList();
}

// ── 월간 주관업무 ────────────────────────────────────────────
// 2026-05-15: localStorage → 서버 DB(/team/monthly, /team/weekly) 마이그레이션.
// 팀 캘린더(/team/tasks)와 동일하게 workspace_id 스코프 — 팀원 전체 공유.
let monthlyViewYM = ymNow();
let weeklyViewYM = ymNow();

// 2026-05-26 #OB-MW-001 — 팀 업무 캘린더 month picker ↔ 월간/주간 섹션 동기화
function syncPlanningToCalendar() {
  if (typeof calMonth === 'undefined') return;
  const newYM = `${calMonth.getFullYear()}-${String(calMonth.getMonth()+1).padStart(2,'0')}`;
  let changed = false;
  if (monthlyViewYM !== newYM) { monthlyViewYM = newYM; changed = true; }
  if (weeklyViewYM  !== newYM) { weeklyViewYM  = newYM; changed = true; }
  if (changed && typeof currentMemberTab !== 'undefined' && currentMemberTab !== '통합') {
    renderMonthlyPanel(currentMemberTab);
    renderWeeklyPanel(currentMemberTab);
  }
}

function ymNow() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function shiftYM(ym, delta) {
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// 캐시·모드: 멤버·월 단위. fetchMonthly/fetchWeekly가 첫 호출 시 채움.
const _monthlyCache = {};   // { memberId: { ym: rows[] } }
const _weeklyCache  = {};   // { memberId: { ym: { slot: items[] } } }
const _monthlyMode  = {};   // { 'memberId|ym': 'db' | 'local' }
const _weeklyMode   = {};
const mkPlanKey = (memberId, ym) => `${memberId}|${ym}`;

// localStorage fallback — 오프라인 / 백엔드 실패 시
function loadMonthlyLocalAll() {
  try { return JSON.parse(localStorage.getItem('ob_team_monthly') || '{}'); } catch { return {}; }
}
function saveMonthlyLocalAll(data) {
  try { localStorage.setItem('ob_team_monthly', JSON.stringify(data)); } catch {}
}
function getMonthlyLocal(memberId, ym) {
  const all = loadMonthlyLocalAll();
  return (all[memberId]?.[ym]) || [];
}
function setMonthlyLocal(memberId, ym, rows) {
  const all = loadMonthlyLocalAll();
  if (!all[memberId]) all[memberId] = {};
  all[memberId][ym] = rows;
  saveMonthlyLocalAll(all);
}

// 2026-05-26 #OB-MW-001 — 단순 CSV 파서 (GViz CSV 응답용)
function parseSimpleCSV(text) {
  const lines = text.trim().split('\n').filter(l => l);
  return lines.slice(1).map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  });
}

// 2026-05-26 #OB-MW-001 — 월간 주관업무: oneboard-server → Google Sheets(`monthly_tasks` 시트) 전환
async function fetchMonthly(memberId, ym) {
  if (_monthlyCache[memberId]?.[ym]) return _monthlyCache[memberId][ym];
  const key = mkPlanKey(memberId, ym);
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_TEAM_TASKS_ID}/gviz/tq?tqx=out:csv&sheet=monthly_tasks`;
    const res = await lifecycleFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const all = parseSimpleCSV(csv);
    // 컬럼: member | ym | task | platform | automation | sort_order | id
    const rows = all
      .filter(r => r[0] === memberId && r[1] === ym)
      .map(r => ({
        id: r[6] || `local-m-${Date.now()}-${Math.random()}`,
        task: r[2] || '', platform: r[3] || '', automation: r[4] || '',
        sort_order: parseInt(r[5], 10) || 0,
      }))
      .sort((a, b) => a.sort_order - b.sort_order);
    (_monthlyCache[memberId] ??= {})[ym] = rows;
    _monthlyMode[key] = 'sheets';
    return rows;
  } catch {
    const rows = getMonthlyLocal(memberId, ym).map((r, i) => ({
      id: r.id || `local-m-${memberId}-${ym}-${i}-${Date.now()}`,
      task: r.task||'', platform: r.platform||'', automation: r.automation||'', sort_order: i,
    }));
    (_monthlyCache[memberId] ??= {})[ym] = rows;
    _monthlyMode[key] = 'local';
    return rows;
  }
}

function getMonthlyFor(memberId, ym) { return _monthlyCache[memberId]?.[ym] || []; }

// 2026-05-26 #OB-MW-001 — Apps Script 양방향 sync 패턴 (team_tasks와 동일)
async function addMonthlyRow(memberId, ym) {
  const key = mkPlanKey(memberId, ym);
  const rows = _monthlyCache[memberId]?.[ym] || [];
  const id = `m-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const payload = { id, task: '', platform: '', automation: '', sort_order: rows.length };
  rows.push(payload);
  (_monthlyCache[memberId] ??= {})[ym] = rows;
  const sync = await syncToSheet('monthly_create', {
    member: memberId, ym, task: '', platform: '', automation: '', sort_order: rows.length - 1, id,
  });
  if (sync.ok) { _monthlyMode[key] = 'sheets'; }
  else { _monthlyMode[key] = 'local'; setMonthlyLocal(memberId, ym, rows); }
}

async function updateMonthlyRow(memberId, ym, idx, field, value) {
  const key = mkPlanKey(memberId, ym);
  const rows = _monthlyCache[memberId]?.[ym] || [];
  const row = rows[idx];
  if (!row) return;
  row[field] = value;
  const sync = await syncToSheet('monthly_update', { id: row.id, patch: { [field]: value } });
  if (sync.ok) { _monthlyMode[key] = 'sheets'; }
  else { _monthlyMode[key] = 'local'; setMonthlyLocal(memberId, ym, rows); }
}

async function deleteMonthlyRow(memberId, ym, idx) {
  const key = mkPlanKey(memberId, ym);
  const rows = _monthlyCache[memberId]?.[ym] || [];
  const row = rows[idx];
  if (!row) return;
  const sync = await syncToSheet('monthly_delete', { id: row.id });
  rows.splice(idx, 1);
  if (sync.ok) { _monthlyMode[key] = 'sheets'; }
  else { _monthlyMode[key] = 'local'; setMonthlyLocal(memberId, ym, rows); }
}

async function renderMonthlyPanel(memberId) {
  const block = document.getElementById('monthlyBlock');
  if (!block) return;
  const label = document.getElementById('monthlyMonthLabel');
  if (label) label.textContent = monthlyViewYM;
  const body = document.getElementById('monthlyBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="4" class="tier-empty">로딩 중…</td></tr>';
  const rows = await fetchMonthly(memberId, monthlyViewYM);
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="tier-empty">아직 업무가 없습니다. [+ 행 추가]로 시작하세요.</td></tr>';
    return;
  }
  rows.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="tier-input" data-f="task" value="${escapeAttr(r.task||'')}" placeholder="업무 내용"></td>
      <td><input class="tier-input" data-f="platform" value="${escapeAttr(r.platform||'')}" placeholder="플랫폼/툴"></td>
      <td><input class="tier-input" data-f="automation" value="${escapeAttr(r.automation||'')}" placeholder="자동화 방안"></td>
      <td><button class="tier-del" title="삭제">✕</button></td>
    `;
    tr.querySelectorAll('.tier-input').forEach(inp => {
      inp.addEventListener('change', () => {
        updateMonthlyRow(memberId, monthlyViewYM, idx, inp.dataset.f, inp.value);
      });
    });
    tr.querySelector('.tier-del').addEventListener('click', async () => {
      await deleteMonthlyRow(memberId, monthlyViewYM, idx);
      renderMonthlyPanel(memberId);
    });
    body.appendChild(tr);
  });
}

function escapeAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── 주간 업무 (1주차~5주차 + 상시) ──────────────────────────
const WEEK_SLOTS = ['1주차','2주차','3주차','4주차','5주차','상시'];
const WEEKLY_VISIBLE = 5; // 2026-05-29 #OB-WK-MORE-001 — 컬럼당 기본 노출 항목 수 (나머지는 더보기)

function loadWeeklyLocalAll() {
  try { return JSON.parse(localStorage.getItem('ob_team_weekly') || '{}'); } catch { return {}; }
}
function saveWeeklyLocalAll(data) {
  try { localStorage.setItem('ob_team_weekly', JSON.stringify(data)); } catch {}
}
function getWeeklyLocal(memberId, ym) {
  const all = loadWeeklyLocalAll();
  const m = all[memberId]?.[ym];
  if (m) return m;
  return Object.fromEntries(WEEK_SLOTS.map(s => [s, []]));
}
function setWeeklyLocal(memberId, ym, data) {
  const all = loadWeeklyLocalAll();
  if (!all[memberId]) all[memberId] = {};
  all[memberId][ym] = data;
  saveWeeklyLocalAll(all);
}

// 2026-05-26 #OB-MW-001 — 주간업무: oneboard-server → Google Sheets(`weekly_tasks` 시트) 전환
async function fetchWeekly(memberId, ym) {
  if (_weeklyCache[memberId]?.[ym]) return _weeklyCache[memberId][ym];
  const key = mkPlanKey(memberId, ym);
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_TEAM_TASKS_ID}/gviz/tq?tqx=out:csv&sheet=weekly_tasks`;
    const res = await lifecycleFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    const all = parseSimpleCSV(csv);
    // 컬럼: member | ym | slot | text | done | sort_order | id
    const slotsMap = Object.fromEntries(WEEK_SLOTS.map(s => [s, []]));
    all
      .filter(r => r[0] === memberId && r[1] === ym)
      .forEach(r => {
        const slot = r[2] || '';
        if (!slotsMap[slot]) slotsMap[slot] = [];
        slotsMap[slot].push({
          id: r[6] || `local-w-${Date.now()}-${Math.random()}`,
          text: r[3] || '',
          done: (r[4] || '').toUpperCase() === 'TRUE',
          sort_order: parseInt(r[5], 10) || 0,
        });
      });
    WEEK_SLOTS.forEach(s => { slotsMap[s].sort((a, b) => a.sort_order - b.sort_order); });
    (_weeklyCache[memberId] ??= {})[ym] = slotsMap;
    _weeklyMode[key] = 'sheets';
    return slotsMap;
  } catch {
    const local = getWeeklyLocal(memberId, ym);
    const slotsMap = {};
    WEEK_SLOTS.forEach(s => {
      slotsMap[s] = (local[s] || []).map((it, i) => ({
        id: it.id || `local-w-${memberId}-${ym}-${s}-${i}-${Date.now()}`,
        text: it.text||'', done: !!it.done, sort_order: i,
      }));
    });
    (_weeklyCache[memberId] ??= {})[ym] = slotsMap;
    _weeklyMode[key] = 'local';
    return slotsMap;
  }
}

function getWeeklyFor(memberId, ym) {
  return _weeklyCache[memberId]?.[ym] || Object.fromEntries(WEEK_SLOTS.map(s => [s, []]));
}

// 2026-05-26 #OB-MW-001 — Apps Script 양방향 sync
async function addWeeklyItem(memberId, ym, slot) {
  const key = mkPlanKey(memberId, ym);
  const data = _weeklyCache[memberId]?.[ym] || Object.fromEntries(WEEK_SLOTS.map(s => [s, []]));
  data[slot] = data[slot] || [];
  const id = `w-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const payload = { id, text: '새 항목', done: false, sort_order: data[slot].length };
  data[slot].push(payload);
  (_weeklyCache[memberId] ??= {})[ym] = data;
  const sync = await syncToSheet('weekly_create', {
    member: memberId, ym, slot, text: '새 항목', done: false, sort_order: data[slot].length - 1, id,
  });
  if (sync.ok) { _weeklyMode[key] = 'sheets'; }
  else { _weeklyMode[key] = 'local'; setWeeklyLocal(memberId, ym, data); }
}

async function updateWeeklyItem(memberId, ym, slot, idx, patch) {
  const key = mkPlanKey(memberId, ym);
  const data = _weeklyCache[memberId]?.[ym];
  if (!data || !data[slot] || !data[slot][idx]) return;
  Object.assign(data[slot][idx], patch);
  const id = data[slot][idx].id;
  const sync = await syncToSheet('weekly_update', { id, patch });
  if (sync.ok) { _weeklyMode[key] = 'sheets'; }
  else { _weeklyMode[key] = 'local'; setWeeklyLocal(memberId, ym, data); }
}

async function deleteWeeklyItem(memberId, ym, slot, idx) {
  const key = mkPlanKey(memberId, ym);
  const data = _weeklyCache[memberId]?.[ym];
  if (!data || !data[slot] || !data[slot][idx]) return;
  const id = data[slot][idx].id;
  const sync = await syncToSheet('weekly_delete', { id });
  data[slot].splice(idx, 1);
  if (sync.ok) { _weeklyMode[key] = 'sheets'; }
  else { _weeklyMode[key] = 'local'; setWeeklyLocal(memberId, ym, data); }
}

async function renderWeeklyPanel(memberId) {
  const grid = document.getElementById('weeklyGrid');
  if (!grid) return;
  const label = document.getElementById('weeklyMonthLabel');
  if (label) label.textContent = weeklyViewYM;
  grid.innerHTML = '<div class="tier-empty" style="padding:12px;">로딩 중…</div>';
  const data = await fetchWeekly(memberId, weeklyViewYM);
  grid.innerHTML = '';
  WEEK_SLOTS.forEach(slot => {
    const col = document.createElement('div');
    col.className = 'weekly-col';
    col.innerHTML = `
      <div class="weekly-col-head">${slot}</div>
      <div class="weekly-col-body"></div>
      <button class="weekly-add">+ 항목</button>
    `;
    const body = col.querySelector('.weekly-col-body');
    const items = data[slot] || [];
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'weekly-item' + (it.done?' done':'');
      if (idx >= WEEKLY_VISIBLE) row.classList.add('weekly-hidden'); // 2026-05-29 #OB-WK-MORE-001
      row.innerHTML = `
        <input type="checkbox" ${it.done?'checked':''}>
        <span class="weekly-item-text" contenteditable="true">${escapeAttr(it.text||'')}</span>
        <span class="weekly-item-del" title="삭제">✕</span>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        updateWeeklyItem(memberId, weeklyViewYM, slot, idx, { done: e.target.checked });
        row.classList.toggle('done', e.target.checked);
      });
      row.querySelector('.weekly-item-text').addEventListener('blur', (e) => {
        updateWeeklyItem(memberId, weeklyViewYM, slot, idx, { text: e.target.textContent.trim() });
      });
      row.querySelector('.weekly-item-del').addEventListener('click', async () => {
        await deleteWeeklyItem(memberId, weeklyViewYM, slot, idx);
        renderWeeklyPanel(memberId);
      });
      body.appendChild(row);
    });
    // 2026-05-29 #OB-WK-MORE-001 — 5개 초과 시 숨기고 "더보기" 토글
    if (items.length > WEEKLY_VISIBLE) {
      const more = document.createElement('button');
      more.className = 'weekly-more';
      const hiddenCnt = items.length - WEEKLY_VISIBLE;
      more.textContent = `▾ 더보기 (${hiddenCnt}개)`;
      let expanded = false;
      more.addEventListener('click', () => {
        expanded = !expanded;
        body.querySelectorAll('.weekly-hidden').forEach(el => el.classList.toggle('weekly-show', expanded));
        more.textContent = expanded ? '▴ 접기' : `▾ 더보기 (${hiddenCnt}개)`;
      });
      body.appendChild(more);
    }
    col.querySelector('.weekly-add').addEventListener('click', async () => {
      await addWeeklyItem(memberId, weeklyViewYM, slot);
      renderWeeklyPanel(memberId);
    });
    grid.appendChild(col);
  });
}

function bindMonthlyWeeklyEvents() {
  const bindNav = (btnId, kind, delta) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      if (kind === 'monthly') monthlyViewYM = shiftYM(monthlyViewYM, delta);
      else                    weeklyViewYM  = shiftYM(weeklyViewYM,  delta);
      if (currentMemberTab === '통합') return;
      (kind === 'monthly' ? renderMonthlyPanel : renderWeeklyPanel)(currentMemberTab);
    });
  };
  bindNav('monthlyPrev', 'monthly', -1);
  bindNav('monthlyNext', 'monthly',  1);
  bindNav('weeklyPrev',  'weekly',  -1);
  bindNav('weeklyNext',  'weekly',   1);

  document.getElementById('monthlyAddRow')?.addEventListener('click', async () => {
    if (currentMemberTab === '통합') return;
    await addMonthlyRow(currentMemberTab, monthlyViewYM);
    renderMonthlyPanel(currentMemberTab);
  });
}

// switchMemberTab 래핑 — 월간/주간 패널 함께 렌더
const _origSwitchMemberTab = switchMemberTab;
switchMemberTab = function(member) {
  _origSwitchMemberTab(member);
  if (member !== '통합') {
    renderMonthlyPanel(member);
    renderWeeklyPanel(member);
  }
};

// ── 운영매뉴얼 ───────────────────────────────────────────────
const MANUAL_DOCS = [
  { cat:'🏠 팀 매뉴얼', color:'#6B46C1', desc:'매일 반복 루틴 · 전화 응대 표준', items:[
    { file:'일일_체크리스트.md', title:'일일 체크리스트 (출근/퇴근)', hot:true, summary:'09:00 출근 루틴 6항목(출근 인사 포함) + 18:00 퇴근 루틴 5항목 + 책상·공용공간 5룰' },
    { file:'전화_응대.md', title:'전화 응대 매뉴얼', hot:true, summary:'황금 3문장 + 4가지 유형별 분기(세일즈·B2B·대표·거래처) + 메모 양식' },
  ]},
  { cat:'📦 제품 매뉴얼', color:'#3B82F6', desc:'제품별 사용법·스펙·주의사항', items:[
    { file:'소스_쥬얼아이스_사용설명서_공식OL.md', title:'쥬얼아이스 공식 설명서', hot:true, summary:'공식 동봉 설명서 (한/영/일 3개국어)' },
    { file:'소스_듀오메이커_풀매뉴얼.md', title:'듀오메이커 풀매뉴얼', summary:'도요타쯔우쇼용 7단계 상세' },
    { file:'소스_듀오메이커_사용법_6단계.md', title:'듀오메이커 6단계 사용법', summary:'냉동 24~36H, 냉매 먼 곳, 하단 배치' },
    { file:'소스_아블러_사용가이드.md', title:'아블러 사용 가이드', summary:'한영 bilingual + 주의 15항 + 트러블슈팅' },
    { file:'소스_아블러제로_사용설명서.md', title:'아블러 제로 설명서', summary:'420ml·폴리카보네이트·유리·트라이탄' },
    { file:'소스_아블러제로_FAQ_상세페이지.md', title:'아블러 제로 FAQ', summary:'식세기·강화유리·전자레인지·뜨거운 음료' },
    { file:'소스_세척가이드_실리콘몰드.md', title:'실리콘 몰드 세척', summary:'냄새·끈적임·살균 6방식' },
    { file:'소스_ABLR_제안서_기술스펙.md', title:'ABLR 기술스펙 제안서', summary:'6대 핵심 기술·삼단 방한공법·커스텀 아이스' },
  ]},
  { cat:'🎧 CS 대응', color:'#EF4444', desc:'고객 문의·증상별 응대 가이드', items:[
    { file:'소스_CS_얼음증상_대응가이드.md', title:'얼음 증상 대응 가이드', hot:true, summary:'뽀얀얼음·안떨어짐·깨짐 등 실제 증상별 응대 스크립트' },
    { file:'소스_CS_트러블슈팅DB.md', title:'트러블슈팅 DB', summary:'실전 사례 기반 문제 해결 DB' },
    { file:'소스_CS_응대프로세스_4단계.md', title:'CS 응대 4단계 프로세스', summary:'문의확인 → FAQ답변 → 응대기록 → Slack 알림' },
    { file:'소스_CS_채널8개_FAQ22_2021.md', title:'8채널 FAQ22', summary:'네이버·쿠팡 등 8채널 접속법 + FAQ 22개' },
    { file:'소스_채널운영_권수지_인수인계.md', title:'채널 운영 인수인계 (권수지)', summary:'4채널 CS 운영 + 개선 과제' },
  ]},
  { cat:'📝 FAQ', color:'#10B981', desc:'자주 묻는 질문 / 예상 질문 대응', items:[
    { file:'소스_FAQ_와디즈_ablr.md', title:'와디즈 ABLR FAQ', summary:'ablr 캠페인 FAQ (제품·투명얼음·배송)' },
    { file:'소스_FAQ_굿네이버스_예상질문.md', title:'굿네이버스 예상질문', summary:'협력 15개 예상질문 + 난처한 질문 대응' },
    { file:'소스_FAQ_영상기획_재구매율.md', title:'영상 기획·재구매율', summary:'3차 촬영 기획 (구성품·AS·칵테일)' },
  ]},
  { cat:'📋 SOP', color:'#8B5CF6', desc:'실무 프로세스·표준 운영 절차', items:[
    { file:'SOP_택배발송_CS이슈대응.md', title:'택배 발송·CS 이슈', summary:'발송 전후 이슈 대응 표준 절차' },
    { file:'SOP_B2B_문의접수_프로세스.md', title:'B2B 문의접수 프로세스', summary:'B2B 상담 접수 → 제안 → 계약' },
  ]},
  { cat:'🎬 영상 자산', color:'#F59E0B', desc:'영상·이미지 Drive 링크', items:[
    { file:'영상자산_링크카드.md', title:'영상/이미지 자산 카드', summary:'사용법 영상 7+건 · FAQ 영상 4종 · 개봉 GIF' },
  ]},
];

function getTotalDocCount() {
  return MANUAL_DOCS.reduce((sum, g) => sum + g.items.length, 0);
}

function renderManualHome() {
  const viewer = document.getElementById('manualViewer');
  if (!viewer) return;
  manualCurrent = null;
  document.querySelectorAll('.manual-item').forEach(x => x.classList.remove('active'));

  const hotDocs = MANUAL_DOCS.flatMap(g => g.items.filter(i => i.hot).map(i => ({...i, catColor:g.color, cat:g.cat})));

  let html = `
    <div class="manual-home">
      <div class="manual-hero">
        <div class="manual-hero-badge">운영매뉴얼 v1.0 · ${getTotalDocCount()}개 문서 통합</div>
        <h1>쥬얼아이스 운영 매뉴얼</h1>
        <p>팀 공통 업무 매뉴얼 + 고객 CS 대응 자료 · 회사기본 운영매뉴얼 통합본</p>
        <div class="manual-hero-meta">
          <span>📅 2026-04-24 배포</span>
          <span>📚 ${MANUAL_DOCS.length}개 카테고리 · ${getTotalDocCount()}개 문서</span>
        </div>
      </div>

      ${hotDocs.length ? `
      <section class="manual-section">
        <div class="manual-section-title">🔥 주요 문서 (먼저 읽기)</div>
        <div class="manual-hot-grid">
          ${hotDocs.map(d => `
            <div class="manual-hot-card" data-file="${escapeAttr(d.file)}" data-title="${escapeAttr(d.title)}" style="border-left-color:${d.catColor}">
              <div class="manual-hot-cat" style="color:${d.catColor}">${d.cat}</div>
              <div class="manual-hot-title">🔥 ${escapeAttr(d.title)}</div>
              <div class="manual-hot-summary">${escapeAttr(d.summary||'')}</div>
              <div class="manual-hot-cta">읽기 →</div>
            </div>
          `).join('')}
        </div>
      </section>` : ''}

      ${MANUAL_DOCS.map(group => `
        <section class="manual-section">
          <div class="manual-section-title" style="border-left-color:${group.color}">
            <span>${group.cat}</span>
            <span class="manual-section-count">${group.items.length}</span>
          </div>
          <div class="manual-section-desc">${group.desc}</div>
          <div class="manual-card-grid">
            ${group.items.map(it => `
              <div class="manual-doc-card" data-file="${escapeAttr(it.file)}" data-title="${escapeAttr(it.title)}">
                <div class="manual-doc-card-title">${it.hot?'🔥 ':''}${escapeAttr(it.title)}</div>
                <div class="manual-doc-card-summary">${escapeAttr(it.summary||'')}</div>
                <div class="manual-doc-card-foot">
                  <span class="manual-doc-card-file">${escapeAttr(it.file)}</span>
                  <span class="manual-doc-card-arrow">→</span>
                </div>
              </div>
            `).join('')}
          </div>
        </section>
      `).join('')}

      <div class="manual-footer">
        OneBoard v2.0 · 쥬얼아이스 · <span style="color:#94a3b8">문서 수정은 <code>oneboard/manuals/</code> 폴더의 마크다운 파일을 편집하세요</span>
      </div>
    </div>
  `;
  viewer.innerHTML = html;

  // 카드 클릭 바인딩
  viewer.querySelectorAll('.manual-hot-card, .manual-doc-card').forEach(card => {
    card.addEventListener('click', () => {
      const file = card.dataset.file, title = card.dataset.title;
      const navEl = document.querySelector(`.manual-item[data-file="${file}"]`);
      loadManualDoc(file, title, navEl);
    });
  });
}

let manualCache = {};
let manualCurrent = null;

function renderManualNav() {
  const nav = document.getElementById('manualNav');
  if (!nav) return;
  nav.innerHTML = '';
  // 홈 버튼
  const home = document.createElement('div');
  home.className = 'manual-item manual-home-btn';
  home.innerHTML = '🏠 홈 · 전체 문서';
  home.addEventListener('click', () => {
    document.querySelectorAll('.manual-item').forEach(x => x.classList.remove('active'));
    home.classList.add('active');
    renderManualHome();
  });
  nav.appendChild(home);
  // 카테고리별
  MANUAL_DOCS.forEach(group => {
    const g = document.createElement('div'); g.className='manual-group';
    const h = document.createElement('div');
    h.className='manual-group-title';
    h.textContent=group.cat;
    h.style.color = group.color;
    g.appendChild(h);
    group.items.forEach(it => {
      const a = document.createElement('div');
      a.className='manual-item';
      a.dataset.file = it.file;
      a.innerHTML = `${it.hot?'<span style="color:#EF4444">🔥</span> ':''}${it.title}`;
      a.addEventListener('click', () => loadManualDoc(it.file, it.title, a));
      g.appendChild(a);
    });
    nav.appendChild(g);
  });
}

async function loadManualDoc(file, title, el) {
  document.querySelectorAll('.manual-item').forEach(x => x.classList.remove('active'));
  el?.classList.add('active');
  const viewer = document.getElementById('manualViewer');
  if (!viewer) return;
  viewer.innerHTML = '<div class="manual-placeholder"><div>⏳ 로딩 중...</div></div>';
  try {
    let md = manualCache[file];
    if (!md) {
      const res = await lifecycleFetch(`manuals/${encodeURIComponent(file)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      md = await res.text();
      manualCache[file] = md;
    }
    manualCurrent = { file, title, md };
    // 카테고리 찾기
    let groupInfo = null;
    for (const g of MANUAL_DOCS) {
      const f = g.items.find(i => i.file === file);
      if (f) { groupInfo = { ...g, doc:f }; break; }
    }
    const html = (typeof marked !== 'undefined') ? marked.parse(md) : `<pre>${md.replace(/</g,'&lt;')}</pre>`;
    const catBadge = groupInfo ? `<span class="manual-doc-cat" style="background:${groupInfo.color}15;color:${groupInfo.color};border:1px solid ${groupInfo.color}40">${groupInfo.cat}</span>` : '';
    const hotBadge = groupInfo?.doc?.hot ? '<span class="manual-doc-hot">🔥 주요</span>' : '';
    const summary = groupInfo?.doc?.summary || '';
    viewer.innerHTML = `
      <div class="manual-doc-head">
        <div class="manual-doc-breadcrumb">
          <a class="manual-back" id="manualBackBtn">← 홈</a>
          ${catBadge}
          ${hotBadge}
        </div>
        <div class="manual-doc-title">${escapeAttr(title)}</div>
        ${summary ? `<div class="manual-doc-summary">${escapeAttr(summary)}</div>` : ''}
        <div class="manual-doc-file">📄 ${escapeAttr(file)}</div>
      </div>
      <div class="manual-doc-body">${html}</div>
    `;
    document.getElementById('manualBackBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      renderManualHome();
    });
  } catch (e) {
    viewer.innerHTML = `<div class="manual-placeholder"><div>⚠️ 문서를 불러올 수 없습니다: ${e.message}</div><div style="font-size:12px;color:#94a3b8;margin-top:8px">manuals/${file}</div></div>`;
  }
}

function bindManualEvents() {
  const search = document.getElementById('manualSearch');
  if (search) {
    search.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.manual-item').forEach(el => {
        const hit = !q || el.textContent.toLowerCase().includes(q);
        el.style.display = hit ? '' : 'none';
      });
    });
  }
}

// ── 설정 ─────────────────────────────────────────────────────
// 2026-05-21 #OB-DRIVE-001: 카페24·쿠팡·META·네이버광고·카카오 API 자동 연동 영구 폐기.
// Drive 자동 머지 안내 1장만 유지. Charles "여기도 불필요한거 없애줘" 정합 단순화.
const CHANNEL_KEYS_DEF = [
  { id:'drive_sync',        name:'📂 매일 수동 입력 — Google Drive 자동 머지', keys:['—'], doc:'권수지 대리 폴더 → oneboard-daily-upload/', group:'master', desc:'매일 오전 권수지 대리가 쿠팡·META 등 자동 안 되는 채널을 Drive 폴더에 박으면 서버가 9:30부터 30분마다 자동 가져가 매출·광고에 머지합니다. OneBoard 화면에서 별도 클릭 작업 없음.' },
];

function renderChannelKeys() {
  const grid = document.getElementById('channelKeysGrid');
  if (!grid) return;
  grid.replaceChildren();
  CHANNEL_KEYS_DEF.forEach((ch) => {
    const groupLabel = document.createElement('div');
    groupLabel.className = `channel-keys-group-header channel-keys-group-${ch.group}`;
    groupLabel.textContent = '📂 매일 수동 입력 — Drive 자동 머지';
    grid.appendChild(groupLabel);

    const card = document.createElement('div');
    card.className = `channel-key-card${ch.group ? ' channel-key-card-' + ch.group : ''}`;
    const head = document.createElement('div');
    head.className = 'channel-key-head';
    const name = document.createElement('div');
    name.className = 'channel-key-name';
    name.textContent = ch.name;
    const status = document.createElement('div');
    status.className = 'channel-key-status';
    status.textContent = '⚙️ 자동 동작 중';
    head.append(name, status);

    const description = document.createElement('div');
    description.className = 'channel-key-doc channel-key-description';
    description.textContent = ch.desc;
    const detail = document.createElement('div');
    detail.className = 'channel-key-doc channel-key-detail';
    detail.textContent = `📁 폴더: ${ch.doc} · ⏰ 폴링: 09:30 시작, 매 30분 (~22:30) · 📋 파일명: sales_채널_YYYY-MM-DD.csv / ads_채널_YYYY-MM-DD.csv`;
    card.append(head, description, detail);
    grid.appendChild(card);
  });
}

function renderTeamMgmtList() {
  const list = document.getElementById('teamMgmtList');
  if (!list) return;
  const members = loadTeamMembers();
  list.innerHTML = '';
  members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'team-mgmt-row';
    row.innerHTML = `
      <span class="team-mgmt-dot" style="background:${m.color}"></span>
      <span class="team-mgmt-name">${escapeAttr(m.name)} <span class="team-mgmt-role">${escapeAttr(m.role||'')}</span></span>
      <button class="btn-danger" data-id="${escapeAttr(m.id)}">삭제</button>
    `;
    row.querySelector('.btn-danger').addEventListener('click', () => {
      if (!confirm(`${m.name} 탭을 삭제할까요? (월간/주간 로컬 데이터 함께 삭제 · 서버 DB 데이터는 보존)`)) return;
      const next = loadTeamMembers().filter(x => x.id !== m.id);
      saveTeamMembers(next);
      const mo = loadMonthlyLocalAll(); delete mo[m.id]; saveMonthlyLocalAll(mo);
      const wk = loadWeeklyLocalAll(); delete wk[m.id]; saveWeeklyLocalAll(wk);
      delete _monthlyCache[m.id]; delete _weeklyCache[m.id];
      if (currentMemberTab === m.id) currentMemberTab = '통합';
      renderMemberTabs();
      renderTeamMgmtList();
    });
    list.appendChild(row);
  });
}

function loadSettingsPrefs() {
  try { return JSON.parse(localStorage.getItem('ob_settings_prefs') || '{}'); } catch { return {}; }
}
function saveSettingsPrefs(p) { localStorage.setItem('ob_settings_prefs', JSON.stringify(p)); }

function populateSettingsInputs() {
  const p = loadSettingsPrefs();
  const g = document.getElementById('goalInput'); if (g) g.value = p.goal || '₩20억';
  const r = document.getElementById('defaultRangeSelect'); if (r) r.value = p.defaultRange || '30';
  const n1 = document.getElementById('notifMinutesAi'); if (n1) n1.checked = p.notifMinutesAi !== false;
  const n2 = document.getElementById('notifSalesDrop'); if (n2) n2.checked = p.notifSalesDrop !== false;
  const ri = document.getElementById('refreshInterval'); if (ri) ri.value = p.refreshInterval || '5';
}

function collectSettingsPrefs() {
  return {
    goal: document.getElementById('goalInput')?.value || '₩20억',
    defaultRange: document.getElementById('defaultRangeSelect')?.value || '30',
    notifMinutesAi: !!document.getElementById('notifMinutesAi')?.checked,
    notifSalesDrop: !!document.getElementById('notifSalesDrop')?.checked,
    refreshInterval: document.getElementById('refreshInterval')?.value || '5',
  };
}

async function openSettingsBody() {
  renderChannelKeys();
  renderTeamMgmtList();
  populateSettingsInputs();
}

function bindSettingsEvents() {
  // 프리퍼런스 저장 (변경 즉시)
  ['goalInput','defaultRangeSelect','notifMinutesAi','notifSalesDrop','refreshInterval'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => saveSettingsPrefs(collectSettingsPrefs()));
  });

  // 팀원 추가
  document.getElementById('addMemberBtn')?.addEventListener('click', () => {
    const name = document.getElementById('newMemberName')?.value.trim();
    const role = document.getElementById('newMemberRole')?.value.trim() || '';
    if (!name) { alert('이름을 입력하세요'); return; }
    addTeamMember(name, role);
    document.getElementById('newMemberName').value = '';
    document.getElementById('newMemberRole').value = '';
  });

  // 동기화/연결 테스트 (stub)
  document.getElementById('syncAllBtn')?.addEventListener('click', () => {
    const lbl = document.getElementById('lastSyncLabel');
    if (lbl) lbl.textContent = `마지막 동기화: ${new Date().toLocaleString('ko-KR')}`;
    alert('🔄 동기화: oneboard-server 연결 후 실제 API 동기화가 수행됩니다.\n현재는 Google Sheets 데이터를 사용 중입니다.');
  });
  document.getElementById('testConnBtn')?.addEventListener('click', async () => {
    try {
      const res = await authenticatedResponse('/health', { method:'GET' });
      alert(res.ok ? '✅ oneboard-server 연결 OK' : `⚠️ 서버 응답: ${res.status}`);
    } catch (e) {
      alert(`❌ 연결 실패: ${e.message}\n(현재는 Google Sheets로 동작 중)`);
    }
  });

  // 설정 내보내기/가져오기
  document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
    const dump = {
      prefs: loadSettingsPrefs(),
      members: loadTeamMembers(),
      monthly: loadMonthlyLocalAll(),  // 로컬 잔여만 — 서버 DB 데이터는 별도 백업
      weekly: loadWeeklyLocalAll(),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `oneboard-settings-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  });
  document.getElementById('importSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('importSettingsFile')?.click();
  });
  document.getElementById('importSettingsFile')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      if (data.prefs) saveSettingsPrefs(data.prefs);
      if (data.members) saveTeamMembers(data.members);
      if (data.monthly) saveMonthlyLocalAll(data.monthly);
      if (data.weekly) saveWeeklyLocalAll(data.weekly);
      alert('✅ 설정을 가져왔습니다. 새로고침 권장.');
      renderMemberTabs();
      renderTeamMgmtList();
      populateSettingsInputs();
    } catch (err) {
      alert(`❌ 가져오기 실패: ${err.message}`);
    }
  });
}

// ── 섹션 스위치 확장: manual, settings ────────────────────────
const _origSwitchSection = switchSection;
switchSection = function(section) {
  _origSwitchSection(section);
  if (section === 'manual') {
    renderManualNav();
    if (!manualCurrent) renderManualHome();
  }
  if (section === 'settings') {
    openSettingsBody();
  }
};
