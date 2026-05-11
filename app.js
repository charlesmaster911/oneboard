/**
 * OneBoard — 원보드 메인 앱
 * Google Sheets CSV 실시간 연동 + Chart.js 대시보드
 *
 * 데이터 구조 (통합 탭):
 *   날짜 | 총 매출 | 총 유입 | 전환 매출 | 총 광고비 | 총 ROAS | 전환 ROAS | 광고비율
 */

// oneboard-server API 베이스 URL
// 배포 환경에서는 index.html에서 window.API_BASE 를 설정하거나
// 기본값 '/api' 를 사용 (Render 동일 도메인 배포 시)
const API_BASE = window.API_BASE || 'https://oneboard-server.onrender.com/api';

// JWT 토큰 (로그인 후 localStorage에 저장됨)
function getToken() {
  return localStorage.getItem('oneboard_token') || '';
}
function setToken(t) {
  if (t) localStorage.setItem('oneboard_token', t);
  else localStorage.removeItem('oneboard_token');
}

// ─── 워크스페이스 로그인 (팀 데이터 동기화) ───────────────
async function authLogin(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  setToken(data.token);
  return data;
}

async function authRegister(email, password, name, workspaceName) {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, workspace_name: workspaceName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  setToken(data.token);
  return data;
}

async function authMe() {
  if (!getToken()) return null;
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      if (res.status === 401) setToken(null);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

function authLogout() {
  setToken(null);
}

async function refreshAuthUI() {
  const statusEl = document.getElementById('authStatus');
  const loginForm = document.getElementById('authLoginForm');
  const loggedIn = document.getElementById('authLoggedIn');
  if (!statusEl) return;
  const me = await authMe();
  if (me) {
    statusEl.textContent = '🟢 로그인됨 — 백엔드 영구 저장 활성';
    statusEl.style.color = '#065F46';
    if (loginForm) loginForm.style.display = 'none';
    if (loggedIn) loggedIn.style.display = '';
    const userLabel = document.getElementById('authUserLabel');
    const wsLabel = document.getElementById('authWorkspaceLabel');
    if (userLabel) userLabel.textContent = `${me.name || ''} (${me.email || ''})`;
    if (wsLabel) wsLabel.textContent = me.workspace_name || '—';
  } else {
    statusEl.textContent = '🔴 미로그인 — 로컬 임시저장만 가능 (팀원 입력이 동기화되지 않음)';
    statusEl.style.color = '#991B1B';
    if (loginForm) loginForm.style.display = '';
    if (loggedIn) loggedIn.style.display = 'none';
  }
}

const SHEET_ID = '11byYTuUleS-kq3idS4e0Mgt368FssfnrHchyalHPuRI';

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
const CHANNEL_COL_MAP = {
  // 메인 시트 (gid=0)
  '통합':           { gid: 0,           dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 4,  adCol: 5,  roasCol: 6,  adRatioCol: 8,    hasTraffic: true  },
  '자사몰':         { gid: 0,           dateCol: 10, salesCol: 11, trafficCol: 12,   convCol: 13, adCol: 14, roasCol: 15, adRatioCol: 17,   hasTraffic: true  },
  'META':           { gid: 0,           dateCol: 19, salesCol: 20, trafficCol: null, convCol: 20, adCol: 21, roasCol: 22, adRatioCol: 23,   hasTraffic: false },
  '네이버':         { gid: 0,           dateCol: 39, salesCol: 40, trafficCol: 41,   convCol: 42, adCol: 43, roasCol: 44, adRatioCol: 45,   hasTraffic: true  },
  // 쿠팡 분리 시트 (gid=2052767088)
  '쿠팡_한반도':    { gid: 2052767088,  dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 9,  adCol: 11, roasCol: 12, adRatioCol: null, hasTraffic: true  },
  '쿠팡_네모칩':    { gid: 2052767088,  dateCol: 14, salesCol: 15, trafficCol: 16,   convCol: 22, adCol: 24, roasCol: 25, adRatioCol: null, hasTraffic: true  },
  // 카카오 시트 (gid=1562400814)
  '카카오모먼트':   { gid: 1562400814,  dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 9,  adCol: 11, roasCol: 12, adRatioCol: null, hasTraffic: true  },
  '카카오_매출':    { gid: 1562400814,  dateCol: 14, salesCol: 20, trafficCol: 15,   convCol: 20, adCol: 21, roasCol: 22, adRatioCol: null, hasTraffic: true  },
  // 네이버 검색광고 (gid=364317310)
  '네이버_검색광고':{ gid: 364317310,   dateCol: 1,  salesCol: 2,  trafficCol: 3,    convCol: 9,  adCol: 11, roasCol: 12, adRatioCol: null, hasTraffic: true  },
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
let currentRange = 30;
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
function fmtKRW(n) {
  if (n >= 100000000) return `₩${(n / 100000000).toFixed(2)}억`;
  if (n >= 10000000)  return `₩${(n / 10000000).toFixed(1)}천만`;
  if (n >= 1000000)   return `₩${(n / 1000000).toFixed(1)}M`;
  return `₩${n.toLocaleString('ko-KR')}`;
}

function fmtNum(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  return n.toLocaleString('ko-KR');
}

function fmtDate(str) {
  return str ? str.slice(5) : ''; // MM-DD
}

// ─── Google Sheets CSV 패치 (다중 gid 캐시) ──────────────────
async function fetchSheetCSV(gid = 0) {
  if (rawCSVByGid[gid]) return rawCSVByGid[gid];
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} (gid=${gid})`);
  const text = await res.text();
  rawCSVByGid[gid] = text;
  if (gid === 0) rawCSV = text; // 구버전 호환 (gid=0)
  return text;
}

// 채널 데이터 로드 — 채널 매핑의 gid에 해당하는 시트 fetch + 파싱
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
  const rows = parseSheetRows(csv, channel);
  channelDataCache[channel] = rows;
  return rows;
}

function parseSheetRows(csvText, channel = '통합') {
  const cols = CHANNEL_COL_MAP[channel] || CHANNEL_COL_MAP['통합'];
  const lines = csvText.trim().split('\n').filter(l => l);

  // 헤더 행 찾기: dateCol 위치에 "날짜" 텍스트가 있는 행
  let dataStart = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const v = parseCSVRow(lines[i]);
    const cell = (v[cols.dateCol] || '').replace(/"/g, '').trim();
    if (cell === '날짜') { dataStart = i + 1; break; }
  }
  if (dataStart === -1) return [];

  const rows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const v = parseCSVRow(lines[i]);
    const dateStr = (v[cols.dateCol] || '').replace(/"/g, '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    rows.push({
      date:         dateStr,
      totalSales:   parseKRW(v[cols.salesCol]),
      totalTraffic: parseNum(v[cols.trafficCol] || '0'),
      convSales:    parseKRW(v[cols.convCol]),
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
  const token = getToken();
  if (!token) return null;

  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(`${API_BASE}/data/summary?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return apiSummaryToRows(json);
  } catch {
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
  const token = getToken();
  if (!token) return null;

  const to   = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(`${API_BASE}/data/daily?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
  } catch {
    return null;
  }
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

// ─── 날짜 필터 ───────────────────────────────────────────────
function applyRange(data, days) {
  if (!days) return data;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cut = cutoff.toISOString().slice(0, 10);
  return data.filter(d => d.date >= cut);
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

  // 비교 기간 (이전 동일 기간)
  let prevData = [];
  if (currentRange > 0 && allData.length) {
    const cut1 = new Date(); cut1.setDate(cut1.getDate() - currentRange);
    const cut2 = new Date(); cut2.setDate(cut2.getDate() - currentRange * 2);
    const c1 = cut1.toISOString().slice(0, 10);
    const c2 = cut2.toISOString().slice(0, 10);
    prevData = allData.filter(d => d.date >= c2 && d.date < c1);
  }

  const curr = calcKPIs(filteredData);
  const prev = prevData.length ? calcKPIs(prevData) : null;

  renderKPIs(curr, prev);
  renderSalesChart(filteredData);
  renderROASChart(filteredData);
  renderAdRatioChart(filteredData);
  renderChannelChart();
  renderTable(filteredData);

  // 최근 날짜 표시
  if (filteredData.length) {
    const latest = filteredData[filteredData.length - 1].date;
    document.getElementById('lastUpdated').textContent = `최근 데이터: ${latest}`;
  }
}

// ─── 이벤트 바인딩 ────────────────────────────────────────────
function bindEvents() {
  // 날짜 범위 버튼
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = parseInt(btn.dataset.range);
      updateDashboard();
    });
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
}

// ─── 초기화 ──────────────────────────────────────────────────
// 데이터 소스 우선순위:
//   1순위 — oneboard-server API (JWT 토큰 있을 때)
//   2순위 — Google Sheets CSV (공개 시트)
//   3순위 — mock 데이터 (graceful degradation)
async function init() {
  bindEvents();

  const srcEl = document.getElementById('dataSource');

  // 1순위: API 연동 시도
  try {
    const apiRows = await fetchAPIDailyData(currentRange || 30);
    if (apiRows && apiRows.length > 0) {
      allData = apiRows;
      channelDataCache['통합'] = allData;
      if (srcEl) srcEl.textContent = `API 실시간 연동 ✓  (${allData.length}일)`;
      console.log('[OneBoard] API 데이터 로드:', allData.length, '일');
      updateDashboard();
      return;
    }
  } catch (err) {
    console.warn('[OneBoard] API 연동 실패:', err.message);
  }

  // 2순위: Google Sheets CSV 시도
  try {
    const csv = await fetchSheetCSV(SHEET_GIDS.main);
    allData = parseSheetRows(csv, '통합');
    channelDataCache['통합'] = allData;
    if (allData.length === 0) throw new Error('파싱된 데이터 없음');
    if (srcEl) srcEl.textContent = `Google Sheets 실시간 연동 ✓  (${allData.length}일 · 채널 8개)`;
    console.log('[OneBoard] Sheets 데이터 로드:', allData.length, '일, 채널:', Object.keys(CHANNEL_COL_MAP).join(', '));
  } catch (err) {
    // 3순위: mock 데이터 (graceful degradation)
    console.warn('[OneBoard] Sheets 연동 실패 → 목업 데이터 사용:', err.message);
    allData = buildMockData();
    channelDataCache['통합'] = allData;
    if (srcEl) srcEl.textContent = '목업 데이터 (API 또는 시트 공개 후 자동 연동)';
  }

  updateDashboard();
}

document.addEventListener('DOMContentLoaded', init);




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

// localStorage `ob_team_members`에 '찰스' 없으면 자동 prepend (기존 사용자 마이그레이션)
(function migrateTeamMembersCharles() {
  try {
    const saved = JSON.parse(localStorage.getItem('ob_team_members') || 'null');
    if (Array.isArray(saved) && saved.length && !saved.some(m => m && m.id === '찰스')) {
      const next = [{ id: '찰스', name: '찰스', role: '대표 기획운영', color: '#EF4444', bg: '#FEF2F2' }, ...saved];
      localStorage.setItem('ob_team_members', JSON.stringify(next));
      console.log('[migrate] 찰스 멤버 자동 추가 (localStorage prepend)');
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

// ── 회의록 프리셋 (시트 13yy1MtUh... gid=1125757148 + 4/30·5/4·5/8 보강) ─────────
const MINUTES_PRESET = [
  {"id": "preset-m-2026-05-11", "date": "2026-05-11", "title": "주간회의", "attendees": "장정훈 이한수 권나경 권수지", "directives": "출퇴근 시 단톡방 인사로 근태 기록 생활화 (잔디)", "content": "1. 신임 팀장 환영 및 조직 문화 \n적응 기간 : 신임 팀장의 출퇴근 시간(의정부 기준 약 45~50분) 및 업무 적응을 위해 한 달간 여유를 갖고 기존 노하우와 사내 문화를 융합하는 시간을 가질 것을 권장함.\n사내 분위기 : 업무 외적인 스트레스나 사내 정치 없는 일 중심의 편안한 분위기를 지향함.\n정기 회의 : 매주 월요일과 금요일 오전 11시에 주간 업무 계획 및 진행 상황 업데이트를 위한 회의를 진행함.\n\n2. 업무 툴 및 시스템 자동화 \n데이터 연동 : 잔디(Jandi)와 구글 드라이브를 연동하여 누적 데이터를 관리하며, Gemini를 통해 필요한 서류를 빠르게 검색할 수 있는 환경을 구축함.\n온보드(On-board) : 매출, 광고, 개별 업무를 한눈에 볼 수 있는 통합 보드를 시범 운영 중이며, 구글 캘린더와 연동하여 업무를 관리함.\n근태 관리 자동화 : 별도의 기록 대신 단톡방에 출근 인사를 남기면 AI가 이를 스크랩하여 자동으로 근태 기록을 생성하도록 설정함.\nCS 통합 관리 : 네이버, 자사몰, 인스타그램 메시지를 '채널톡'으로 통합 관리하며, 신임 팀장도 고객 반응 파악을 위해 초기 CS 업무에 참여할 예정임.\n3. 부서별 주간 업무 계획 \n권나경 과장 (마케팅/영업)\n아블러 생산 : 중국 해운 상황 악화로 인해 추락 일정 딜레이(내일 추락 예정), 잔금 및 서류 준비 진행.\n채널 관리 : 종합몰 사방넷 세팅 점검 및 상품 반려 건 정리, 개인 계정으로 설정된 인증 번호를 회사 폰으로 수정 작업.\n와디즈 : 5월 14일부터 배송 시작 예정, 반품 건은 자체 비용 수취 후 처리하는 방향으로 협의.\n기타 : 큐브 론칭 마스터플랜 수립, 카페24 크리에이티브 마케팅 및 SK스토아 육성 지원 사업 세팅.\n\n권수지 대리 (운영/물류)\n창고 및 자산 정리 : 사무실 내 창고 정리를 구역별(1~3구역)로 세분화하여 엑셀 및 위치 기반 태그로 정리(약 2주 소요 예상).\n아블러 조립 : 내일부터 조립 시작하여 이번 주 내 완료 목표.\n주문 관리 : 월요일 발주 수량 확인 및 CS 응대, 듀오메이커 발주 관련 대표자 논의 필요.\n와디즈 정산 : 결제 완료 및 예정자 명단을 AI를 활용해 시트별로 분류 및 13일 최종 체크.\n\n4. 전략적 방향성 논의 (신임 팀장 제언) \n광고 통합 관리 : 메타, GFA 등 채널별 광고를 카페24 안에서 통합 관리하여 상세 페이지와의 시너지를 내는 방안 검토 중.\n물류 시스템 개선 : 현재의 삼자물류(3PL) 시스템을 카페24와 자동 연동되는 'M배송'이나 '위킥' 등 당일 배송 가능 시스템으로 전환하여 효율을 높일 것을 제안함.\n마케팅 전략 수정 : 브랜드 중심의 장기 마케팅보다 중소기업에 적합한 제품 노출 중심의 효율적 마케팅(키워드 유입량 증대 등)에 집중할 필요가 있다고 지적함.\n\n 📅 향후 실행 과제 (Action Items)\n | 상시 |\n| **전 직원** | 책상 및 사무 공간 깔끔하게 정리\n                     출퇴근 시 단톡방 인사로 근태 기록 생활화 (잔디)\n\n| **권나경 과장** | 와디즈 결제/정산 관련 새소식 추가 게시 \n                            종합몰 로그인 담당자 및 인증 정보 전면 수정 \n| **권수지 대리** | 창고 물품 구역별 위치 기반 엑셀 리스트 작성 \n                            아블러 조립 일정 확인 및 발주 완료"},
  {"id": "preset-m-2026-05-08", "date": "2026-05-08", "title": "주간회의", "attendees": "장정훈 권나경 권수지", "directives": "업무 효율화 지시: 권수지 대리는 권나경 과장의 업무 정리 방식을 참고하여,\n이번 주와 다음 주에 처리해야 할 할 일을 체계적으로 정리하여 즉각 수행할 것.\n사무실 내 창고 정리를 실시하고, 정리된 현황을 파일로 작성하여 보고할 것.\n쿠팡 로켓그로스 품절 나지않게 관리 명확하게.", "content": "회의 일시: 2026년 4월 27일 (월)\n\n주요 참석자: 대표님, 팀장님, 권나경 과장, 권수지 대리 외\n\n회의 목적: 주간 업무 실적 보고 및 5월 주요 일정(가정의 달, 외주 관리, 시스템 연동) 수립\n\n1. 부서별 주요 업무 및 보고 사항\n 채널별(자사몰, 쿠팡 등) 가격 조정 및 프로모션 MD 승인 요청.\n 아블러 선적 서류 및 잔금 결제 체크.\n SK스토아 지원 사업 후속 서류 제출 및 구글 드라이브 폴더 구조 재편성.\n\n2.생산 관리 및 운영 지원\n 생산 관리: 듀오메이커 생산 수량 및 그에 따른 비용 산출 보고.\n 아블러 조립: 아블러 제품의 조립 일정 체크 및 입고 현황 보고.\n 시스템 점검: 현재 도입 검토 중인 AI 전화 서비스가 회사로 유입되는 실제 전화량 대비 효율이 낮음을 보고(비용 대비 실효성 검토 필요).\n 대외 협력: 새일센터 담당자 방문 건 보고.\n\n2. 대표 지시 사항\n 업무 효율화 지시: 권수지 대리는 권나경 과장의 업무 정리 방식을 참고하여, \n 이번 주와 다음 주에 처리해야 할 할 일을 체계적으로 정리하여 즉각 수행할 것.\n 사무실 내 창고 정리를 실시하고, 정리된 현황을 파일로 작성하여 보고할 것.\n 쿠팡 로켓그로스 품절 나지않게 관리 명확하게.\n \n대외 일정 및 파트너사 관리:\n 차주 팀장 출근 시 업무 진행 상황을 면밀히 공유할 것.\n 5월 말 일정 보고와 함께 주요 거래처(해피홈, 성준테크, 피플스토리) 방문 일정을 수립할 것."},
  {"id": "preset-m-2026-05-04", "date": "2026-05-04", "title": "주간회의", "attendees": "장정훈 권나경 권수지", "directives": "**오늘 오후:** 어버이날 관련 카카오톡 메시지 발송 및 새소식 업데이트 (대표 컨펌 후 실행).\n**와디즈:** 대표가 공유한 이미지와 문구 소스를 활용하여 새소식 게시 및 소통 강화.\n**업무 우선순위:** 권 대리는 월요일 업무 특성상 발주 및 CS 처리를 우선하되, API 및 전화 관련 조사는 데드라인을 설정하여 대표에게 보고.", "content": "회의록: 주간 업무 점검 및 5월 프로모션 대응 회의\n\n1. 회의 목적\n * 5월 가정의 달(어버이날, 스승의 날) 대응 마케팅 및 프로모션 점검\n * 채널별(CJ, 사방넷, 와디즈) 세팅 및 정산 현황 확인\n * 물류 및 생산(아블러, 듀오 메이커) 일정 공유\n * 신규 팀장 입사 및 업무 인수인계 방향 논의\n\n2. 주요 논의 내용 및 안건\n **[마케팅 & 프로모션] 가정의 달 대응**\n * **어버이날/스승의 날 행사:** '아블러 제로' 등 효도 선물 옵션을 강조한 카카오톡 알림톡 메시지 발송 및 랜딩 페이지 연결 추진.\n * **진행 방향:** 가격을 무리하게 낮추기보다 기존 할인 가격대를 유지하며 '선물 아이템'으로서의 인지도를 높이는 방향으로 노출.\n * **CJ MD 협업:** 현재 프로모션 세팅 및 도금 코드 발급 절차 진행 중.\n**[영업 & 정산] 채널 관리 및 비투비(B2B)**\n * **가격표 관리:** 대표가 직접 상품 관리표의 수식을 수정하고 업데이트 예정.\n * **정산:** 미스터 스티키, 어쿠스틱 큐브 정산 건은 오늘 중 세금계산서 발행 및 결제 상신.\n * **B2B 단가 조정:** 과거 저가(3만 원대)로 공급되던 B2B 단가를 현재 인상된 원가에 맞춰 조정 필요. 이번 8개 발주분까지만 기존 단가 적용 후, 다음 발주부터 인상 공지.\n**[물류 & 생산] 재고 및 입고 관리**\n * **재고 현황:** 피플 스토리의 아블러 몰드 수량 체크 오류 확인. 5월 7일 신규 물량 입고 시 합산 반영 요청.\n * **출고 일정:**\n   * **5월 6일:** 아블러(피플 스토리), 듀오 메이커(해피홈) 실링 완료 후 출고 예정.\n   * **5월 7일/8일:** 해피홈 컬러 박스 입고 후 조립 진행, 8일 최종 출고 예정.\n **[인사 & 조직] 신규 채용**\n * **신규 팀장 영입:** 이양수 팀장 입사 확정(5/8 또는 5/12 출근). 실무 역량이 뛰어난 인력으로 판단됨.\n * **계약 조건:** 잦은 퇴사 방지를 위해 3개월/1년 단위의 보상 연동 조건 설정.\n\n3. 결정 사항 (Key Decisions)\n * **오늘 오후:** 어버이날 관련 카카오톡 메시지 발송 및 새소식 업데이트 (대표 컨펌 후 실행).\n * **와디즈:** 대표가 공유한 이미지와 문구 소스를 활용하여 새소식 게시 및 소통 강화.\n * **업무 우선순위:** 권 대리는 월요일 업무 특성상 발주 및 CS 처리를 우선하되, API 및 전화 관련 조사는 데드라인을 설정하여 대표에게 보고.\n\n4. 향후 실행 과제 (Action Items)\n * **[대표(참석자 1)]** 상품 관리표 수식 수정 및 메일 발송 / 오전 은행 업무 후 오후 마케팅 컨펌\n * **[권 과장(참석자 2)]** 사방넷 후속 세팅 및 와디즈 건 진행 / 미스터 스티키 정산 상신\n * **[권 대리(참석자 3)]** 재고 현황 업데이트 및 피플 스토리 수량 관리 / B2B 업체 단가 인상 안내 / 발주 및 CS 처리"},
  {"id": "preset-m-2026-04-30", "date": "2026-04-30", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "콘텐츠 마케팅 외부 위탁:** 내부 인력 운영 대신 전문 외부 업체 활용.\n해외 배송 프로젝트 보류:** 자금 상황 고려하여 6월 이후로 연기.\n가격표 재산출:** 인위적인 최저가보다 수식을 통한 리즈너블한 판매가 가이드 수립 (팀장 담당).\n업무 우선순위 조정:** '굿 디자인' 지원 사업보다 내부 운영 안정화 및 매출 증대 이벤트(5월 가정의 달) 선행.", "content": "1. 회의 목적\n * 4월 광고 집행 결과 보고 및 5월 마케팅 전략 수립\n * 판매 가격 체계 리뉴얼 및 채널별 운영 전략 논의\n * 사방넷-이지어드민 시스템 안정화 및 업무 인수인계 계획 수립\n * 생산 일정(아블러, 어쿠스틱 큐브 등) 및 입고 현황 점검\n\n2. 논의 내용 및 주요 안건\n**[마케팅 & 광고] 4월 성과 및 5월 계획**\n * 4월 성과:** 광고비 약 450만 원 집행, 매출 1.6억 원, ROAS 360% 달성 (안정권 진입).\n * 매체 전략:** GFA 효율 저하로 인해 신규 디스플레이 광고 및 브랜드 검색 광고(월 60만 원) 도입 검토.\n * 대행사 변경:** '에프로드'로 업체 변경 결정 (수수료 15%, 피드백 및 구성 안정성 우수).\n**[영업 & CS] 가격 체계 및 판매 전략**\n * 이슈:** 단품 특가와 세트 구성 간의 가격 역전 현상 발생(고객 혼선 및 CS 인입).\n * 전략:** 자사몰/네이버/쿠팡을 최저가 채널로 운영하되, 단품 특가 진행 시 이벤트 페이지(배너)를 통한 안내 필수화.\n * 가격 조정:** 판매가를 리즈너블하게 재설정하고, 복수 구매 및 세트 구성 시 고객이 납득할 수 있는 할인율 적용.\n**[시스템 & 운영] 사방넷 및 CS 솔루션**\n * 시스템:** 사방넷-이지어드민 간 API 충돌 우려로 인해 두 달간의 안정화 기간 필요.\n * CS 자동화:** KT 사장님 비즈니스(월 9,900원) 혹은 보이는 ARS 도입 검토. 단순 배송 문의를 카카오톡 채널 등으로 유도하여 업무 효율 제고.\n**[생산 & 물류] 재고 및 공정 관리**\n * 어쿠스틱 큐브:** 5월 중순 금형비 지급, 6월 초 생산 및 중순 출고 목표.\n * 입고 관리:** 입고 시 체크리스트 및 박스 표기(중국 생산분 등) 철저히 관리하여 누락 방지.\n\n3. 결정 사항 (Key Decisions)\n * 콘텐츠 마케팅 외부 위탁:** 내부 인력 운영 대신 전문 외부 업체 활용.\n * 해외 배송 프로젝트 보류:** 자금 상황 고려하여 6월 이후로 연기.\n * 가격표 재산출:** 인위적인 최저가보다 수식을 통한 리즈너블한 판매가 가이드 수립 (팀장 담당).\n * 업무 우선순위 조정:** '굿 디자인' 지원 사업보다 내부 운영 안정화 및 매출 증대 이벤트(5월 가정의 달) 선행.\n\n4. 향후 실행 과제 (Action Items)\n *가격 기준값 재설정 및 엑셀 수식화 / 대행사 이전 주도 (5월 초)\n * 업무 인수인계 및 사방넷-이지어드민 세팅 안정화 / CS 자동화 솔루션 프로세스 확정\n * 판매 데이터 분석(공구 실적 저조 원인 분석) / 제품 가격 관리 표 업데이트\n * 신규 인력 면담 및 채용 조건 확정 / 자사몰-GS-CJ 프로모션 MD 협상 지원"},
  {"id": "preset-m-2026-04-27", "date": "2026-04-27", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "", "content": "1. 마케팅 및 영업 현황\n와디즈 펀딩: 금요일 오전 9시 기준 1,500만 원(목표 대비 31%) 달성. 이번 주 추가 액션 진행 예정.\n메타(Meta) 광고: 광고 효율 극대화를 위해 과거 고효율 소재(2억 5천 달성 시기)를 참고하도록 담당 PD와 더블 체크 및 가이드 전달.\n고객 메시지: 다음 주 월요일, 전환율 향상을 위해 메시지 내용을 변경하여 최종 발송 예정.\n외부 협력: 쿠팡 미팅(권 과장 동행) 일정 조율 중. 광고 업체 3곳 비딩 진행 중(영상 수신 후 판단).\n\n 2. 제품 생산 및 물류 (Abler / Abler Zero)\n아블러(Abler) 생산: 이번 주 생산 완료 예정. 신규 색상부터 로고 위치 조정(5mm 하향) 적용. \n국내 입고:5월 20일경 물류 창고 입고 예정. 이후 조립 일정 진행.\n패키지 개발: 민트색 기성품 부재로 인해 화이트/민트 조합 검토. 나노 바나나(AI) 및 **힉스필드(Higgsfield)**를 활용해 시안 제작 후 결정.\n물류 비용 절감: 밑단 크기 및 포장 박스 규격이 배송비에 미치는 영향(누적 비용)을 고려하여 신중히 결정.\n\n 3. 운영 시스템 및 CS 고도화\n사방넷(Sabangnet) 도입: 세팅 마무리 단계(티딜, 현대Hmall 등). 이번 주 내 수지 대리와 협의하여 정식 사용 시점 결정.\n데이터 통합: 원보드(One-board) 시스템 개선을 위해 사방넷 API 연동 가능 여부 확인(매출 데이터 자동 취합 목적).\n채널톡 AI: AI 답변 기능 트레이닝 강화. 오답 발생 시 지속적인 수정을 통해 고도화 지시.\nCS 정책: 고객 만족 우선 원칙. 블랙 컨슈머를 제외하고는 구매 기한에 관계없이 유연한 교환/환불 정책 유지.\n전화 자동화: 010/070 번호 통합 및 효율적 관리를 위해 KT 서비스 또는 채널톡 AI 전화 비교 분석 후 보고.\n\n 4. 기타 프로젝트 및 공지\n공동 구매:최근 인스타/유튜브 공구 전환율 저조에 따른 방향성 재검토.\n카페24: 신규 도입된 '크리에이터 매칭 서비스' 검토 후 즉시 시행.\n지원 사업:'굿 디자인' 지원 사업 신청서 제출(4월 30일 마감 기한 확인 필요).\n일정 공지: 4월 29일(수) 피플스토리 전수조사로 인해 당일 제품 발송 불가 안내(오늘 중 공지)."},
  {"id": "preset-m-2026-04-23", "date": "2026-04-23", "title": "AMPM글로벌 광고대행사 미팅 요약", "attendees": "박지현", "directives": "", "content": "미팅 총평\nAMPM글로벌은 전체 퍼널 구조, 리타겟팅, 소재 개선, 보고 체계, 데이터 분석 방향 등은 비교적 체계적으로 설명하였고,\n현재 당사 광고 운영의 문제점인 CTR 하락, 장바구니 이탈, 구매 전환 저하에 대한 진단 방향도 어느 정도 맞게 짚은 것으로 보입니다.\n다만, 실제 운영 역량과 제안 신뢰도는 별도 검증이 반드시 필요한 상황입니다.\n\n1. 현재 광고 진단\n\n 1월~4월 데이터 기준, 전체 광고 효율은 유지되더라도 CTR(클릭률)이 하락하고 있어 소재 피로도 및 크리에이티브 개선이 필요한 상황으로 판단됨. \n장바구니 매출 대비 구매완료 매출 차이가 크게 발생하고 있어, 유입은 되고 있으나 구매 전환 단계에서 이탈이 큰 구조로 보임. \n 현재는 광고가 지속 집행되고 있어 ROAS는 유지될 수 있으나, 신규 유입 및 전환 구조 재정비가 필요한 상태로 정리됨. \n\n2. 제안받은 광고 운영 방향\n광고 운영은 아래 3단계 퍼널 구조로 제안받음.\n\n신규 유입 캠페인: 논타겟/관심사 기반으로 브랜드 및 제품 인지도 확보 \n장바구니/관심고객 리타겟팅: 장바구니 이탈자, 결제 직전 이탈자 대상 구매 전환 유도 \n재구매/확장 구매 캠페인: 기존 구매 고객 대상 연관 상품, 세트 상품 추가 구매 유도 \n\n추가로\n\n 애드부스트 \n 쇼핑 프로모션 \n 전환 집중 배너 \n 카탈로그 성과형 세팅 등을 병행 운영하는 방향으로 설명 받음.\n \n3. 소재/메시지 전략 방향\n\n 브랜딩 메시지, 제품 강점, 할인 프로모션, 후기/만족도 등 퍼널별 맞춤 메시지로 운영 필요 \n 현재 CTR 하락 원인 중 하나로 소재 부족 및 동일 소재 반복 사용 가능성이 높다고 봄 \n 향후 이미지뿐 아니라 실사용 콘텐츠, 인플루언서 영상, 활용형 레시피 콘텐츠 등을 광고 소재로 적극 활용하는 방향 논의 \n\n4. 자사 상황 공유 내용\n\n 기존 광고는 체계 없이 운영된 부분이 많았고, 예산 편차도 커서 정형화된 운영 및 보고 체계가 필요한 상황\n 내부적으로 광고 전담 인력이 부족하여 외부 대행사의 디테일한 관리가 필요한 상태\n 대표님 성향상 주간 단위 보고가 중요하며, 일별 데이터는 내부에서 업데이트 확인하는 방식이 효율적일 것으로 전달 \n 현재 주요 상품은 \n 듀오메이커 \n 아블러 \n 아블러 제로\n 3개 SKU 중심이며, 각 상품별 소구 포인트 재정리가 필요함 \n\n5. 상품/타겟 확장 아이디어 공유\n\n 듀오메이커는 단순 위스키 얼음이 아니라 커피, 우유, 막걸리, 팥빙수, 아이스크림 등 확장형 아이스 메이커 콘텐츠로도 활용 가능성 있음 \n 아블러 제로는 특히 40-50대 여성층 반응이 좋고, 세척 편의성과 직관성이 장점으로 보임 \n 여성 타겟에 대한 확장 가능성도 충분하다고 판단되어, 향후 콘텐츠 및 광고 방향에 반영 필요 \n\n6. 추가 논의 포인트\n\n 유튜브 쇼핑, 인플루언서, 공동구매, 라이브커머스 등과 연계 가능한 광고 확장도 함께 검토 필요 \n 경쟁사 분석 및 시장 내 포지셔닝 분석도 요청 \n 강민경, 빠니보틀, 전현무 등 브랜드 노출 이력 및 활용 가능한 레퍼런스 자산이 있으나, 현재 충분히 활용되지 못하고 있어 향후 우회적 활용 방안 검토 필요 \n\n7. 후속 액션\n\n 금일 광고 계정 권한 전달 후 현재 데이터 정밀 분석 요청 \n 예산안, 매체 운영안, 초기 집행 방향을 포함한 1차 제안안 별도 24일 금요일까지 수령 예정\n 내부에서는 광고 소재 및 콘텐츠 자산 정리 후 순차 전달 예정 \n이 후 진행 결정 여부 판단 예정."},
  {"id": "preset-m-2026-04-20", "date": "2026-04-20", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "", "content": "주간 업무 회의록 요약 (2026.04.20)\n\n1. 마케팅 및 영업 (Marketing & Sales)\n와디즈(Wadiz) 오픈 준비: 이번 주 목요일 오픈 예정이며, 사은품(집게) 및 2천 명 달성 시 아블러 추가 증정 콘텐츠 작업을 통해 오픈 준비를 강화함\n공동구매 진행\n블라썸' 채널(인스타/유튜브) 공동구매가 오늘부터 시작됨\n아들 속에 살아남기'는 소재 보강을 위해 내일부터 차주 화요일까지 진행 예정\nCJ 온스타일 및 기타 밴더사(브랜드 펀치 등) 제휴 상황 팔로업 중\n자사몰 개편: 스토리텔링 중심의 랜딩 페이지 컨셉을 정립하여 이번 주 내로 1차 기획안 보고 예정\n채널 확장: 사방넷 연동 점검, 폐쇄몰/기프트 몰 입점 완료, 신규 채널(티딜, 현대샵) 세팅 착수\n메타 광고: 중요도가 높은 만큼 이번 주 내로 광고 대행사 두 곳과 대면 미팅을 통해 업체 결정 예정\n\n2. 생산 및 물류 (Production & Logistics)\n아블러(Abler) 일정: 컬러 이슈로 인해 생산 완료가 약 일주일 딜레이되어 5월 초 완료 예상\n신규 컬러 샘플은 오늘 도착하여 검토 예정임\n아블러 추가몰드: 4월 말 입고 예정이며, 이지어드민 현 재고 업데이트 작업 중\n재고 및 발주: 오늘 오후 3시까지 실재고 파악을 완료하고, 듀오 메이커 추가 발주 수량을 확정하여 보고할 것\n패키지 리뉴얼: 쇼핑백 사이즈는 물류비 절감을 위해 듀오 메이커와 보관통이 들어가는 최적의 사이즈로 AI 시뮬레이션 후 최종 결정\n\n3. 인사 및 행정 (HR & Admin)\n채용: 오늘 오후 2시 콘텐츠 마케터 면접 진행.\nAMD 직무는 기존 지원자 중 적격자에게 지원 요청 중\n지원 사업: SK 스토어 지원 사업 성사에 따른 타임 스케줄 확인 및 '굿 디자인' 지원 사업 서류 작성 중\n계약: 미국 법인 관련 최종 계약서 상이한 부분 수정 요청 및 대표님 최종 확인 필요\n\n4. 대표님 주요 지시사항\n업무의 입체화: 회의록을 단순히 기록용으로 보지 말고, 타 부서 업무와 내 업무의 연관성을 체크하여 크로싱 점검할 것\n단순 업무 자동화: 서류 작업 등 단순 업무는 하급자에게 위임하고 팀장급은 핵심 업무에 집중할 것.\n향후 단순 업무는 AI 및 자동화 시스템으로 통합 예정임\n데이터 중심 보고: 데일리 매출 변동 폭이 큰 채널에 대해 재고 문제나 광고 효율 저하가 있는지 면밀히 분석 보고할 것"},
  {"id": "preset-m-2026-04-17", "date": "2026-04-17", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "", "content": "회의 요약 보고서\n\n1. 마케팅 및 프로모션 현황\n광고 효율: 현재 약 350만 원의 광고비를 집행 중이며, 아티스 지원금 50만 원을 포함해 운영하고 있습니다.오늘 중으로 유입 인원이 1,500명을 넘을 것으로 예상됩니다.\n체험단 및 공동구매\n체험단 10명 선정을 완료하여 제품을 발송했습니다\n차주에는 브랜드 커넥트를 통한 인스타그램/유튜브 공동구매(2건) 및 블로그 공동구매가 연달아 예정되어 있습니다\n와디즈(Wadiz): 4월 23일(목) 오픈 예정이며, 알림 신청자 사은품으로 제공할 '집게' 재고 750개를 확인했습니다\n부족분 약 2,000개에 대한 추가 발주를 검토 중입니다\nCJ 프로모션: 브랜드 소개서 업데이트 및 디자인 개편을 거쳐 컨펌 후 발송 완료했습니다\n\n2. 제품 및 물류/운영\n패키지 리뉴얼: 기존 박스 형태 대신 쇼핑백과 더스트백을 조합하는 방향으로 리뉴얼을 추진 중입니다\n쥬얼아이스 듀오 메이커, 글래스 등 3종 세트가 모두 들어가는 최적의 사이즈를 확정하여 최종 견적을 확인할 예정입니다\n아블러(Abler): 신규 색상 샘플이 DHL로 발송되어 월요일 도착 예정이며, 기존 화이트·블랙·블루 색상의 도색 작업도 독려 중입니다[cite: 33, 34, 35].\n사방넷 연동: API 매핑 작업이 몰별로 요구사항이 달라 수동 엑셀 작업을 병행하고 있으며, 사방넷 측과 소통하며 꼼꼼하게 진행할 계획입니다[cite: 13, 17, 30].\n\n3. R&D 및 기타 업무\n메뉴 개발: 아블러와 듀오 메이커를 활용해 우유, 콜라, 주스, 막걸리 등 다양한 음료를 한꺼번에 얼려 테스트하는 '품평회'를 월요일에 진행할 예정입니다\n시스템 효율: 외부 외근 업무 정리 및 AI를 활용한 통합 리포트 툴 비교 분석을 통해 회사에 맞는 시스템을 구축 중입니다\n\n---\n\n대표님 지시사항: 업무 방식의 혁신 (mop Structure)\n\n대표님께서는 최근 코딩 경험을 바탕으로 **전 세계 0.1% 수준의 일하는 방식**을 강조하셨습니다\n\n1.소통의 맥락(mop) 파악: 단순히 말을 주고받는 것을 넘어, 해당 메시지의 미닝(Meaning), 오더(Order), 포지션(Position)을 분석하여 컨텍스트를 클리어하게 이해해야 합니다\n2. 점·선에서 구조(Structure)로\nLibrary(점): 단순한 정보의 나열은 노이즈에 불과합니다\nFrame(선): 단순 연산이나 흐름이 생긴 단계입니다\nStructure(구조): 점과 선이 엮여 입체가 되고, 내가 없어도 돌아가는 서큘레이션(Circulation) 시스템을 만드는 것이 '진짜 일'입니다\n\n---\n\n차주 주요 일정\n4월 20일(월): 아블러 샘플 도착 및 음료 얼음 테스트 품평회\n4월 20일(월)~: 인스타그램/유튜브 공동구매 진행\n4월 23일(목): 와디즈 프로젝트 오픈\n참고: 성남 기업 성장 포럼은 연기되었습니다"},
  {"id": "preset-m-2026-04-16", "date": "2026-04-16", "title": "GS홈쇼핑 MD 미팅 요약", "attendees": "박지현", "directives": "", "content": "https://chatter-mountain-80e.notion.site/GS-MD-3440301561db800985b7e4651c4c29e5?source=copy_link"},
  {"id": "preset-m-2026-04-15", "date": "2026-04-15", "title": "협력사 현장 방문 요약", "attendees": "장정훈 박지현 권수지", "directives": "", "content": "https://chatter-mountain-80e.notion.site/26-04-15-3430301561db80c49a93f26f8cbac972"},
  {"id": "preset-m-2026-04-14", "date": "2026-04-14", "title": "정동우 대표님 미팅", "attendees": "장정훈 박지현", "directives": "", "content": "1. 현황 업데이트\n\n[ ABLR / 쥬얼아이스 ]\n- 현재 메인 제품 : 아블러 텀블러 (3-in-1)\n- 40mm 큐브 몰드 개발 중 → 6월 출시 예정 / 컵 + 몰드 세트 구성 판매 계획\n- 팀장 (온라인 15~20년 경력) 신규 합류 / 내부 정비 1~2개월 진행 중\n- 마케팅 디렉터 (캐나다·미국 출신 / Kickstarter 경험) : 기획 전담\n\n[ 해외 판매 현황 ]\n- Shopify + DHL 운영 중 → 배송비 15~20% 초과로 일시 중단\n- Meta 광고 계정 2회 해킹 피해 (각 400~4,000불 손실)\n- 킥스타터 과거 집행 : 광고비 약 6천만 원 / 총 매출 약 3억 원\n\n────────────────────────────────────\n\n2. 핵심 논의 : 해외 크라우드펀딩 전략\n\n[ 인디고고 (Indiegogo) — 주요 옵션 ]\n- 최근 보드게임 플랫폼 Backerkit에 인수됨\n- 전담 광고팀 신설 / 아시아 지부장 배치\n- 조건 : 초기 3,000불 선납 → 나머지 광고비 인디고고 선투자 후 정산\n- 플랫폼 수수료 : 5% (그 중 3%는 광고비로 재투자) / 카드 수수료 별도\n- 메인 배너·뉴스레터·캠페인 노출 무료 제공 (수천만 원 상당)\n- Meta 광고 대행 포함\n\n[ 킥스타터 — 보조 옵션 ]\n- 벤티스 (기존 대행사) → 광고비 후불 대출 가능성 검토 중\n- 기존 후원자 DB 재활용 가능 (업데이트 알림 자동 발송)\n\n[ 결론 ]\n- 인디고고 단독 또는 킥스타터 선행 → 인디고고 후행 투트랙 검토\n- 정동훈 대표가 비용·수수료 아웃라인 정리 후 마스터 측에 전달 예정\n\n────────────────────────────────────\n\n3. 제품 런칭 타임라인\n\n6월 중순   : 큐브 몰드 생산 완료 / 어쿠스틱드링크 유튜버 배송\n7월 초~중순 : 해외 크라우드펀딩 캠페인 오픈 목표\n캠페인 종료 후 : 인디고고 오픈 스토어로 상시 판매 전환\n\n- 촬영 일정 확정 후 역산 타임라인 수립 예정\n- 영상 제작비 : 과거 약 1,700만 원 / 현재 물가 반영 조정 필요\n- 정부지원금 활용 : 500만 원권은 영상 외 항목 / 200만 원권으로 영상 증빙 처리\n\n────────────────────────────────────\n\n4. 기타 논의\n\n[ 물류 ]\n- 첼로스퀘어 (삼성 계열) 추천 — 한국 주소 발송 시 해외 배송 일괄 처리\n- 미국행 : 800불 미만 개별 배송 시 관세 없음 (현재 유효)\n- 한-미 컨테이너 관세 : 35%\n\n[ 해외 채널 ]\n- 일본 마쿠아케 재진출 검토 — 과거 도요타상회 통해 월 3천만 원 실적 / 재접촉 고려\n- 대만 : 짝짝이 (현지 유통사) 통해 캠페인 진행 → 별도 유통 구조\n- 중국 소싱 : 정 대표 측 네트워크 연결 가능 → 검수·소싱 협업 논의\n\n[ 보안 ]\n- Meta 광고 계정 : 구글 OTP 외 별도 인증 앱 권장\n- 이메일 계정 분리 필수 (이메일 탈취 시 OTP도 함께 탈취 가능)\n\n────────────────────────────────────\n\n5. 액션 아이템\n\n[ 마스터마인딩 ]\n- 제품 시제품 샘플 확보 (듀오메이커 / 스피어 몰드)\n- 촬영 일정 확정 → 역산 타임라인 수립\n- 인디고고 vs 킥스타터 투트랙 여부 최종 결정\n\n[ 정동훈 대표 ]\n- 펀딩 목표 30~50만 불 기준 비용 구조표 송부\n- 기존 계약서 + 수수료 비율 업데이트 후 전달\n- 주차별 타임라인 공유"},
  {"id": "preset-m-2026-04-13", "date": "2026-04-13", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "", "content": "1.마케팅 및 영업 진행 상황\n* 신규 업체와의 소통을 지속하며 프로모션 계획을 수립하고 있습니다\n* 콘텐츠 마케팅은 현재 일시 중단된 상태로, 수치를 점검하고 지표를 정리 중입니다\n* 이번 주 내로 광고 대행업체 활용 등 새로운 광고 방향성을 모색할 예정입니다\n* 기존 채널 프로모션은 계속 진행하며, 이번 주부터 온라인을 시작으로 오프라인 B2B 입점도 추진합니다\n* 브랜드 커넥트 공동구매와 관련하여 고정비 20만 원에 수수료 20% 조건으로 제안하여 두 곳과 다음 주 초 진행을 앞두고 있습니다\n* 구독자 60만 명 규모의 인플루언서가 콘텐츠 제작비를 별도로 요청하여, 내부 보고 후 진행 여부를 결정할 예정입니다\n* 금요일에 논의된 방향성에 맞추어 블로그의 불필요한 글을 삭제하고 내용을 추가하는 등 대대적인 개편 작업을 내일 오전까지 진행합니다\n\n2.재고 관리 및 발주\n* 4월부터 적용되는 가격표, 프로세스, 투자 검토 및 액션 플랜이 최종 수정되어 지정된 폴더에 업로드되었습니다\n* 잔디 메신저를 통해 해당 문서들의 링크를 공유할 예정입니다\n* 글라스 잔 입고 물량은 어쿠스틱용 1,000개 외에 채널용으로 500~1,000세트를 추가 진행하는 것을 대표님과 최종 정리할 계획입니다\n* 2주 전 납품된 스틱 보관통의 결제와 아이스볼 보관통의 입고 처리가 오늘 진행됩니다\n* 사방넷 관련 업무와 글라스 잔 발주가 이번 주에 계속 진행됩니다\n* 아블러의 신규 컬러 제품이 이번 주 내로 DHL을 통해 입고될 예정입니다\n\n3.패키징 및 디자인\n* 아이스볼 보관통은 패키지 형태로 납품되지만, 스틱은 패키지에 들어가지 않아 별도로 처리해야 합니다\n* 어쿠스틱 측에서 칵테일 세트를 하나의 박스에 담아달라고 요청했으나, 당사는 자체 개별 박스를 유지하는 방향으로 회신했습니다\n* 어쿠스틱 외통의 폰트 색상을 더 진하게 변경해 달라는 요청이 있어 조율 중입니다\n* 어쿠스틱의 실링 스티커 인쇄를 위해 팬톤 컬러 코드가 아닌, 기존 패키지 제작에 사용된 정확한 컬러 코드를 요청한 상태입니다\n*여러 제품을 하나의 박스에 모두 담는 패키징은 고객 선호도가 낮으므로, 개별 박스를 유지하되 쇼핑백 등으로 전체를 묶어 추가 구매를 유도하는 방향으로 기획 중입니다\n\n4.기타 업무 및 공지 사항\n* 대표님은 주말 동안 마케팅 관련 정리 자료를 공유하셨습니다\n* 영상을 시청하기 전, 노트북 LM을 활용해 내용을 먼저 요약해서 보면 훨씬 빠르게 이해할 수 있다는 의견이 공유되었습니다\n* 대표님은 클로드 코드와 같은 새로운 툴을 도입할 때, 사용 전 1~2시간 정도 매뉴얼을 충분히 숙지하는 것이 중요하다고 강조하셨습니다\n* 이번 주 수요일 일정을 위해 참석자들의 출발 시간을 미리 취합하기로 하였습니다"},
  {"id": "preset-m-2026-04-10", "date": "2026-04-10", "title": "주간회의", "attendees": "장정훈 박지현 권나경 권수지", "directives": "", "content": "1. 재고·물류\n\n실제 재고는 있으나 시스템 반영이 안 되어 발주 오류가 발생함.\n물류사 방문 시 원인 파악, 재발 방지, 책임소재 명확화를 목표로 진행하기로 함.\n실재고 파악 후 사방넷 기준으로 재고 알림 시스템을 구축하는 방향으로 정리됨.\n\n2. 상품·발주\n\n글라스잔은 단품보다 세트 판매가 수익성에 유리하다고 판단.\n듀오 컬러박스는 5천 개 먼저 발주하고, 이후 추가 발주하기로 함.\n실링 스티커는 재고 확인 후 필요한 시점에 맞춰 발주하기로 함.\n\n3. 추석/B2B 준비\n\n추석 및 B2B 제안 일정은 기존 계획보다 더 앞당겨야 한다고 정리됨.\n4월부터 제안 자료와 이미지, 구성안을 준비해 조기 영업에 활용하기로 함.\n\n4. 브랜드·패키지\n\n쥬얼아이스 브랜드 컨셉을 “음료의 마지막 보석”으로 정리.\n패키지와 홈페이지 톤앤매너는 프리미엄, 보석 이미지 중심으로 가기로 의견이 모임.\n\n5. 마케팅·채널\n\n광고는 브랜드 인지용과 제품 판매용을 나눠 운영하는 방향.\n브랜드 커넥트, 공동구매, 스마트스토어 등 성과가 나는 채널에 더 집중하기로 함."},
  {"id": "preset-m-2026-04-07", "date": "2026-04-07", "title": "주간회의록", "attendees": "참석자 박지현 CJ 주방가전 총괄 안정균", "directives": "", "content": "1. 현재 온라인 정상가로 오픈된 상태이며, 추가 프로모션도 진행하는 방향으로 이야기되었습니다.\n\n2. 총괄 MD가 직접 방송, 공동구매, 프로모션 등을 함께 추진할 수 있는 방향으로 이야기되었습니다.\n\n3. CJ 측은 공동구매/SNS 운영이 활발한 편이고, 공동구매도 수수료 30% 조건으로 진행 가능하다고 하여\n   현재 저희가 개별적으로 진행하는 구조 대비 광고비 부담 없이 확장성 있게 운영할 수 있는 조건으로 보입니다.\n\n4. 특히 공동구매 셀러들도 결국 CJ 타이틀을 걸고 들어오는 구조이기 때문에, 저희가 자체적으로 개별 셀러를 붙이는 것보다\n신뢰도, 규모감, 진행 안정성 측면에서 훨씬 유리한 방식으로 보입니다. 내부적으로 공동구매 운영이 아쉬웠던 부분도 이 방향이면 충분히 풀어볼 수 있을 것 같습니다.\n\n5. 미팅 중 제품 운영 방향에 대해서는 현재 자사몰 매출이 인플루언서/유튜브 쇼핑을 통해 유입되고 있고,\n   인스타그램 등 SNS에서도 쥬얼아이스 검색 시 반응과 데이터가 어느 정도 확인된다는 이야기가 있었습니다.\n   판매 채널 확장 방향 자체도 나쁘지 않게 보고 있었습니다.\n\n6. 판매 방식은 방송형이 가장 적합하다는 쪽으로 의견이 모였습니다.\n   저희 제품은 특성상 사용감과 활용 장면을 직접 보여줘야 반응을 끌 수 있는 상품이라 종합몰 방송이나 모바일 라이브처럼 보여주는 판매 방식이 더 맞다는 반응이었고,\n   MD도 이 부분에 공감하여 모바일 방송 쪽으로 한 번 구체화해보자는 방향으로 이야기되었습니다.\n\n7. 추가로 대표님이 진행 중이신 확장 방향도 간단히 공유드렸고, 향후 CJ 쪽 행사나 외부 진행 건과 연결될 수 있는 가능성도 있어 보였습니다.\n\n8. 다만 향후 CJ뿐 아니라 방송, 공동구매, 라이브 등 대외 채널을 본격적으로 진행하려면 시험성적서, 특허증 등 서류로 증빙 가능한 자료들은 미리 정리해둘 필요가 있어 보입니다.\n기회가 언제 먼저 열릴지 모르는 만큼 이 부분은 선제적으로 준비해두는 것이 좋을 것 같습니다.\n\n전체적으로 이번 미팅은 주방가전 총괄 MD와 직접 연결되었고, 공동구매 가능성 확보, 방송 방향성 확인, CJ 채널 활용 가능성까지 확인된 긍정적인 미팅으로 보입니다."},
  {"id": "preset-m-2026-04-06", "date": "2026-04-06", "title": "회의록", "attendees": "참석자 장정훈 박지현 권나경 권수지 조송희", "directives": "", "content": "1. 이번 주 핵심은 실재고 최종 점검, 세무회계 시스템 세팅, 가격/행사/구성안 확정입니다.\n2. 와디즈는 현재 알림받기 오픈 상태이며, 실오픈은 4/22~23 전후 예정입니다.\n3. 광고는 네이버는 효율 양호, 반면 메타는 유입 감소로 매출 하락이 있어 재점검이 필요합니다.\n4. 사방넷은 이번 주까지 상품 연동 완료 목표로, 기존 코드 정리 후 신규 코드 중심으로 재운영합니다.\n5. 어쿠스틱 드링크 협업은 세트 박스 없이 진행하고, 컵/얼음은 분리 판매 방향으로 정리됐습니다.\n6. 협업 패키지는 하얀 박스 + 띠지/실링 스티커 방식으로 브랜드 노출만 강화하기로 했습니다.\n7. 티코스터는 제외하고, 글라스잔/실링스티커는 견적 후 부자재와 함께 발주 예정입니다.\n8. 공동구매는 수요일까지 진행하며, 현재 매출은 약 30만 원 미만이고 다른 채널 제안도 병행 중입니다.\n9. 디자인은 화요일까지 시안 3개 목표이며, 박스 작업 우선 후 부가세 자료 정리를 이어갑니다.\n10. 조 대리는 오늘부로 업무 마무리, 팀은 주간계획·성과관리·KPI 중심으로 운영을 강화합니다."},
  {"id": "preset-m-2026-03-30", "date": "2026-03-30", "title": "회의록", "attendees": "참석자 박지현 권나경 권수지", "directives": "", "content": "1. 쇼핑몰 상품 등록 (이번 주 마감)\n-사방넷 세팅 완료된 신규 몰 우선 연동 및 상품 전송\n-리멤버 쇼핑몰 수기 등록 및 유튜브 쇼핑 매핑 오류 사방넷 문의\n\n2. 광고 대행사 이관 및 매출 관리\n-오늘 오후 신규 대행사로 광고 이관 및 사전 컨펌 프로세스 도입\n-이번 주 금요일 이지어드민 기반의 새 통합 매출 양식 배포 및 가이드\n\n3. 물류 및 재고 (4월 8일 물류사 미팅)\n-정확한 월 마감을 위한 정기 재고 실사 및 부자재 관리 강하게 요청\n\n4. 쥬얼아이스 제품 개발 및 발주\n-아블러 매트한 느낌의 신규 컬러 샘플(컬러당 3가지) 공장에 재요청\n-어쿠스틱 드링크 글라스 발주 진행 및 아이스볼 보관통 이번 주 입고\n-발바닥 얼음틀 실리콘 얼려본 후 상태 테스트 진행\n\n5. 마케팅 및 자사몰 개편\n-수요일 아블러 제로 블로그 공구 진행 및 신규 플랫폼 인슈퍼 입점 구조 전화 문의\n-B2B 각인 및 브랜드 스토리 메뉴 중심의 자사몰 리뉴얼 기획 (필요시 외주 검토)"},
  {"id": "preset-m-2026-03-23", "date": "2026-03-23", "title": "회의록", "attendees": "", "directives": "", "content": "1. 영업/운영\n채널 입점 확대 신청을 진행했고, 입점 완료 채널부터 순차적으로 프로모션 시작 예정\n사방넷 연동 및 운영 양식 정립을 진행하며, 수요일부터 신규 인력과 함께 데이터 체계화 예정\n발주/상품관리 시스템은 당분간 이지어드민과 사방넷을 병행 운영하고, 전환 시점은 별도 날짜를 정해 안정적으로 이전하기로 함\n2. 상품/물류\n상품명·정상가 기준을 재정리해 사방넷 공통 운영 기준으로 맞출 예정\n썸네일·상세페이지는 최종본 중심으로 정리 필요\n재고 부족 상품 2,400개 조리 완료 후 입고 반영 예정이며, 물류 측에 빠른 입고 처리를 요청하기로 함\n아블러 몰드는 생산 진행 중이며, 4월 말 일정 기준으로 지속 관리 및 인수인계 강화 필요\n3. 마케팅/광고\n메타 광고는 현재 재가동 중이며, 듀오메이커 입고 시 메타·쿠팡·네이버 광고도 즉시 활성화 예정\n광고 효율 회복을 위해 광고 소재를 지속적으로 사전 제작·축적하기로 함\n광고 소재는 AI뿐 아니라 실촬영 기반 콘텐츠를 적극 확대하고, 장소·연출·출연 방식도 다양화하기로 함\n4. 콘텐츠/브랜딩\n브랜드 커넥트·태그바이 체험단 원고 검수 후 마무리 예정\n공동구매 일정은 4월 1일로 연기\n어쿠스틱 콘텐츠는 이번 주 토요일 업로드 예정이며 가격 세팅 반영 예정\nSNS 콘텐츠는 월간 보고 체계로 관리하며, 앞으로는 도달·노출·조회 수치를 함께 정리하기로 함\n4월부터는 보다 공격적으로 대표 캐릭터 활용 콘텐츠 실험도 검토 예정\n5. 조직/인수인계\n신규 인력은 수요일 출근 예정이며, 이번 주는 실무 병행형 인수인계로 진행\n주문량 증가 가능성에 대비해 초기에는 팀장과 기존 인력이 함께 핸들링 필요\n반복 업무는 체계화해 줄이고, 성과를 내는 업무에 더 많은 시간을 쓰는 방향으로 조직 운영 방침을 공유함\n6. 대표 전달사항\n최근 경제 상황을 고려해 매출 회복과 효율 중심 운영이 중요하다고 강조\n내부적으로는 부정적 언어·분위기 확산을 지양하고, 어려운 점은 대표 및 팀장과 직접 소통하도록 요청\n이번 주 최우선 과제는 메타 광고 효율 개선과 매출 정상화로 정리됨"},
  {"id": "preset-m-2026-03-20", "date": "2026-03-20", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "- 신규 입점은 오늘까지 신청 마무리, 현황은 별도 시트로 정리해 공유\n- 내부 데이터 양식은 금주 중 최종 정리, 와디즈는 재확인 진행\n- 메타 광고는 일부 노출은 있으나 정상 운영 지연 중으로 계속 점검 필요\n- 듀오메이커는 다음 주 화요일 생산 완료, 24일 입고 후 25~26일 판매 준비\n- 쇼핑몰 연동은 완료, 카테고리/상품 등록 및 프로모션 기획 진행\n- 어쿠스틱 드링크 프로모션은 복잡하게 가지 말고 심플하게 구성하는 방향 검토\n- 광고/콘텐츠 보고서와 협업 제안서는 정리 후 다음 주 공유\n- 올해 업무 보고는 실무진→팀장→대표 체계로 통일, 대표님은 사업계획서, 자금 조달, 인력 보충에 집중 예정"},
  {"id": "preset-m-2026-03-09", "date": "2026-03-09", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 지금 진행 중인 것\n- 아블러 조립·재고 반영 진행 중\n- 듀오메이커 외통 인쇄 및 납품 진행 중\n- 신규 컬러는 MOQ 1,500개까지 협의 완료\n- 사방넷은 이번 주 안에 세팅 완료 목표 \n- 와디즈는 수수료 조건 회신 대기 중\n\n2. 결정이 필요한 것\n- 외통을 단색(브라운/네이비 등)/이미지로 진행할지\n- 와디즈에서 아블러 중심으로 갈지, 듀오메이커 비중을 얼마나 둘지\n\n3. 이번 주 해야 할 일\n- 신규 컬러 SNS 투표 운영\n- 사방넷 세팅 마무리\n- 외통 인쇄 가능 업체 추가 확인\n- 와디즈 피드백 오면 상품 구성·가격 재정리"},
  {"id": "preset-m-2026-03-05", "date": "2026-03-05", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "핵심 요약\n- 아블러는 기존 실버 재고를 고려해 실버는 제외하고, 신규 컬러 1~2종을 추가 검토하기로 했습니다.\n- 와디즈는 아블러를 메인으로, 듀오는 옵션형 서브 구성으로 검토하는 방향이 유력합니다.\n- 3월 인플루언서 진행, 메타 광고 세팅, 재고·금형·디자인 시안 작업이 주요 실행 과제로 정리됐습니다.\n\n---\n1. 제품/생산\n- 아블러 텀블러는 실버 재고가 있어 실버는 제외하고, 여성 타깃에 맞는 신규 컬러 1~2종 추가를 검토하기로 함.\n- 전체 발주 수량은 5,000개 기준, 신규 컬러 추가 시 6,000~7,000개까지도 가능한 방향으로 논의.\n- 생산 리드타임은 생산 약 1.5개월 + 운송 2주 + 통관 2주, 총 약 3개월 여유로 파악.\n- 신규 컬러는 내부 후보안 4~5개 먼저 선정 후, 이후 SNS 투표로 검증하는 방식으로 진행.\n- 큐브 화이트 재고 부족 원인과 출고 경로는 추가 확인 필요.\n- 듀오 관련 모서리 라운딩 수정은 이번 차수 반영은 어렵고, 다음 회차 금형 수정 비용 확인 후 결정 예정.\n\n2. 마케팅/와디즈/인플루언서\n- 3월 인플루언서는 어쿠스틱 채널 3월 28일 진행 확정.\n- 4~5월에는 추가 인플루언서 협업 가능성 검토.\n- 최근 미스터 위스키 성과가 기대 이상이었고, 이유는 제품 스토리와 사용 설득력이 강화됐기 때문으로 분석.\n- 와디즈는 아블러를 메인 상품으로 두고, 듀오는 옵션형 서브 상품으로 구성하는 안이 가장 효율적이라는 의견이 우세.\n- 와디즈는 직접 매출뿐 아니라 신규 유입 확보 및 브랜드 노출 확대용 마케팅 채널로도 의미가 있다는 판단.\n\n3. 디자인/콘텐츠\n- 컬러 검토는 말로만 논의하지 말고, 실제 시안 이미지로 빠르게 공유해서 의사결정 속도를 높이기로 함.\n- 아블러 텀블러 신규 컬러 시안과 어쿠스틱 협업용 로고/디자인안은 이미지 시안 우선 제작 후 피드백 받는 방식으로 진행.\n- SNS용 콘텐츠는 대표 참여 촬영 건 포함, 아이디어를 시안/영상 형태로 먼저 만들어 전체 공유하기로 함.\n\n4. 신규 사업 검토\n- 별도 브랜드로 준비 중인 제품은 샘플·상표등록·패키지 디자인까지 상당 부분 진행된 상태.\n- 다만 담당자 퇴사로 멈춰 있었고, 시장성은 있으나 신중하게 접근하기로 함.\n- 필요 시 기존 콘셉트 외에 진입장벽이 낮은 형태로 변형 런칭하는 방안도 검토.\n\n5. 운영 이슈\n- 메타 광고 관리자 관련해서는 일부 인원 PC에서 접속/관리자 권한 오류가 발생 중이며, 별도 점검 필요.\n- 재고 입고 수량, 다음 주 납품 가능 수량, 금형 수정 견적 등은 추가 확인 후 공유 예정."},
  {"id": "preset-m-2026-03-03", "date": "2026-03-03", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "I. 한 줄 결론 \n이번 주는 “광고 증액 테스트 + 재고/발주 정리 + 아블러 제로 신규 판매 채널 실험\n\nII. 핵심 의사결정\n1. 광고 확대\n- 미스터 위스키 유입 성과가 확인되어, 메타 광고를 25만~30만 원 수준까지 점진 증액하고 리타겟팅 중심으로 운영하기로 함. \n2. 제품 개발 방향 확정\n- 신규 얼음 몰드는 테스트 결과를 바탕으로 40mm 기준으로 설계 진행하기로 함. AI 데이터보다 실물 테스트 기준을 우선 적용. \n3. 재고/생산 우선 대응\n- 재고 부족 SKU가 있어 이번 주 내 전체 재고를 다시 파악하고 추가 생산 발주하기로 함.\n- 일부 SKU는 품절 상태 점검 및 판매 상태 조정 필요. \n4. 아블러 제로 판매 활성화\n- 판매가 주춤해 광고 소재를 새로 제작하고,\n- 인스타 공동구매/시딩을 약 100만 원 예산으로 테스트하기로 함. \n5. 외부 협업 및 소싱 후속\n- 목요일 와디즈 미팅 전 사전 협의 후 진행\n- 닐링 체어는 현재 샘플 완성도가 낮아 수정 샘플 확인 후 최종 판단하기로 함. \n\nIII. 대표님 확인 필요 사항\n- 메타 광고 증액 범위와 속도\n- 40mm 몰드 기준 확정 후 다음 개발 단계 진행 여부\n- 아블러 제로 시딩/공구 테스트 예산 집행\n- 와디즈 미팅 전 우선 제안할 아이템 선정\n- 닐링 체어 수정 샘플 통과 기준 설정"},
  {"id": "preset-m-2026-02-27", "date": "2026-02-27", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 찰스 대표님 확인 필요\n- 미스터 위스키 썸네일 최종 선택\n- 브릭스 진행 여부 검토\n\n2. 박지현 팀장님\n- 다음 주 대표 보고자료 준비\n\n3. 이호혁 차장님\n- 광고 소재 여분 확보 운영 지시\n\n4. 권나경 과장님\n- 미스터위스키 가편집본 수정 요청 전달 (미스터 위스키 목소리 볼륨 키우기 / 어색한 확대 장면 삭제)\n- 샘플 재작업 및 포장 변경 진행 상황 확인\n- 아블러 제로 공동구매/벤더사 후보 계속 확인\n\n5. 조송희 대리\n- 듀오 / 아블러 제로 광고 소재 제작\n- SNS 컨텐츠 업로드 진행\n- SNS 리포트 보완 및 다음 주 공유 준비"},
  {"id": "preset-m-2026-02-23", "date": "2026-02-23", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "권과장님 (실무 진행/현황 공유, 우선순위/리스크·의사결정 정리)\n- 금요일 업로드 목표(랜딩·썸네일 준비)\n- 촬영 제품 우선순위 조정(큐브 부족 → 스피어 중심)\n- 상세페이지/GIF 다플랫폼 적용 이슈 및 피그마 구현 한계 공유\n- 징소싱 샘플 품질 문제·비용 공유, 반값 재샘플 제안\n- 글라스 발주 계획/단가 조건, 스틱·사이즈 회신 대기\n- 외통 컬러 테스트 필요\n- Nabbi 계약 해지 방향 + 계정 삭제 여부 명확화(리스크 관리)\n- 업로드 일정 현실성 점검(연휴 고려)\n- 큐브 몰드/재고 확인 지시\n- 상세페이지/GIF는 대표님 컨펌 후 전체 플랫폼 적용\n- 샘플은 대표님 체험 후 Go/Stop 판단 필요\n\n조대리 (광고·SNS 운영/지표 체계)\n- 광고 소재 2~3개 우선순위 제작/개선\n- 핵심지표 + 매출 포함 트래킹 시트 구축 및 대표 공유 제안\n- ‘주유소 채널’ 운영안: 월 10만 원으로 예산 감액하여 1개월 주 1회 목요일 업로드*4회하여 테스트, 시청완료율 개선 중심\n- 주얼아이스 소개서 : 권과장님 이관 가능"},
  {"id": "preset-m-2026-02-19", "date": "2026-02-19", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "A. 제품/개발\n스틱(약 9cm) 투명도 이슈 원인 테스트: 뒤쪽 조건(차폐/막음) 여부에 따라 하단이 뿌옇게 되는지 확인\n테스트 2개 정도 진행 후 ‘월요일’에 보고/결정\nB. 마케팅/광고 운영\n네이버 검색광고 자동충전이 꺼져 3~4일 중단 → 오늘 재세팅\nGFA는 조치 후 정상화, 메타도 다시 세팅된 상태로 모니터링 필요\n오늘~내일 성과 보고, 주말 효율 좋은 캠페인은 증액 검토\nC. 샘플/외주(품질 이슈)", "content": "1) 결정/방향(Decision)\n- 어쿠스틱 요구가 “40×40”이면 그 규격을 우선 존중(사용자 입장에선 40이 의미 있고 43은 의미가 약하다는 의견)\n- 다만 65ml(큰 잔) 기준으로는 43이 더 적합할 수 있다는 내부(AI) 분석도 함께 전달하고, 상대 의견 받아 최종 수용하기로 함\n- 몰드 결과물은 “3개(얼음 3개)” 구성으로 언급\n\n2) 실행 과제(Action Items)\nA. 제품/개발\n- 스틱(약 9cm) 투명도 이슈 원인 테스트: 뒤쪽 조건(차폐/막음) 여부에 따라 하단이 뿌옇게 되는지 확인\n- 테스트 2개 정도 진행 후 ‘월요일’에 보고/결정\nB. 마케팅/광고 운영\n- 네이버 검색광고 자동충전이 꺼져 3~4일 중단 → 오늘 재세팅\n- GFA는 조치 후 정상화, 메타도 다시 세팅된 상태로 모니터링 필요\n- 오늘~내일 성과 보고, 주말 효율 좋은 캠페인은 증액 검토\nC. 샘플/외주(품질 이슈)\n- 샘플이 마감(코팅/도장)·포장 상태가 매우 불량이라 강하게 컴플레인 중, 개선 가능 여부 추가 소통\n- 중간업자(징소싱) 구조로 보이며, “현장 방문/간다”는 메시지로 압박 필요 언급\n\nD. 콘텐츠/캠페인 일정\n- nabbi 영상: 내일 저녁 업로드 방향\n- 미스터 위스키: 초안(오늘/내일) → 다음 주 말(금요일쯤) 업로드 목표, 큐브 몰드 오늘 발송 예정\n- 어쿠스틱: 3월 일정 재확인 요청\n\n3) 공유/후속 전달\n- 잔디에 올린 닐링 체어 상품 소개서를 와디즈 PD에게 전달 요청\n- 대표님은 이동이 어려워 당분간 재택(이번 주~다음 주) 가능성 언급 + 월요일 박지현 팀장 합류, 자리 정리 요청"},
  {"id": "preset-m-2026-02-09", "date": "2026-02-09", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 이번 주 우선순위: 구정 전 재고·생산 관리 + 광고 세팅 완료(연휴 매출 유지)\n2. 성과 좋은 광고 20%내에서 증액\n3. 쿠팡 상세 GIF/영상이 노출이 들쭉날쭉 → 유튜브로 최신 정책/업데이트 확인하고, 안 보일 때 대체안 준비\n4. 유튜브 쇼핑 상세도 이번 주 개선(전일 30만원 매출 사례)\n5. 각인 이벤트: 20종을 3카테고리로 묶어 댓글 투표, 오늘~2/22, 당첨자 3명(아블러 제로)\n6. “쉽게 빼는 법(탈형)” GIF/영상도 상세/콘텐츠로 제작 (구정 이후)"},
  {"id": "preset-m-2026-02-02", "date": "2026-02-02", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 에버런스 메타 대행 종료 / 직접 운영 및 소재 제작 업무 추가(조송희 대리)\n2. gfa 담당자 관련 이슈 사항 전달(개선점 및 담당자 변경 요청했으나 아직 회신 안옴)\n3. 이지어드민 재고 품절 전에 미리 조립 및 생산되어 품절 안나도록 관리운영\n4. 어쿠스틱 드링크 전자계약 진행 예정 / 미스터위스키 업로든 날짜보고 계약서 작성 / 술익는집 추후 하반기 매출보고 진행여부 결정(수수료 및 RS 너무 비쌈)\n5. SNS 각인 이벤트 / UGC 진행\n6. 아블러제로 관련 개선점 및 추가 컬러 신제품 출시 필요함 / 개선점(뚜껑 열림,잘안열림 / 플라스틱 유리 분리 / 플라스틱 유리 사이 고무패킹 이물질 낌 등)"},
  {"id": "preset-m-2026-01-30", "date": "2026-01-30", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1)소싱\n-와인병 조명 / 안새는 텀블러 샘플구매\n-향수 가습기 / 차고 열쇠고리 대표님 확인 필요\n-정과프로젝트 패키지 디자인 투표 중 / 상세페이지에 패키지 디자인 수정 \n\n2)인플루언서\n-나삐위스키 1월 29일 계약서 전달(해외에 있어서 한국오면 회신 예정)\n-홈텐딩백과-띠동갑바텐더 해당 유튜버 AI 성과 돌린 후 진행 여부 결정(롱폼 500만원)\n-미스터위스키 2월 말 3월 초(아블러) 예정 및 1월 31일부로 기존계약 종료 / 술익는집 3천만원 OR 2천만원 + RS / 어쿠스틱 계약서 수정 진행 중\n\n3)주말 광고 진행 계획\n-메타 총 일예산 22만원 (아블러 6 / 듀오 8 / 아블러제로 8)\n(아블러제로(쇠맛X여자2)OFF / 아블러제로(쇠맛X여자) 해당 소재 전환 반응보여 광고비 추가 사용)\n(김동현 선수 밈 활용한 광고소재 테스트 진행 중 / 주말간 신규 광고소재 테스트 진행)\n-GFA 광고 일예산 증감액없이 15만원으로 주말간 유지(월말 영향으로 차주 증액 검토)\n\n4)고객 CS 특이사항\n-아블러 뚜껑 안열림 OR 잘열림 / 내부 유리 파손(교환건) / 뚜껑을 닫아도 물이 샘 / 내부 유리와 외부 플라스틱 분리됨\n-최근 피플스토리 재고 오류로 아블러 볼 화이트 / 아블러 스피어 화이트 출고 미진행으로 CS 3건 접수됨\n(현재는 오류 해결 / 아블러 볼 화이트 전산재고 10개였으나 실재고 0개 / 아블러 스피어 화이트 전산재고 10개엿으나 실재고 20개 문제로 배송 지연확인됬으며, 피플 측에서 작업담당자가 팀장께 전달하지못해서 발생한 사건, 총 미발송 13건 전부 배송완료)\n-피플 아블러 볼 화이트 품절로 모든 플랫폼 아블러 볼 화이트 품절 저리 / 쿠팡 로켓그로스 발송\n\n5)특이사항\n-아블러 명절관련 각인 이벤트 진행(조송회 대리 차주 진행)\n-CS 대표님 인터뷰 유튜브 / 인스타 두군데 다 업로드"},
  {"id": "preset-m-2026-01-26", "date": "2026-01-26", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 네이버 ai방송 관련 아블러제로로 팔로우업\n2. 미스터위스키 큐브 듀오메이커 제작일정 물어봄 / 어쿠스틱 드링크 금형 신규 제작\n3. 정과 프로젝트 \"넛넛\"으로 결정, 금일 패키지 투표 업로드 예정\n4. 주유소 유튜브 채널 화요일 무알콜 막걸리 촬영 예정\n5. 메타 소재 미리 제작 필요 / 소재 중단 안되도록 계속 제작 요청 푸시"},
  {"id": "preset-m-2026-01-19", "date": "2026-01-19", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.에버런스 및 원정대 주간 광고 운영 계획관련 내용 회의 때 공유\n2.인플루언서 섭외 관련 상반기 계획 잡고 진행\n3.\"한국전통주하이볼\" 유튜브 채널 개설 및 주 최소 1회 영상 업로드 필요 / 기획안 작성\n4.정과 및 모든 영상 컨텐츠 관련 대표님 직접 영상 노출 후 컨텐츠 참여\n5.대표님이 참여한 브랜드 이미지와 브랜드 철학 회사 방향에 대한 오픈 토킹 기획"},
  {"id": "preset-m-2026-01-13", "date": "2026-01-13", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 메타 광고 아블러/듀오 이미지 배너도 제작 에버런스 요청\n2. 리퍼 블프 자사몰 미노출 / 광고로만 유입 진행\n3. 2026년 마케팅 캘린더 제작 후 해당 행사에 맞도록 참여형 컨텐츠 및 각인 몰드 제작\n4. 영상 세부 기획안 및 잔디 컨텐츠 방에 아이디어 공유 \n5. 닐링체어 주문 3건 발송 예정 및 닐링체어 DIY 관련 내용 사이트 공지 필요"},
  {"id": "preset-m-2026-01-09", "date": "2026-01-09", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.전직원 KPI 전달\n2. 주간 업무 공유\n3. 인플루언서 섭외 관련 구글 닷 등 제작 \n4. 영상 컨텐츠 제작 관련 아이디어 발표"},
  {"id": "preset-m-2026-01-05", "date": "2026-01-05", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.유튜버 연간 계약관련 진행(술익는집/어쿠스틱 드링크)\n2.연간 매출 확인 및 2026년도 목표매출 \n3.블프,리퍼 상품 금주 유지 \n4.쿠팡에이전시 대행사 확인(박지선대리)\n5.금주 수요일 광고 소재 제작 기획안 확인(조송희대리)"},
  {"id": "preset-m-2025-12-29", "date": "2025-12-29", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 내년 매출 전략 계획 수립 및 아마존 입점 진행(이호혁 차장)\n2. 아블러제로 금주 중 입고 / 마이픽셀 공동구매 및 벤더사 컨택 / 제이파이 신년 인사 및 내년 광고 일정 등 인플루언서 관리 / 닐링체어 구매평 2명씩 5번 진행(권나경 과장)\n3. 타입퀘스트 대표님 목소리 tts 변환 여부 / 원해 프로그램 crm 템플릿 검수 / 구글애즈 29일 off(박지선 대리)\n4. 주간 업무회의"},
  {"id": "preset-m-2025-12-22", "date": "2025-12-22", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.연말 모든 광고 진행 매체 일예산 재 셋팅\n2.스마트스토어 crm 마케팅 알림받기 관련 정보 탐색(박지선대리)\n3.주간업무회의"},
  {"id": "preset-m-2025-12-11", "date": "2025-12-11", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.META 광고 아블러제로 블랙로 소재 재제작하여 라이브(박지선 대리)\n2.콘텐츠 제작업무에 쥬얼아이스에 관한 주제 모두 작성하여 인원별 주제 겹치지않도록 관리(박지선 대리)\n3.업무 인수인계 진행\n-인플루언서 발굴 및 제품 소싱업무,박지선 대리 / CS 발주 재고 파악,배장환 사원 / 컨텐츠 릴스 배너 제작,정재훈 사원\n4.주 블로그 3개 / 릴스 3개 / 피드 3개 - 전직원 진행 및 리워드 지급\n-컨텐츠 성과 기준 : 11월 업로드 게시물 한달 노출 후 1월 데이터 확인하여 10만이상 성과 발생 시 리워드 \n-매출/기획 성과 기준 : 특정 콘텐츠로 광고 전환값 5백만원 및 ROAS 300% 이상달성\n-UGX, 신규 유통 채널 또는 기타 프로젝트로 인해 매출 1천만원 이상 달성\n-특정 콘텐츠로 인해 팔로워 1,000명 이상 / 상세페이지 개선 전환율 평균 5%"},
  {"id": "preset-m-2025-12-08", "date": "2025-12-08", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.정과 관련 업무 우선 진행 / 단가 우선 계산 후에 이외 진행 예정(권나경 과장)\n2.아마존 재팬 일본어로 상세 페이지 수정 및 일본ST로 제작 / 상표권 등록 이슈로 우선 진행 후에 상세 진행 예정(이호혁 차장)\n3.원정대 GFA 광고 효율 분석 후 진행 여부 확인 / 아블러제로 12월 중~후 입고 예정으로 메타 및 모든 플랫폼 광고 OFF 후 아블러/듀오로 집중 운영(박지선 대리)"},
  {"id": "preset-m-2025-12-05", "date": "2025-12-05", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.릴링체어 체험단 도매로 샘플 2개 받아서 오는 중 / 중국에 있단 5개는 중국에서 중국으로 반품 예정(권나경 과장)\n2.기자단은 어뮤징 걸릴수도있어서 다른 방법으로 진행 예정 / 상세페이지 및 상품 스마트스토어 등록했으나 검토 필요로 확인되어 수정예정(권나경 과장)\n3.견과 공장으로가서 인터뷰 예정(정재훈 사원 / 권나경 과장)\n4.컨텐츠<투명VS불투명/아블러제로 스크레치/중국제품 비교> 영상 차주 촬영 후 편집(박지선 대리/정재훈 사원)"},
  {"id": "preset-m-2025-12-01", "date": "2025-12-01", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.이훈재 사원 채용 : 차장님, 과장님 업무 지원 + 인플루언서 섭외 주력.\n2.물류센터(CJ 양주) 배송 지연 → 플랫폼 점수 하락 문제 → 개선 방안 검토 필요(이호혁 차장)\n3.11월 재고 업데이트 보고서 제출 예정. 쿠팡 입고도 병행 확인.(이호혁 차장)\n4.닐링 체어 상세페이지 완성 → 쿠팡 업로드 → 체험단 진행(권나경 과장)\n5.상세페이지 유입은 많으나 이탈률 95%로 높음 → 빠른 개선 테스트 진행\n6.Catmoji 업로드는 이틀 1편으로 변경(정재훈 사원)\n7.종이컵 영상 금일 오후 초안 바로 제출. 콘텐츠는 속도·물량 우선(정재훈 사원)\n8. 인스타 락 문제 발생 → 우선 유튜브 업무 진행 / 모델 계정 대표 검수 예정(배장환 사원)"},
  {"id": "preset-m-2025-11-28", "date": "2025-11-28", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.컨텐츠 3가지 기획안수정 / 중국제품과 비교 및 아블러제로 스크래치 관련 기획안 수정(박지선대리)\n2.프로그레스미디어 광고 진행 킵 / 원정대 대행사 GFA 광고 15만원씩 8일 테스트 진행 / 검색광고 자사 내부 직접운영(박지선 대리)\n3.리퍼세일 준비 / 로켓그로스 클레임 처리 / 울타리몰 미국 입점 추진 / 아마존 재팬 입점 / 올웨이즈 광고 신청 및 타임특가 검토(이호혁 차장)\n4.닐링체어 알리바바 상품 반품 진행 / 태그바이 후기 진행 (권나경 과장)"},
  {"id": "preset-m-2025-11-24", "date": "2025-11-24", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.쿠팡 계정 2군데 다 상품 등록 필요함(이호혁 차장)\n2.닐링체어 제품 지원 시스템 관련 진행(권나경 과장)\n3.에버런스 구글 배너 소재 관련 진행 여부 확인 / 프로그레스미디어 gfa 배너 관련 진행 여부 확인(박지선 대리)"},
  {"id": "preset-m-2025-11-19", "date": "2025-11-19", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.블프 이벤트 및 쿠팡 그로스 입고 확인(이호혁 차장)\n2.블프 상품 썸네일 및 추가구매 구성 확인(박지선대리 초안 / 이호혁 차장 검수)\n3.블프 세일 및 이벤트 관련 카톡 채널 메세지 19일 수요일 발송 / sms 문자 목요일 6시 발송(박지선 대리)\n4.네이버 브랜드스토어 입점관련 프로그레스미디어 대행사랑 소통(박지선 대리)\n5.닐링체어 런칭 일정 체크 / 박스포장 관리 소통(권나경 과장)\n6.주마다 전사직원 블로그 3개 / 인스타 피드 3개 / 릴스 3개 업로드 필수"},
  {"id": "preset-m-2025-11-14", "date": "2025-11-14", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.닐링체어 상세 페이지 수정(한글 버전으로 만들어야함) / 소싱제품 몇가지 샘플 구매 완료(권나경 과장)\n2.인플루언서 크롱 리스트 구매했으나 아직 리스트 확인 못함 / 견과류 대표님과 의논 필요함(권나경 과장)\n3.닐링체어 기자단 마케팅 / 리뷰 플레이스하기에는 구독료가 너무 비싸서 기자단을 이용해서 마케팅에 사용하려는 취지(권나경 과장) \n4.블프 광고 기획안 1차 전달 완료 / 플랫폼별 상품 썸네일 수정 필요함(박지선 대리)\n5.카페24 메타 광고 매출 회복세 / 다가가는 마게팅 구매 고객말고 이전에 협회? 6곳이랑 진행 필요하나 리스트없음(박지선 대리)\n6.블프 상품별 배너 제작 / 블프 자사몰 네이버 상단 배너 제작 필요(박지선 대리)\n7.잔디에 업무 보고 / 일일 진행한 업무 실시간으로 잔디로 보고(전직원)\n8.팀원별 업무 리스트 만들어서 시간 배분 후 일일 보고에 등록하도록 안내"},
  {"id": "preset-m-2025-11-10", "date": "2025-11-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.성준테크 아블러 몰드 제작 일정 지연중(이호혁 차장)\n\n2.닐링체어 배송 중 / 사용설명서 제작 / 제품 상세 gif 이미지 제작(기본의자+닐링체어 사용) (권나경 과장)\n\n3.블프 기획 + 블프 광고 기획 에버런스 광고대행사랑 같이 진행(박지선 대리)\n\n4.일주일에 1인당 블로그 글 3개 / 1분미만 영상제작  / 권나경과장 블로그 총 9개 포스팅 / 박지선대리 인스타피드 및 숏츠 9개 업로드"},
  {"id": "preset-m-2025-11-07", "date": "2025-11-07", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.닐링체어-상세페이지 디자이너 수정 체크 / 디테일 컷도 수정 필요 / 로켓그로스 입고 후 광고 진행(권나경과장)\n\n2.태그바이/브랜드커넥트 배송지연 - 듀오메이커(권나경과장)\n\n3.미스터위스키 금일 오후 5시 업로드 후 구매 테스트 진행(이호혁 차장)\n\n4.크몽 인플루언서 리스트 구매 결정 (1~2만원대)(권나경과장)\n\n5.sns 챌린지 리뷰 아블러로 진행/1등-위스키,2등-커피머신,3등-상품권/진행 일정 대표님과 체크/블프 때랑 동시에 진행할지 여부 체크(박지선 대리)"},
  {"id": "preset-m-2025-11-03", "date": "2025-11-03", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.물류 일정 체크 - 이호혁 차장\n\n2. 미스터위스키 유튜브 쇼핑 셋팅 및 닐링체어 타오바오 개인계정으로 한주소 상품 수령 안되서 사업자 계정 필요(권나경)\n\n3.프로그레스미디어 광고 일예산 3만원으로 유지 진행\n\n4.금주 다가가는 마케팅 B2B 대상 진행  / 블프 기획안 작성"},
  {"id": "preset-m-2025-10-31", "date": "2025-10-31", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.부자재 박스 및 아블러 몰드별 수량 체크해서 추가 조립 - 이호혁 차장\n\n2.아블러 제로 45일 정도 시간 소요/라벨 한글 변환 후 생산처 전달 완료(권나경)\n\n3.인플루언서 태그바이 차주5명 진행 예정/제이파이 12월 진행으로 메일발송 했으나 무응답(권나경)\n\n4.새로운 상품 서칭 / 강아지 목줄 관련 배터리 체크 필요함(권나경)\n\n5.1029 아블러 제로 META 광고 효율 높아서 주말간 유지 예정\n\n6.차주 성과보고 캠페인 정리 / 광고 노출 지면은 인스타로만 진행\n\n7.블프 영상 차주 기획 예정 / 기획 후 대행사 진행시에 공유하여 소재 제작에 참고 \n\n8.자사 블프 배너 제작 필요함"},
  {"id": "preset-m-2025-10-27", "date": "2025-10-27", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.주말간 카페24/토스 페이먼츠 정산관련 이슈 발생 - 이호혁 차장\n\n2. 아블러 볼 몰드 / 듀오메이커 생산 관련 일정 체크 및 쿠팡 로켓그로스 입고 - 이호혁 차장\n\n3. 아블러제로 온도 유지 관련 자사 상세페이지 이미지 수정 필요(권나경)\n\n4. sns 참여 이벤트 관련 해시태그 사용 및 추가적인 이벤트 기획필요\n(사은품 자사제품이 아니어도 되니까 좀 더 활발한 채널 유지를 위한 기획)\n\n5. 통합리포트 쿠팡 매출 관련 수정 필요 \n\n6. 11월 첫주 블프 배너 미리 제작 및 블프 콘텐츠 기획 여러가지 뽑은 후 전체 회의를 통한 결정 필요\n\n7. 새로운 제품 소싱 필요 / 자사 제품 단발성 상품으로 하이볼 액상 같이 젠스파크랑 소통 필요(권나경 진행중)"},
  {"id": "preset-m-2025-10-24", "date": "2025-10-24", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.자사 상품 자재 생산 일정 확인 - 이호혁 차장\n\n2.각인 관련 업체 소싱 필요 - 이호혁 차장\n\n3.유튜브쇼핑 오류 발생(상품이 안보이는 오류) - 이호혁 차장\n\n4.듀오x미스터위스키 랜딩 가격 체크 및 영상 수정본 확인(얼음이 너무 매끈하지않은부분)(권나경)\n\n5.인플루언서 리스트 정리 후 재 업로드(권나경)\n\n6.할로윈 해골 몰드 랜딩 오픈(배너 랜딩 선작업 후 27일 영상촬영/11월 4일 발표)\n\n7.인스타/유튜브 이벤트 영상 업로드"},
  {"id": "preset-m-2025-10-22", "date": "2025-10-22", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 상품 재고파악 및 제작 일정 체크 - 이호혁 차장\n2. 키데글라스/비즈브릭스/산스커피 등 콜라보 및 공구 진행 메일 발송\n3. 노스페이스 관련 영상 제작\n4. 중국 캔톤페어 관련 새로운 제품 소싱 필요"},
  {"id": "preset-m-2025-10-20", "date": "2025-10-20", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.어쿠스틱드링크 진행 메뉴얼 제작(권나경)\n2.메타광고 기존 3개 소재 감액 및 해당 소재 복사 후 어쿠스틱 드링크 자사 랜딩으로 수정하여 광고 진행\n3. 피그마 활영하여 추후 유튜브 콜라보 배너 제작"},
  {"id": "preset-m-2025-10-17", "date": "2025-10-17", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.어쿠스틱 드링크 유튜브 랜딩 수정(권나경)\n\n2.유튜브랜딩 상품 추가구매 및 악세사리 추가(권나경)\n\n3.META 광고 소재 제작 후 주말간 광고 증액 운영"},
  {"id": "preset-m-2025-10-14", "date": "2025-10-14", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 자사몰 상품 반품 시스템 개선 필요 - 이호혁 차장\n\n2. 디자이너 추후 사용 관련하여 결정 필요함\n\n3. 광고대행업체 픽스전까지 광고 컨텐츠 제작 필요\n\n4. 어쿠스틱 드링크 스테인리스 얼음 관련하여 소구점 전달(권나경)\n\n5. 소라2 veo 3 로 b급 광고 소재 제작\n\n6. 우리와 잘 어울리는 제품군과 콜라보 진행"},
  {"id": "preset-m-2025-10-10", "date": "2025-10-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.월밸 재고 출고 및 로스 확인 필요 - 이호혁 차장\n-발주처와 더블 크로스 체크 필요함\n\n2. 컨텐츠 광고 기획 및 제작 필요\n\n3. 어쿠스틱 드링크 진행 전 가격 및 컨텐츠 체크 (권나경)\n\n4. 블랙프라이데이 기획\n-차주 수요일 15일 기획안 한장짜리 전달"},
  {"id": "preset-m-2025-10-02", "date": "2025-10-02", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 배너 제작 관련\n문제 상황\n이번 추석 배송 관련 배너가 CJ대한통운에서 자동 제공되지 않음.\n새로운 디자인 제작 여부가 논의됨.\n의견\n과거(작년·재작년) 추석 배송 배너를 재활용하고 날짜만 수정하면 충분하다는 의견.\n디자이너에게 별도 제작 요청은 시간·비용 비효율 → 기존 배너 활용으로 결정.\n배너 문구는 “추석 배송은 조기 마감, 당일 배송 필요 시 쿠팡 이용 안내” 포함.\n\n2. 영상/촬영 방식\n진행 방식\n원테이크 촬영 후 필요한 부분만 컷 편집.\n각도만 잘 잡으면 촬영 가능, 추가 마이크나 보조 인력 불필요.\n불필요하게 시간 쓰지 말고 단순·신속하게 진행.\n\n3. 실행 방향\n배너: 기존 추석 배너 활용 → 날짜·문구 업데이트 후 자사몰 반영.\n메시지: \"CJ대한통운 배송 마감 / 쿠팡 당일 배송 가능\" 명확하게 표시.\n촬영: 오후 원테이크 진행, 편집은 최소화."},
  {"id": "preset-m-2025-09-30", "date": "2025-09-30", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 시장 상황 및 추석 이벤트 분석\n추석 이벤트 성과 저조: G마켓 포함 타사 이벤트 대부분 실패. 경기 침체 및 여행·가족 관련 지출 증가로 충동구매 심리 위축.\n소비 트렌드 변화: 여행·가족 챙김 지출 우선, 소비가 타이트해져 일반 소비재 지출 둔화.\n광고 전략: 배송 차질과 ROAS 저하 감안, 광고는 최소화 또는 효율 중심으로 진행.\n\n2. 향후 마케팅 일정\n10월 18일: 어쿠스틱 드링크 → 아블러 브랜드 광고(유튜브) 진행 예정.(권나경)\n다음 주 금요일: 미스터 위스키 협업 콘텐츠 진행 예정.(권나경)\n패키지 구성: 이호혁 차장 + 지선 대리 → 구성안 확정. - 이호혁 차장, 박지선 대리\n콘텐츠 강화: 매일 인스타그램·유튜브 기반 아이디어 회의 및 즉시 제작·테스트.\n\n3. 업무 분장 조정\n박지선 대리: 마케팅·광고 전담 (소재 제작, 프로젝트 기획·운영, 외부 협업 포함).\n권나영 과장: 고객 소통·CS, 채널톡·스마트스토어·자사몰 채널 운영.\n이호혁 차장: 반품·교환 업무 담당. - 이호혁 차장\n이호혁 차장: 일일 매출 및 유입수 관리, 기존 지선 대리 업무 일부 이관, 발주·송장 취합 및 쿠팡 재고 입고 관리. - 이호혁 차장\n마이클: 콘텐츠 회의 참여 및 자료화(프롬프트 관리, 스프레드시트 저장).\n\n4. 광고 및 채널 운영 현황\n카카오톡 메시지: ROAS 98%로 성과 저조, 투자 대비 전환 거의 없음.\n맘카페 체험단: 시딩 완료, 반응 낮음. 일부 무료 수령 목적 고객 다수(권나경)\nSNS 채널: 2개 채널 운영 중, 하루 1포스팅 진행.\n콘텐츠 제작 도구: Midjourney·Veo3 등 혼합 사용. 프롬프트 자산화 필요(스프레드시트 저장).\n\n5. 생산 및 재고 일정- 이호혁 차장\n실링 스티커: 9월 16일 납품 예정.\n스틱 제품: 9월 24일까지 1,500개 생산(17일 외통, 분할 입고 가능).\n아이스볼 제품: 11월 초(7일~17일) 완성 예상.\n쿠팡 재고: 추석 매출 확보 핵심 채널 → 목요일까지 입고 확인.\n\n6. 대행사 협업 논의\n대행사(메타 에드): 광고 집행 논의 + 콘텐츠 제작 여부 확인 필요.\n중요 포인트: 담당자 역량에 따라 결과 편차 큼.\n3시 화상 미팅\n\n7. 디자인/브랜딩 관련\n이메일 서명(명함 아님): 전사 통일된 프로페셔널 서명 제작(사진/캐릭터/이모지 활용 가능).\n추석 배너 공지: 단순 디자인으로 빠르게 제작, 자사몰 공지 필수.\n닐링 체어 상세페이지: 이번 주 내 기획 문서 전달(사진은 추후 보완).\n\n8. 결론 및 다음 액션\n추석 이벤트 ROAS 낮음 → 광고 최소화·효율 집중 전략 채택.\n콘텐츠 제작 강화: 매일 회의 및 즉시 제작/테스트 루프 실행.\n업무 재배치 확정: 마케팅/CS/재고관리 업무 명확히 분담.\n재고 관리: 추석 매출은 쿠팡 채널 중심, 목요일까지 입고 확인.\n대행사 협의: 오늘 3시 화상 회의에서 광고·콘텐츠 제작 여부 확인.\n디자인/브랜딩: 이메일 서명 통일, 추석 배너 공지 제작, 닐링체어 상세 준비."},
  {"id": "preset-m-2025-09-19", "date": "2025-09-19", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 물류센터 이전 계획 - 이호혁 차장\n- 시기: 다음 주 중 진행\n- 대상: 성준 거점 → 한국 물류센터로 이전\n- 목적: 배송 프로세스 한국 현지화\n- 일정: 추석 전까지 완료 목표\n\n2. 추석 마케팅 전략 수정\n- 기존 문제점: 메타 광고와 추석 기획전 썸네일 불일치로 인한 고객 혼란\n- 해결방안: \n  - 기존 메타 광고 썸네일 유지\n  - 추석 전용 광고 소재 별도 제작\n  - 추석 기획전 랜딩페이지 연결\n\n3. 인플루언서 마케팅 일정\n- 미스터 위스키: 9월~10월 초 진행 (즉시 시작)(권나경)\n-어쿠스틱 드링크: 11월 중순~12월 중순(권나경)\n- 블랙프라이데이: 10월 말~11월 중순\n\n4. 재고 관리 - 이호혁 차장\n- 듀오 메이커: 약 600개 재고 (추석까지 충분)\n- 로켓그로스: 추석 연휴 대비 충분한 재고 확보 필요\n- 부자재 발주: 다음 주 검토 예정\n\n5. CS 개선사항 - 이호혁 차장\n- 고객상담 템플릿 전면 개선 완료\n- 채널톡 매크로 설정으로 효율성 향상 계획\n\n6. 프로모션 계획\n- 10월: 할로윈 해골 몰드 프로모션 검토\n- 11월-12월: 연말 홈파티 시즌 타겟 마케팅\n- 블랙프라이데이: 기존 성공 사례 기반 대규모 세일\n\n7.신제품 개발\n- 닐링 체어: 길이 조절 기능으로 차별화 포인트(권나경 진행중)\n- AI 상세페이지 제작으로 품질 향상 및 효율성 증대\n\n8. AI 마케팅 프로젝트\n- AI 인플루언서: 20-100명 규모의 가상 인플루언서 육성\n-자동화 시스템: SNS 포스팅 자동화 구축\n- 확장 계획: 자사 제품 → 타사 제품 광고 대행 서비스\n\n9. 지원 프로그램 - 이호혁 차장\n카페24 지원 프로그램\n- 목표: 1억원 매출 달성\n- 지원금: 초기 100만원 + 달성 시 900만원 추가\n- 기간: 7월~12월 (하반기)\n-전략: 유튜브 쇼핑 연계 및 인플루언서 협업"},
  {"id": "preset-m-2025-09-05", "date": "2025-09-05", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "-구글광고 OFF / 모먼트 광고 아블러 제로 29,000원으로 해서 광고 테스트\n-추석 기획 필요함\n-인플루언서 체험단 진행(권나경)"},
  {"id": "preset-m-2025-08-26", "date": "2025-08-26", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "-매출 증가를 위한 광고 효율 개선 방안\n-인플루언서 9월 협업 진행을 위해 서칭 필요\n-아블러 제로 촬영본 이미지 수정\n-인플루언서 < 자동차 / 캠핑 / 여행 / 골프 > 쪽으로 아블러 ㄱ서칭필요\n-메이저 사이즈 말고 2~3만 정도의 성장세가 보이는 인플루언서와 협업"},
  {"id": "preset-m-2025-08-19", "date": "2025-08-19", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "-아블러 제로 통관 추후 이상없도록 <라벨/주소> 등 미리 수정 진행 필요함\n-각인 서비스 홍보 및 금형 단가 및 금액 확인\n-구글 매체 전환 추적 코드 삽입 필요<구글 기획팀과 같이 진행>\n-자사 균일가 진행 예정으로, 배너 제작 필요함\n-아블러 제로 감성샷보다는 진정성 샷 위주 제품 촬영 필요함"},
  {"id": "preset-m-2025-08-12", "date": "2025-08-12", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.목요일 오후 6시 카카오모먼트로 톡채널 메세지 발송\n-쿠폰 or 세일 20% 카피문구는 소재 제작 후 선택\n\n2.아블러 제로/다가가는 마케팅 촬영 기획안\n\n3.데이터라이즈 재사용 여부 결정"},
  {"id": "preset-m-2025-08-08", "date": "2025-08-08", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 개인 주간 업무 진행 사항 및 차주 업무 진행건\n\n2.메타 광고 차장님 운영\n\n3. 인포크 링크 생성\n\n4. 주 1건씩 제품소싱제안 리스트 작성\n\n5. 상품 배너 이미지 및 자사몰 카테고리 이미지 전체 수정\n\n6. 핫아이템 광고 OFF 후 모먼트 광고 ON 및 구글애즈 50% 광고비 증액운영\n-구글애즈 5만원 -> 7.5만원 증액 / 모먼트 톡 선물하기 링크로 톡채널, 배너광고 진행 11일부터\n\n7. 아블러 제로 18일부터 예약판매건 배송 시작(차주내로 성준에 입고 예정)\n\n8. 모든 광고 매체 아블러 제로 예약 광고 진행\n\n9. \"고객에게 다가가는 마케팅\" 관련 자체 컨텐츠 제작 기획\n(시계를 CEO가 전달해주는 컨텐츠 / 유동인구가 많은 곳에서 시민 참여하는 컨텐츠 등)"},
  {"id": "preset-m-2025-08-04", "date": "2025-08-04", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.네이버 핫아이템 광고 유입은 높으나 전환까지 이어지지않음\n-자사 랜딩 콘텐츠 개선 필요함(ai 이미지,동영상 제작하여 랜딩 수정)\n\n2. SNS 대표님께 인수인계 받아서 차장님, 대리님 진행\n\n3. 광고 다양화와 소싱 아이템 발굴 \n(과장님,대리님 둘이서 쥬얼아이스 판매상품에 어긋나지않는 소싱 아이템 발굴)\n\n4. 광고 소재 제작\n(AI 활용하여 이미지, 동영상 제작)\n\n5.아블러 제로 수입 날짜 확인하여 해당 상품도 핫아이템 광고 진행 예정\n\n6. 자사 유튜브 세로형 릴스로 자사 랜딩 동영상 상단 노출 테스트\n\n7. 통합 리포트 작성하여 사용 광고비 체크 후 매체별 효율 개선"},
  {"id": "preset-m-2025-07-21", "date": "2025-07-21", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 생명의물 이벤트 당첨자 공지 완료 \n\n2. FNH 에서 성준으로 순차적 정리\n\n3. 아밥남 2차 컨펌 후 전달 완료, 6개월 노출 예정\n\n4. 메타광고 소재 제작 및 대표님 브랜딩 채널 콘텐츠 제작 \n\n5. 쇼핑파트너센터 금일 입찰 예정 (차주 노출 예정)\n\n6. GFA / 구글애즈 광고 셋팅\n\n7. 제이파이 AI로 전환효과 예측 필요함"},
  {"id": "preset-m-2025-07-14", "date": "2025-07-14", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 네이버 및 구글 광고\n-일예산 각 10만원씩 (월 총 300만원씩, 구글 네이버 통합 600만원)\n\n2. 목요일 자사 광고 소재 촬영\n\n3. 인플루언서 리차드 구글 계정 확인 후 리스트업\n\n4. 생명의 물 이벤트 18일 당첨자 발표 예정\n\n5. 인플루언서 영상제작 광고 \"위생\" 포인트로 두고 진행\n\n6. 추성훈 유튜브 미진행 예산으로 장마 끝난 후에 네이버 핫아이템 광고진행 여부 확인\n→ 자사 유입량 데이터 AI에게 전달 후 핫아이템 광고 데이터랑 매칭 시켜서 <손익분기점/ROAS> 예상 데이터 확인하기"},
  {"id": "preset-m-2025-07-11", "date": "2025-07-11", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.네이버 광고 및 구글 광고 기획안\n*DA: 이미지형 광고, SA: 키워드형 광고\n*구글: DDN, 피믹스 활용 / DA·SA 모두 가능\n*네이버: 검색광고(SA/DA) / 쇼핑파트너센터 / GFA <효율 우선순위: 쇼핑파트너센터 > GFA > 검색광고>\n*차주까지 매체별 광고 기획안 작성 후 대표님께 전달\n\n2.인플루언서 마케팅 진행\n*아밥남: 계약 완료, 7월 28일 릴스 목표\n→ 소구 포인트(필수대사,참고자료) 마무리 후 오늘 전달, 일정 확정\n*추성훈 무산되어 계속 새로운 인플루언서 발굴 진행\n→박지선 대리 리차드 계정 회신 메일 확인 후 보고\n\n3.오후살림 진행 내용 및 매체별 재고 준\n*오후살림 계약 및 제품 발송 완료 → 자사몰 랜딩 연계 판매 → 2주 내 정산\n*쿠팡 등 추가 입고까지 사전 준비\n\n4.카카오톡 채널 메세지 발송\n*매출 증대 목적보다 신제품 설문조사 참여율 목적으로 발송 예정\n*유튜브 \"생명의 물\" 영상 URL 및 설문조사 URL 중 채널메세지 발송 연결 URL 확정\n*설문조사 URL 속에 \"생명의 물\" 유튜브 URL 최상단 삽입 후 바로 하단에 이벤트 당첨자 경품 안내 이미지 등록 후 해당 URL로 메세지 발송 예정\n\n5.광고계정 해킹으로 쥬얼아이스 계정 전체 패스워드 변경"},
  {"id": "preset-m-2025-06-24", "date": "2025-06-24", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1.생명의물 유튜브 이벤트 전략\n* 생명의물 유튜브 쇼핑라이브 방송에 맞춰 고급스러운 경품 기획\n* 시그니엘 조식권, 위스키, 호텔 숙박권, 테슬라 체험권 등으로 \"나도 참여하고 싶다\"는 욕망 유도\n* 타깃 고객: 자기 삶에 투자하는 고소득층 → 아블러·주얼아이스 자연스러운 연결 가능\n* 최고 구매자 유도: 냉장고 같은 고가 아이템 연계로 B2B 유입 가능성 확보\n* 영상 콘텐츠 및 소셜 공유를 통한 알고리즘 타겟팅 강화\n\n 2.구매대행 테스트 및 소싱 전략\n* 타오바오 기반 제품 구매대행 테스트 진행 확정\n* 일부 제품은 테무처럼 한국까지 직배송 가능 (약 10%)\n* 테스트는 타오바오 한정, 1688/알리바바는 MOQ 및 도매 조건으로 제외\n* 상세페이지 번역 후 테스트 판매 → 반응 좋으면 직접 소싱 전환 (100 → 500개)\n* 구매대행임에도 CS는 내부에서 직접 대응 (브랜드 신뢰 유지 목적)\n* 시장 반응을 빠르게 보기 위한 **사전검증용 채널**로 활용\n* CS 리스크(예: 냉장고 온도 등 예상치 못한 질문)는 대응 매뉴얼화 필요\n\n3. 디자인 인력 활용 및 리소스 계획\n* 디자이너 계약 연장 검토: TF 종료로 현재 고정 업무 없음\n* 그러나 외부 소싱 제품 상세페이지, 영문 웹사이트 리뉴얼, 배너/영상 등 할 일 많음\n* 디자이너 역량(속도, 감각) 긍정 평가 → 정기 업무 배정 필요성 있음\n* 유휴시간을 줄이기 위한 상시 과제 부여 구조 검토\n\n4. 업무 매뉴얼 작성 및 로테이션 테스트\n* 모든 팀원에게 주업무 3개 이상 매뉴얼 작성 지시 완료\n* 매뉴얼 목적: 대표가 아닌 제3자가 봐도 업무 수행 가능해야 함\n* 다음 주부터 **매뉴얼 기반 업무 로테이션** 테스트 진행 예정\n* 업무 분장에 대한 이해 및 역량 향상을 위한 내부 훈련 겸용\n\n5. 물류 및 경품 배송 구조 논의\n* 생명의물 측에서 선풍기 500개 배송 → 물류 이중화 문제 발생\n* 아블러는 주얼아이스 물류 → 선풍기는 생명의물에서 별도 발송\n* 고객 입장에선 따로 받는 불편 + CS 분산 가능성\n* 해결방안: 아블러 물류에서 일괄 포장 후 통합 발송 제안\n* “우리가 배송비 부담하고, 물류 통합해드리자” 제안 검토\n* 생명의물 측 내부 논의 필요 (박사장/이도현 대표 라인 통해 협의)\n\n6. 아블러 제로/불량품 검수 관리\n* 아블러 제로: 완판, 창고 재고 없음\n* 신규 텀블러 샘플 발송됨\n* FNH 검수 기준 명확화 필요\n* 불량(스크래치) 구분 기준 → 사진 기반 수량정리 및 검수 매뉴얼화"},
  {"id": "preset-m-2025-06-16", "date": "2025-06-16", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "[1] 상세페이지 리뉴얼 현황\n* 주얼아이스와 아블러 중심으로 상세페이지 전면 개편 완료\n* 악세사리는 일부 미검토 상태, 순차적으로 보완 예정\n* 세트 구성품(예: 추가 몰드 수량 등)에 대한 안내 부족 → 시각 자료와 표기 추가 필요\n\n[2] 광고 및 유입 분석\n* 최근 유입 수 감소\n* 유입 저하 대응 필요: 광고 채널 다각화 및 효율 분석\n\n[3] 광고 전략 점검 및 실행안-이호혁차장\n* ROAS 기준: 광고비 대비 수익률 마지노선 20%\n* 스마트스토어는 광고 미집행 상태에서도 월 400만 원 이상 매출 → 광고 투입 테스트 검토\n* 메타 광고는 효율 낮은 일부 타겟 제거, AI 타겟팅 광고로 세분화 테스트 중\n* 인스타그램 중심 운영, 카카오/구글/쿠팡 광고도 분산 고려\n\n[4] 구매대행 상품 전략-권나경과장\n* 신제품 테스트용으로 구매대행 등록 → 수요 확인 후 사입 결정\n* 일주일 2~3개 신규 등록 목표\n* 관련 제품 예시: 오크통, 훈연기, 얼음각인기 등\n* 유입 증가 + 객단가 상승 유도 목적\n\n[5] 인플루언서 마케팅 진행-김형섭팀장\n* 기존 방식(DM 및 이메일) + 플랫폼(레뷰 파트너스) 병행\n* 메시지 구성: 짧고 직관적으로, 성과 위주 + 관심 유도\n* PDF 등 첨부는 지양, 링크 및 간단 설명 중심\n* 팀원별 개인 유튜브/인스타 알고리즘 활용 필요\n* 향후 AI 기반 유튜버 추출툴도 내부 개발 예정\n\n[6] 제품 재고 및 발주 이슈\n* 추가 몰드 재고 부족 (스틱/구형)\n* 개별 몰드 한 달 약 100개 판매 → 연간 약 4천만 원 매출 예상\n* 금형 비용 고려, 발주 여부는 이번 주 판매 추이 확인 후 결정\n\n[7] 가격 정책 및 프로모션\n* 자사몰·스마트스토어·톡스토어 가격 통일 필요\n* 현재 일부 채널에서 비정상가 표시 → 6월 한정 할인 적용 예정\n* 상세페이지 내 브랜드 소개, 사용법 영상 등 콘텐츠 업데이트 필요\n\n[8] 신규 유통 채널 제안\n* 면세점 입점 검토 제안됨\n* 신세계 면세점 직접 신청 가능 / 일부 정부지원 사업은 마감됨\n* 장기적 입점 전략으로 검토 예정\n\n[9] 업무 분장 요약\n* 이호혁 차장: 타 광고 플랫폼 테스트, AI 타겟 효율 분석\n* 권나경 과장: 구매대행 상품 기획 제안 및 상세페이지 등록\n* 김형섭 팀장: 인플루언서 섭외 지속, 플랫폼 도입 및 콘텐츠 메시지 개선\n\n[10] 주간 주요 일정\n* 6월 21일 (금): 유튜브 ‘술읽는집’ 콘텐츠 공개\n* 6월 27일 (목): ‘생명의물’ 유튜브 쇼핑 광고 런칭"},
  {"id": "preset-m-2025-06-02", "date": "2025-06-02", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 물류 및 재고 운영 방향\n\n* 쿠팡에는 필수 재고만 남기고, 나머지는 FNH 물류센터에서 출고하도록 전환\n* 향후 배송 업무는 FNH에서 처리\n* 재고 부족 상황에 대비해 플랫폼별 소량 비축은 가능\n* 이번 주 안으로 전체 기획 정리 후 결정 예정\n\n2. 업무 보고 방식 개선\n* 주간 업무 보고는 수치 기반으로 작성\n  예: 인플루언서 섭외 3건, CS 처리 10건 등\n* 완료된 업무는 회의록 탭에서 스크래치 표시\n* 회의록 내 지시사항도 스크래치 방식으로 관리\n* 업무 진행 상황은 숫자로 표현해야 관리 가능\n\n3. 플랫폼 점검 및 CS\n* 팀장은 자사몰, 스마트스토어, 쿠팡 등 소비자 시점으로 점검\n  제품 노출, 가격, 구성 이상 여부 확인 후 즉시 조치\n* 차장은 매출 및 재고 관리 담당\n* 각 플랫폼은 매장 개념으로 보고 진열상태 매일 확인\n\n4. 광고 인수인계\n* 수요일부터 팀장, 차장은 대표님께 페이스북 광고 실습\n* 팀장 중심, 차장 보조로 인스타그램 광고 운영 예정\n\n5. AI 업무 자동화 논의\n* 유튜버 섭외 및 CRM 업무도 AI가 처리 가능\n* 활용 예정 툴:\n  ChatGPT (심층 기획, 문서 작성)\n  Perplexity (최신 뉴스 기반 정보 수집)\n  Notebook LM (PDF, 자료 분석 및 요약 생성)\n* 반복 업무는 AI에 맡기고, 전략적 사고에 집중할 것\n\n6. 상세페이지 및 웹사이트 진행 상황\n* 디자인 수정사항은 디자이너와 공유 완료\n* 최종본은 권과장이 직접 검토 후 컨펌\n* 웹사이트 미디어 탭은 완료, 나머지는 기획안 한 장으로 정리 필요\n* 기획안은 AI 심층 리서치 기능 활용하여 작성\n\n7. 일정 및 우선순위\n* 6월 초까지 웹사이트, 상세페이지 전체 정리 완료\n* 이후 새로운 플랫폼 입점 추진 (패션, 버티컬 마켓 등)\n* 공동구매 결제창은 유튜브로만 접속 가능, 외부 브라우저 제한 있음"},
  {"id": "preset-m-2025-05-23", "date": "2025-05-23", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 썸네일 및 브랜드 이미지 전략\n**핵심 방향**\n* 썸네일에서 텍스트 제거\n* 제품 퀄리티 중심 고급 이미지 사용\n* 자사몰 기준 톤앤매너 통일 → 스마트스토어, 쿠팡 순 확장 적용\n* 가격 강조 금지, 브랜드 가치 중심 커뮤니케이션\n\n**실행지침**\n* 듀오 / 아블러 / 쥬얼아이스 브랜드별 이미지 톤 통일\n* 클릭 유도 목적의 강력한 이미지 1컷 연출\n* ‘특별가’ 등의 텍스트 배너 지양\n\n2. 자료 및 파일 정리 체계 (Google Drive)\n\n**정리 기준**\n* 폴더명 형식: 연도\\_월\\_담당자명\\_프로젝트명 (예: 2025\\_05\\_권나경\\_상세페이지)\n* 모든 업무 파일은 월별 폴더에 업로드\n* 중복 자료 제거 완료 (약 700개), 자료 통합 진행 중\n* 디렉토리 남용 금지, 자주 쓰는 폴더만 유지 (영상, 이미지, 회사자료)\n\n3. 재고 및 생산 일정\n**현황 정리**\n* 텀블러, 듀오, 아블러 제로 입고 완료\n* 스피어 재고 없음 → 입고 필요\n* 성균테크 스피어 금형 작업 지연\n\n**생산 품질 이슈 (블랙 텀블러)**\n* 블랙 제품 스크래치 반복 발생\n* 공정상 필연적 연마/용접 마감 자국임을 고객에게 안내\n* 스타벅스/스탠리 사례 언급해 대응 가이드 마련 예정\n\n4. 상세페이지 및 콘텐츠 제작\n\n**각인 서비스 상세페이지 제작**\n* 담당: 이호혁 차장, 김팀장 협업\n* 제품 특징, 각인 옵션, 절차를 명확히 표현\n\n**캠페인 기획**\n* 쥬얼아이스: “Know Your Water” (건강, 위생 중심)\n* 아블러: “Bring Your Ice” (친환경, 전기·물 절약 중심)\n* 상세페이지는 구매이유 기반 이미지 설계 필요\n\n**협력 테스트 진행**\n* 에벤에셀: 각인 테스트 → 샘플 확보 후 성남산업진흥원 전달\n\n5. AI 활용 자동화 도입\n\n**활용 도구 및 플로우**\n1. 스마트스토어 플러그인으로 경쟁사 리뷰 수집\n2. LM (노션 기반 도구)로 리뷰 자동 분석\n3. ChatGPT로 요약, 팟캐스트 대본 제작, 상세페이지 스토리 설계\n4. 한 장짜리 제품 강점 이미지 기획\n\n**예상 효과**\n* 경쟁사 분석 시간: 기존 1\\~2주 → 1시간 이내 단축\n* 상세페이지 경쟁력 향상, 콘텐츠 제작 속도 증가\n\n6. 마케팅 및 캠페인 운영\n\n**텍바이 캠페인 운영**\n* 1차: 블로그 중심 3만원 리워드 제공\n* 2차: 제품만 제공하는 대규모 모집 (6월\\~7월)\n* 목표 리뷰 수: 총 40\\~50건 확보\n* 중복 참여자 필터링 필요, 퀄리티 우선 선별\n\n**브랜드커넥트 병행 운영**\n* 블로그 콘텐츠 품질이 우수해 추가 모집 진행\n\n**제휴 마케팅 제안**\n* 펀글라스 등과 교차 홍보/판매 제안\n* 위탁 판매 혹은 상호 상세페이지 등록 검토\n\n7. 향후 일정 및 과제\n\n**5월 말\\~6월 말**\n* 자사몰 리뉴얼\n* 상세페이지 정리 및 촬영\n* 광고 집중 운영 → 6월 20일, 27일까지 매출 성과 확보\n\n**7월 이후**\n* 블로그 콘텐츠 확대\n* 브랜드 인지도 향상 및 제품 설명 콘텐츠 누적 전략 추진"},
  {"id": "preset-m-2025-05-16", "date": "2025-05-16", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 보냉가방/텀블러 개발\n* 수입형(옥스포드+PE+알루미늄) vs 국내형(1680D+토이론+PU) → 국내형이 고단가/고내구\n* 선호 사이즈: 590~600ml, 라지 사이즈 기준\n* 소재 후보: 실리콘(우선), PP, 스테인리스\n* 샘플 요청 예정\n\n2. 각인 서비스 상세페이지\n* 10개 이상 주문 시 개당 1만 원 추가\n* 몰드 크기 지름 64mm, 각인 범위 3~3.5cm\n* 프로세스: 주문 → 파일 접수 → 컨펌 → 제작 (14일 소요)\n* 예시 이미지 + 프로세스 2장 정리 / 상세에 포함\n* 담당: 호혁 차장\n\n3. 생산 및 입고 이슈\n* 아블러 몰드: 4천개 중 1천개만 입고 (스피어 이슈)\n* 스피어 360개, 큐브 400개 확보\n* 텀블러 5/20 입고 → 5/26 조립 목표\n* 7,500개 몰드는 일괄 조립/출고 계획\n\n4. 세척 대안\n* 기존 수작업 세척(칫솔) 비효율\n* 대안: 울트라소닉 세척기 도입 검토\n* 외주 세척업체 검토 예정\n\n5. 상세페이지/콘텐츠\n* 상세 통일 목표: 5월 말까지\n* 제품 사용 이미지, 레이저 각인 포함 재촬영 필요\n* 담당: 권나경 과장 (기획), 디자이너 전달 전 내부 확정\n\n6. 고객사 대응 프로세스\n* 문의 채널 → 구글 설문지 유도 (이메일/DM 등)\n* 설문 기반 고객사 정보/상담 내용 DB화\n* 체크리스트로 팔로업 관리\n\n7. 기타 진행사항\n* 블루 실링 스티커 입고 후 조립 예정\n* 납품: 5/20 입고 → 5/26 조립 완료 → 예약판매 연계\n* 웹사이트 콘텐츠 5월 말까지 채워 넣기"},
  {"id": "preset-m-2025-05-12", "date": "2025-05-12", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "■ 1. 유튜브 쇼핑 연동 및 상품 정리(김팀장)\n● 현재 상황\n* 유튜브 쇼핑 채널 오픈 완료\n* 카페24 연동 진행 중 / 자사몰 쇼핑 섹션 정리 필요\n●요청 및 지시사항\n* 유튜브 쇼핑 리스트 정리 필수 (불필요 상품 비노출, 가격 통일, 썸네일 교체)\n* 아블러 / 듀오 / 제로 등 상품 구성 단순화\n* 고객 구매 동선 개선\n● 추가 조치\n* 유튜브 쇼핑용 기획안 작성\n* 제작 일정 포함해 적용 완료 후 보고\n\n■ 2. 상세페이지 및 콘텐츠 품질 개선(김팀장)\n● 문제점\n* 피그마에 PDF 삽입 시 품질 저하 → 직접 업로드로 전환\n* 이미지 구성, 사이즈, 색감 등 디테일 부족\n● 조치방안\n* 썸네일 통일 / 사이즈 비교 / 핵심 기능 강조\n* 구매 포인트 시각화 / 혼란 주는 구성 제거\n\n■ 3. 중국 소싱 및 견적 요청(권과장)\n● 현재 진행\n* 얼음틀 MOQ 문의 (중국 업체 2곳에 견적 요청 완료)\n* 보냉 가방(칸막이 포함) 샘플 탐색 중\n● 조치 및 계획\n* 중국어 키워드 번역 후 검색 (채치피 등 활용)\n* 보냉 가방은 아블러 4개용으로 세트 구성 기획\n* 목표단가: $2~$3 이하\n\n■ 4. 공급처 커뮤니케이션 문제(권과장)\n● 이슈\n* 아블러 제로 기존 공급사 연락두절 (이메일/위챗 무응답)\n* 해당 제품 단종 혹은 유휴 가능성\n● 대안\n* 알리바바 등 대체 공급처 검색\n* 기존 업체명으로 역추적 진행\n \n■ 5. 제품 개선 및 테스트(이차장)\n● CS 피드백\n* 얼음이 잘 빠지지 않는 현상 → 몰드 경도 문제 가능성\n* 경도 수치(35, 45, 55)별 테스트 필요\n● 생산 관리\n* 날카로운 몰드 모서리 → 금형 라운드 처리 요청\n* 생산 중 에러율 확인 및 품질 관리 강화\n\n■ 6. 콘텐츠 제작 및 영상 촬영\n● 계획\n* 아블러 사용법 영상 촬영 예정 (화/수 조율 중)\n* 실제 사용자 관점 반영하여 손 연출 고려\n\n ■ 7. 재고 및 매출 대응\n● 재고 계획\n* 7500개 재고 확보 후 여름 시즌 판매 대비\n* 만기 전 자금 회수 전략 포함"},
  {"id": "preset-m-2025-05-07", "date": "2025-05-07", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 자사몰 및 플랫폼 재고/상태 확인(by이호혁)\n* 자사몰은 품절 처리 완료됨.\n* 스마트스토어 광고 중이므로 품절 전환 필요\n* 재고는 조립 후 실물 기준으로 최종 확인 예정 (예상 수량: 400~500개)\n* 조립 완료 전까지는 정확한 수량 파악 어려움\n\n2. 고객 CS 및 오전 우선업무(by김형섭)\n* 연휴로 인해 5일간 미응답 고객 상담 누적\n* 오전 9시 출근 시, 카카오 채널톡을 통한 고객 응대 최우선 처리\n* 급한 CS → **이어진 고객부터 신속 대응** 필요\n\n3. 조립 및 생산 계획(by전사)\n* 500개 제품 조립 목표, 오전 CS 후 오후부터 조립 진행\n* 하루 만에 전량 조립은 어려움 \n* 박스, 속지, 비닐 등 **패키징 자재 사전 점검 필수**\n* 조립 후 일괄 출고 진행 예정\n\n4. 프로모션 및 배너 운영 (by김형섭)\n* 토스페이 지원 프로모션 적용 확인 필요 (3만 원 이상 구매 시 5천 원 할인)\n* 지원 방식: 선/후지급 여부 파악 후 자사몰에 배너 기획 필요\n* 혜택 내용: \"5만 9천 원 → 5천 원 할인\" 메시지로 구매 유도\n\n5. 외부 협력사 및 발주 상황\n* 진명인쇄: 차량 진입 제한 → 1톤 차량으로 분할 배송 (블랙/블루/화이트).\n* FNH(3PL)과 **사전 입고 스케줄 공유 필요**\n* 텀블러(아블러 등) 출항 일정 확인 → 12일 예정.\n* 일부 발주(아블러 등) 이미 진행 완료 (30% 선금 지급)\n\n6. 향후 일정 및 일정 관리(by이호혁)\n* 듀오 조립 완료 예정일: 5월 23일\n* 생명의 물 라이브쇼핑: 5월 26일\n* 6월 중 큰 캠페인: 6월 22일 ‘술 익는 집’ 캠페인 → 주중 초안 전달예정\n\n7. 협력사 이슈 및 품질관리(by이호혁)\n* 스피어 다이아몬드 관련 이슈 발생 → 문제점 명확히 파악 후 커뮤니케이션 필요\n* 성준테크 등 조립 자재 입고 여부 확인 → 입고 수량 확인 필요 (예: 4410개)\n\n8. 태그바이(Tagby.io) 및 리뷰 관리(by권나경)\n* 태그바이 캠페인: 5월까지 무료, 6월부터 유료 전환 (월 10만 원)\n* 플랫폼별 리뷰 현황 점검 완료 (아블러, 카카오 선물하기 등)\n* 캠페인 마무리 후 추가 진행 예정"},
  {"id": "preset-m-2025-04-30", "date": "2025-04-30", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 광고 소재 및 영상 촬영 기획\n목표: 기존 광고소재 성과 유지 + 새로운 영상으로 리플레이스 준비\n어쿠스틱 드링크 영상(36초)이 가장 우수 → 벤치마킹하여 B급 퀄리티로 자체 촬영\n촬영 계획:\n아블러 제품 특징 강조\n불투명 얼음 vs 투명 얼음 비교\n컷 구성 후 편집 → 10~15초 문제점, 25초 강점 강조\n실행 주체: 팀장, 권 과장\n기한: 얼음 미리 준비 → 내일 촬영\n\n2. CS 대응 방침 정리\n이슈: 고객 불만 사례 (얼음 분리 문제 등)에 대한 대응 기준 미비\n사용 미숙 vs 제품 결함 구분 필요\n원칙 제안: 명확한 불량 = 즉시 환불/교환\n사용 미숙 = 설명 후 대응 (필요시 교환)\n사용법 안내자료 보완\n\n3. 생산 및 재고 현황 공유\n듀오 제품: 몰드는 완료, 물통/외통 인쇄 진행 중\n인쇄 완료 예상일: 4월 30일\n조립 및 입고 예상일: 5월 16일경\n아블러 스피어: 일부 재고 입고 완료\n불량 대응 포함 출고 시작\n출고: 150개 선출고 → 잔여 수량 입고 후 마무리\n\n4. 글로벌 채널 (Shopee) 운영\n싱가포르 중심 초기 운영 제안 → 집중 마케팅 전략\n제품명 길이 문제로 일부 국가 등록 누락 발생 → 영문 제품명 길이 보완 필요\nDHL로 배송, 일부 국가는 창고 입고형 판매 가능 여부 확인 중\n퍼블리시 처리 완료 국가: 싱가포르 외 대부분 등록\n\n5. 패키지 개선 및 굿즈 검토\n여름 캠핑 시즌 대비 3~6구 아이스 캐리어 패키지 기획\n칸막이/색상/사이즈 등 샘플 구매 후 검토 예정\n기준: “받았을 때 만족감이 있어야 증정/판매 의미 있음”\n\n6. 상세페이지 및 웹사이트\n상세페이지 수정 완료 → 대표 검토 후 피드백 예정\n아블러 제로, 듀오 페이지도 수정 진행 중\n상단 메뉴 페이지 구성 기획안 팀장 주도 하에 진행 예정 (브랜드/미디어/사용법 등)\n\n7. 자사몰/네이버/쿠팡 광고 전략\n연휴 전후 주문 감소 예상 → 자사몰 광고 최소화, 쿠팡 광고 집중\n쿠팡 자동 예산 규칙 OFF → 고정 예산 25만 원 전략 제안\n광고 소재 지속 생산 루틴화 필요: 주 1회 이상 자체 촬영/기획 원칙 설정"},
  {"id": "preset-m-2025-04-25", "date": "2025-04-25", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 웹사이트 및 상세페이지 관련\n- 각 탭별 콘텐츠 구성안 초안 → 대표와 사전 협의 필요\n- 디자인 가능한 부분은 내부 진행, 불가능한 것은 외주로 분리\n- 웹사이트 전체 일정: 5월 초~중순 오픈 목표\n- 오픈 시점에 맞춰 고객공지, 세일 이벤트, 재고 입고 일정 연계 기획 필요\n\n*상세페이지 피드백*\n- 모바일 친화적 구성 필수\n- 세부 섹션별 핵심 이미지 또는 GIF 필요 (예: 손잡이 분리, 얼음 밀어넣기 시연 등)\n- 이미지 품질 부족 시 텍스트로 대체 가능\n- 일관된 폰트, 크기 설정 (가독성 기준)\n- GIF 촬영 필요한 경우 자체 제작 고려\n- 인테리어성 이미지 및 리뷰 사진 적극 활용\n- 고객이 직관적으로 이해할 수 있는 정보 전달 방식 최우선\n\n2. 제품 준비 및 출고 일정\n- 29일 EXW 조건 픽업 예정\n- 실링 스티커 일부 미입고 → 발주 및 팔로업 필요\n- B급 조립 제품 구성 논의 → 외통 블랙 단일 컬러로 진행 예정\n- 주요 출고 대상: 실리콘 몰드, 보관통, 유리컵 등\n\n3. 세일 이벤트 기획\n- 웹사이트 오픈 후 5월 12~16일 사이 세일 기획안 마련\n- 상세페이지 고도화 후 자사몰, 쿠팡, 스마트스토어 일괄 적용 예정\n- 세트 구성 (예: 텀블러 + 몰드) 기획 → 별도 상세페이지 제작 및 광고 활용\n\n4. 기타 업무 진행 사항\n- 쇼피파이 상세페이지 등록 완료, 노출 문제 확인 중\n- 아마존 입점 제품 광고 준비 중\n- 인플루언서 마케팅 콘텐츠 제작 중이며 일정 지연 발생 → 수정 후 재촬영 필요\n- 중국발 제품 통관 진행 중\n- 주간 업무 정리 및 업무 인수인계 중 진행 상황 점검 필요\n- 아블러 제로 제품 반품률 확인 요청 → 품질 개선 여부 판단 필요\n\n5. 다음주 일정\n- 조립 일정: 4월 마지막 주 월요일 예정 (300개 조립)\n- 실링 스티커 도착 여부 확인 후 적용\n- 상세페이지 및 이벤트 콘텐츠 마무리 작업\n- 상세페이지 모바일 기준 최종 검수 필수\n- 자산 정리 및 전체 세트 구성 확정 후 각 플랫폼 업로드"},
  {"id": "preset-m-2025-04-07", "date": "2025-04-07", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 디자이너 이슈\n- 기존 디자이너 작업물 퀄리티 미흡 → 새로운 디자이너 섭외 진행 중\n- 새 디자이너 포트폴리오와 경력 요청\n- 신뢰 문제로 향후 미달 시 환불 요청 동의받음\n- 오늘까지 결과물 초안 받기로 함\n\n2. 업무 자동화 진행 상황\n- 각자 맡은 업무 중 **시간 많이 소모되는 일 자동화 준비** 지시\n- 메타 광고/매출 정리 자동화 방안 논의 (API 연결, 자동 업데이트 등)\n- 박 이사님: 채널톡 응대 자동화 툴 찾기\n- 호영찬 차장: 메타 광고 대시보드 세팅 여부 확인, API 자동화 방법 찾기\n- 스마트스토어 리뷰/문의 관리 자동화는 당장 필요성 낮음 판단\n\n 3. 생산 및 납품 일정 관리\n- 롯데건설 특판 건 진행 상황 공유: 오늘 컨펌 여부 결정\n- 생산 일정, 재고 파악 필수 (FNH 협력사 관리)\n- 납기 일정 맞추기 위해 컨펌 후 양산 요청\n- 인쇄 및 조립 프로세스에 대한 최적화 방안 논의 (8일 절감 가능성)\n\n 4. 코르비 캠페인\n- 인스타 영상 바이럴 성공 (60만 조회수)\n- 사전모집 1600명 달성\n- 공동구매 본공고 오픈 예정 → 이후 트래픽 증가 예상\n- 수조 캠페인은 확산력 약함 (요리 콘텐츠 한계?)\n\n5. 쇼피파이 해외몰 이슈\n- 배송비 문제로 구매 전환률 저하 우려\n- 배송비 정책 재정비 필요 (무게별 10/20/30불 설정 재확인)\n- 장바구니 이탈 원인 분석 요청\n- 리뷰 부족 문제 → 리뷰 작성 및 세팅 필수\n- 쇼핑몰 링크/세팅 오류 수정 요청\n\n6. 신제품 기획 논의 (아블러 자이언트 버전)\n- 물통을 내장한 새로운 대형 텀블러+아이스 메이커 아이디어\n- 기존 아블러보다 사용 용량 확대 / 보관 편리성 강화\n- 기능성과 편의성 두고 내부 논의 진행 (의견 분분)\n- 추가 소싱 검토 (트라이탄/에코젠 소재 등)"},
  {"id": "preset-m-2025-04-01", "date": "2025-04-01", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. AI 도입 및 활용 실험 공유 (계약서 작성 사례)\n   - 기존 계약서를 ChatGPT(GPT)에게 요약 및 수정 지시 → 빠르고 정확한 문서 생성\n   - 명확한 지시어를 줄수록 정확도가 높아짐\n   - 반복적이고 수작업 중심인 업무는 AI에 위임하여 효율화 필요\n2. AI 비서화 전략\n   - 각 팀원이 개인 GPT를 \"AI 비서\"로 설정하여 업무 자동화 시도\n   - 예: 업무 요청, 회의 준비, 문서 작성, 반복 업무 요약 등\n   - 명령어와 히스토리를 누적시키면 개인화 수준 향상됨\n3. 업무 자동화 우선순위 제안\n   - 호혁 차장: 매출 집계, 발주서 전달, 광고비 정리 \n    → API 및 구글 시트 연동으로 자동화 가능,자사몰/오픈마켓 매출 취합, FNH 전달 업무 → 플랫폼 연동 자동화 필요\n   - 권 과장: 리뷰 응대, 상세페이지 리뉴얼, 중국 수입 통관 업무 → 템플릿화 및 반자동 응답화\n   - 박 이사: 인플루언서 섭외, 생산 발주, 고객 응대 → 채널톡 자동응답 시스템 개선 연계\n4. 디자인 협업 구조 구축\n   - 외주 디자이너와 피그마 중심의 협업 체계 도입 예정\n   - 요청자는 명확한 가이드와 기획안 전달 필수 (톤앤매너, 예시 포함)\n   - 상세페이지는 **와이즐리 스타일** 참고: 간결하고 임팩트 있는 정보 구조 지향\n   - 디자인 요청서 작성 필수 (업무 요청 간소화 및 소통 오류 최소화)\n5. 플랫폼 자동화 논의\n   - 사방넷, 카페24, 위지 어드민 등 기존 사용 툴 재정비 필요\n   - 중복 업무 제거 및 API 자동화 고려\n   - 반복 업무는 \"점검\" 위주로 전환하는 것이 목표\n6. 4월 중점 과제\n   - 팀별 업무 자동화 계획 수립 및 테스트 실행\n   - 채널톡 자동응답, 매출 API 연동, 리뷰 자동화 등 실험\n   - 텀블러 및 신제품 출시 대비, 상세페이지 기획 선행\n7. 향후 마케팅 방향 제안\n   - 듀오 가격 정책 탄력 운영 (4만9천~5만9천)\n   - 주얼아이스와 아블러의 브랜드 구분 기획(BI/CI 분리)\n   - 가정의 달 및 여름 시즌 기획안 사전 기획 지시"},
  {"id": "preset-m-2025-03-28", "date": "2025-03-28", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 리뷰 쌓기 및 쿠폰 제공\n-리뷰 쌓기 비용\n리뷰 한 개를 쌓는 데 드는 비용은 약 1만 3천 원에서 1만 5천 원 정도로, 물건값, 수수료, 세금 등을 포함한 비용으로 계산됨.\n-리뷰 참여 유도 방법\n쿠팡, 오늘의 집, 카카오 선물하기 등 다양한 플랫폼에서 리뷰 참여를 유도하기 위한 방법으로, 배너나 메시지 등을 통해 유도하는 방안이 필요하다고 의견 공유됨.\n-리뷰 참여 유도\n커피 쿠폰 등의 혜택을 제공하여 리뷰 작성을 유도하는 방안을 논의. 이 방식에 대한 효과를 한 달 동안 트래킹하여 검토할 예정임.\n\n2. 카카오톡 및 배너 활용\n-카카오톡 메시지 발송\n카카오톡을 통한 메시지 발송은 제한적임. 대신 배너 형태로 리뷰 참여를 유도하고 이를 통해 전환을 촉진하는 방법을 검토함.\n-배너 활용\n리뷰 참여 유도를 위한 얇은 배너 형태의 광고를 다채롭게 활용할 계획. 여러 플랫폼에서 배너를 효율적으로 활용할 방안을 논의함.\n\n3. 리뷰 쌓기 프로세스\n-리뷰 쌓기 어려움\n자사몰 및 네이버 페이에서 리뷰가 부족한 상황이 지속되고 있음. 이를 해결하기 위해 적극적인 리뷰 유도 방법을 시도할 필요성이 제기됨.\n-리뷰 관리\n구글 폼 등을 활용해 리뷰를 신청받고 관리하는 방법이 논의되었으나, 고객들이 이를 잘 사용하지 않을 가능성도 있어 다른 대안을 함께 검토하기로 함.\n\n4. 인플루언서 마케팅\n-인플루언서 협업\n텍바이, 디스패치 등과 같은 인플루언서 플랫폼을 통한 마케팅 강화 방안이 논의됨. 인플루언서에게 제품을 제공하고 이를 홍보하도록 유도하는 방식.\n-비용 절감 방안\n직접 인플루언서를 섭외하여 비용을 절감할 수 있다는 의견이 나왔으며, 이를 통해 광고 비용을 줄이고 효율성을 높이는 방안이 제시됨.\n\n5. 광고 및 콘텐츠 전략\n-광고 소재 개발\n다양한 광고 소재와 영상 콘텐츠를 개발하여 전환율을 높일 필요성이 제기됨. 기존 킥스타트 영상 자료를 활용한 콘텐츠를 제작하여 광고를 진행할 예정.\n-광고 전환율 개선\n전환율을 높이기 위해 상세 페이지 개선과 다양한 광고 소재를 시도하는 방법을 논의. 또한, 사용자 경험(UX)을 개선하여 광고 효과를 극대화할 방안을 모색.\n\n6. 제품 소싱 및 판매 전략\n-제품 소싱\n빠르게 시장에 출시할 수 있는 제품을 선택하고, 기존 제품에 로고를 추가하거나 상세 페이지만 개선하여 광고를 돌리는 전략이 논의됨.\n-제품군 확대\n보관통, 아이스 메이커, 텀블러 등 다양한 관련 제품을 추가하여 제품군을 확대하고, 객 단가를 높이는 방안을 검토함.\n\n7. 디자인 및 웹사이트 개선\n-디자인 개선\n웹사이트 디자인 및 상세 페이지를 개선하여 전환율을 높이자는 의견이 제시됨. 특히, 4월 1일 이전에 새로운 웹사이트 론칭을 목표로 디자인과 페이지 개선을 신속히 진행할 예정."},
  {"id": "preset-m-2025-03-24", "date": "2025-03-24", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 냉동고와 창고 정리를 완료\n2. 쇼피 입점과 상품 등록이 완료되어 판매 가능한 상태.\n아마존은 과거 입점 자료를 기준으로 진행할 예정이나, 복잡한 절차로 시간이 걸릴 것으로 예상.\n생산 발주가 완료되었으며, 관련 진행 상황은 현재 진행 중.\n\n3. 제품 포장 및 입고:\n송준태 담당자가 박스 세팅과 바코드 작업을 통해 제품을 정리하고 입고할 예정.\n성준 테크에서 남은 텀블러 600개의 조립을 위해 발주가 이루어졌으며, 재고 관리를 위한 작업이 필요.\n\n4. 리뷰 및 마케팅:\n리뷰 이벤트 배너가 반려되었고, 새로운 템플릿을 통해 다시 신청할 예정.\n알파 리뷰 서비스와 관련하여 제품 리뷰를 쌓기 위한 전략이 논의됨. 알파 리뷰에서 광고 템플릿을 추가할 방법을 찾아볼 예정.\n제로 제로 아블러와 관련된 브랜드 커넥트를 기획하여 제품 발송 및 리뷰를 진행할 예정.\n리뷰와 구매평을 지속적으로 쌓아가는 전략이 필요.\n\n5.광고 및 마케팅 예산:\n메타 광고, 유튜브, 어쿠스틱 광고의 광고비와 매출 비율을 분석하여 예산을 관리.\n\n6. 은수저 제품에 대한 광고 예산과 전환율을 분석 필요. 예산과 기대되는 수익을 기준으로 결정할 예정.\n\n7. 광고 소재 확보를 위해 인플루언서와 협력하여 다양한 콘텐츠를 만들고 이를 활용할 계획.\n\n8.기타 업무:\n\n업무 매뉴얼 작성 예정, 이를 통해 각자의 업무를 명확히 하고, 향후 작업에 도움이 되도록 할 것.\n\n특정 제품의 재고 확인 후 광고나 마케팅을 결정할 계획."},
  {"id": "preset-m-2025-03-17", "date": "2025-03-17", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 리뷰 이벤트 비용 및 진행 방식(권나경)\n-리뷰 이벤트 비용 분석: 제품비 + 수수료 = 약 15,000~17,000원 발생\n-플랫폼 수수료는 별도로 없음 (단, 쿠팡 등에서 수수료 차감 가능성 고려)\n-대안 제안: 리뷰어에게 커피 쿠폰 제공\n-조건: 사진 3장 + 30자 이상 텍스트 작성\n-방식: 카카오톡 채널을 통해 인증 및 쿠폰 지급\n-배너 크기를 줄이고 클릭을 통해 상세 내용을 확인하는 방식으로 변경\n\n2. 영상 및 사진 정리 방식(박경열)\n-영상 분류:\nA: 5분 이상 (중요 영상)\nB: 1~3분 (일반 영상)\nC: 숏폼 영상 (짧은 클립)\n-사진 분류:\nA: 전문 작가 촬영\nB: 내부 촬영\nC: 리뷰어 제공 사진\n-목적: 외부 업체 공유 시 명확한 구분을 위해\n\n3. 영상 편집 및 제작 업체 선정 (크몽 활용-권나경)\n-편집 업체: 3만원 예산\n-제작 업체: 30만원 이하 예산\n-3~4개 업체 리스트 선정 후 협의 진행\n\n4. 상세 페이지 기획안 작성(권나경)\n-쥬얼아이스, 아블러, 아블러 제로 3개 제품의 상세 페이지 최신화\n-기존 메타 광고 소재 파일을 참고하여 기획안 작성\n-피그마 등 활용 가능한 업체 선호\n\n5. 실리콘 몰드 및 보관 통 정리(박경열/이호혁)\n-보관통 구매 및 제품 정리\n-냉동고 내 기존 얼음 정리 후 라벨링 작업 진행\n-냉동고 해동 및 건조 후 다시 사용 준비\n\n6. 주간 매출 보고\n-주말 매출: 약 2,400만 원\n-코스트 뱅크 매출: 약 1,700만 원\n-쇼폼 조회수: 3일간 59만 회 기록\n\n7. 광고 및 추가 업무\n-광고 성과 점검\n-매출 분석 및 보고\n-주간 업무 일정 업데이트 및 마감 일정 확인\n\n📌 다음 업무 진행 사항\n-리뷰 이벤트 플로우 최종 확정 및 배너 수정\n-영상/사진 폴더 정리 및 외부 업체 공유 준비\n-크몽 업체 3~4곳 선정 후 협의 진행\n-상세 페이지 기획안 작성 및 외부 업체 컨택\n-실리콘 몰드 정리 및 보관통 구매\n-광고 성과 점검 및 매출 분석 후 보고"},
  {"id": "preset-m-2025-03-10", "date": "2025-03-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 발주 및 재고 관리(권나경, 이호혁)\n아블러 발주: 오늘 또는 내일 발주 진행.\n듀오메이커 발주: 15일 매출 상황을 보고 결정.\n검수 기간: 공식 생산 시간 45일 + 검수 5일 추가 제안. 중간 검수 필요성 강조.\n텀블러 레이저로 변경된 로고 확인 필요. 영상으로 검수 가능성 논의.\n\n2. 가격 및 배송료 전략(이호혁)\n미국 배송료: 기존 10불 배송비 설정에 대해 논의.\n상품 가격 49,000원으로 낮추는 방안 검토.\n50불 설정 시 10불 배송료로 7만 7천 5백 원에서 2만 5천 원 배송비를 뺀 마진 확보 가능.\n배송 옵션:DHL 외 대안 없음.\n다량 구매 시와 소량 구매 시 가격 및 배송료 차등 적용 필요.\n적정 가격 설정: 60불은 부담, 49불 선에서 조정 검토. 30불 배송료는 과도하다는 의견.\n\n3. 광고 및 마케팅(이호혁)\n쇼핑 파이 광고:메타 광고로 진행해야 함. 과거 킥스타터 광고 소재 재활용 제안.\n랜딩 페이지:제품 소개 영상 제작 필요.영어 자막 추가 검토.\n광고 소재:듀오와 아블러 광고 소재 필요. 메타와 쿠팡에서 광고 진행 계획.\n크리에이터와 협업: 제품 홍보 시 타 제품 노출은 부정적. 인트로 페이지 선호, 다양한 제품 홍보는 어려움.\n\n4. 텀블러 및 얼음틀 관련(권나경)\n텀블러 소싱: 아블러와 호환 가능한 텀블러 샘플 요청(에벤에셀), 입구가 넓은 텀블러 필요 (65mm 이상).\n얼음틀 문제: 실리콘 소재 선호, 뚜껑 필수.\n얼음 크기 및 용량 명시 필요 (150ml 기준).\n신제품 기획: 투명 얼음 및 막대 얼음 키워드 활용.(텀블러+얼음틀 세트 구성 검토)\n\n5. 제로텀블러 플랫폼 및 입점 전략\n스마트 스토어: 광고 불가로 입점 보류.\n쿠팡 및 자사몰: 리뷰 20개씩 확보 계획.\n원보 등록:네이버 카탈로그 등록 검토 필요.\n\n6. 업무 매뉴얼 작성\n진행 상황:업무 매뉴얼 작성 미비.카페24 등 링크 활용한 간소화 방안 논의.\n크로스 업무 필요: 중국 소싱, CS, 구매평 등 정리 필요.\n\n7. 금주 주요 일정\n˚이번 주 목표: 듀오 메이커 광고 소재 촬영.\n˚제로 텀블러 페이지 및 상품 등록 완료.\n˚쇼핑 파이 광고 소재 및 테스트 진행."},
  {"id": "preset-m-2025-03-04", "date": "2025-03-04", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 통관 및 출고 관련(권나경)\n빨대: 통관 진행 중이며, 이슈가 없으면 내일 출고 예정. 이슈 발생 시 재논의 예정.\n진명 인쇄: 입고 후 바로 진행.\n\n2. B2B 제안서 및 판촉물 입점진행(권나경)\n제안서: 카테고리별로 내용 각색 후 메일 및 SNS DM으로 발송 예정.\n입점: B2B 판촉물 사이트 10군데 입점 추진 중.\n1위 상품: 텀블러가 상위권, 다른 특이한 상품으로도 주목 유도 계획.\n\n\n3. 텀블러 조립 및 발주(이호혁)\n조립: 기존 구형 텀블러 1680개는 몰드로 판매, 나머지 조립 진행.\n발주: 3월 15일 워크스 링크 판매 추이 보고 결정.\n몰드: 개별 판매 진행 예정.\n\n4. 해외 배송 및 가격 정책(이호혁)\n배송비: 현재 30불 → 10불로 낮추고 상품 가격 조정 제안.\n환산 가격: 4만 2천 원 기준으로 달러 가격 조정.\n배송비 문제: 높은 배송비가 구매 전환에 허들로 작용.\n\n5. 광고 및 공동구매 전략(박경열)\n리뷰하는회사원 공동구매 성과: 조회수 45만, 판매 전환 저조.\n가격 정책: 3만 9천 원 기준 30% 수수료 정책 유지 검토.\n유튜브 쇼츠 vs 인스타그램 릴스: 쇼츠가 더 효과적일 것으로 판단, 릴스는 연결된 쇼핑몰 부재로 쇼츠로 진행 예정.\n\n6. 카페24 운영 대행 제안(박경열)\n제안: 전체 매출의 3~5% 수수료로 운영 대행 검토.\n내용: 상품 발주, 업데이트 등 관리 서비스 포함.\n\n9. 성남산업진흥원 지원 사업(박경열)\n제안: 유튜브 쇼핑 및 스마트스토어 기반 콘텐츠 마케팅 지원.\n조건: 성남 소재 사업자 대상, 생명의 물이 주체.\n매출 기록: 높은 매출 기록 시 지원금 수혜 가능성.\n\n10. 주간 업무 및 매뉴얼 정리(전사)\n업무 체계화: 오전/오후 일정 및 매뉴얼 작성 계획.\n정리: 주간 업무 보고서 작성 및 체계적인 관리 필요."},
  {"id": "preset-m-2025-02-24", "date": "2025-02-24", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "- **실리콘 안료 사용 및 증빙(권나경)\n  - 실리콘 안료를 얼음 틀(금형)에 넣어 사용하는 방식으로 진행.\n  - 구매 대행 측 요구에 따라, 제품 제작 시 사용되는 소모품임을 증빙할 수 있는 사진, 서류 등 자료 확보 필요.\n\n- **생산 및 포장 관리(이호혁)\n  - 생산처와 협의 후 주문 수량(예: 블랙 와이드 3500개, 기타 2000개 등) 및 개별 포장, 박스 주문 재확인.\n  - 생산 리드 타임 고려(실리콘 안료는 2달 이상 소요) 및 향후 한꺼번에 박스까지 생산하는 방안 검토.\n  - 재고, 바코드, 조립 등 내부 문서화 및 체크리스트 공유 필요.\n\n- **광고 및 마케팅 전략(이호혁)\n  - 인플루언서 마케팅과 페이스북, 쿠팡 등 다양한 플랫폼 광고 진행.\n  - 금요일과 월요일에 광고 세팅을 집중하여 전환 비용(CPA) 및 효율 관리.\n  - 광고 소재는 주기적으로(예: 주 2회) 제작·업데이트하며, 성과 기준 미달 시 교체 결정.\n  - KPI 설정과 전환율, 광고비 대비 매출 분석을 통해 효율 개선 추진.\n\n- **내부 관리 및 외부 커뮤니케이션\n  - 주문, 생산, 재고 관리 등 관련 문서를 공유하고, 각 부서(생산, 마케팅, 물류) 간 협업 강화.\n  - B2B 제안서 및 CRM 마케팅(회원 전용 할인, 이메일 발송, 채팅 시스템 등) 자료 업데이트 및 외부 업체와의 소통 진행.\n  - 계약서, 제안서 등 문서 검토 및 승인 절차 재확인.\n\n- **기타 논의 사항**\n  - 제품 촬영 및 샘플 발송 일정 조율(예: 촬영일 28일, 냉동 보관 및 발송 일정 등).\n  - 제품 구성 요소 개선: 세척솔, 빨대 등 사용 편의성 및 품질 관리 방안 논의.\n  - 외부 광고 대행 및 콘텐츠 제작(내부/외주) 관련 방향성 검토."},
  {"id": "preset-m-2025-02-17", "date": "2025-02-17", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 영상 촬영 및 업데이트(to이재현)\n\n업무 진행 상황 및 링크를 공유하여 확인할 수 있도록 해야 함.\n지난주에 계획했던 업무 진행 여부를 확인 후 이번 주 계획을 수립.\n기존 촬영된 영상 검토 후 필요한 경우 재촬영 진행.\n관련 링크를 확인하고 활용할 수 있는 부분 반영.\n최종 영상 업데이트 후 이사님께 공유하여 리스트업 후 배포.\n\n2. 해외 제조업체 관련 업무(to권나경)\nFNH와의 협의 사항\n핸들링 범위가 명확하지 않아 추가 조율이 필요.\n해외 제조업소 등록부터 진행해야 하며, 전체 프로세스를 정리하여 추진.\n한글 표시 사항 등 필요한 문서 작업 병행.\n필요시 대행 업체를 활용할 수 있는지 비용 검토.\n\n3. 제품 생산 및 발주(to박경열이사)\n컬러 박스 생산 진행\n발주 완료, 납품 일정 및 추가 생산 여부 체크 후 중간 보고 예정.\n실링 스티커 발주 여부는 주말 상태 확인 후 결정.\n어쿠스틱 드링크 일정 3월 8일에서 3월 15일로 일정 변경.\n계약서는 카페24를 통해 진행 가능하며, 중개 수수료 절약 방안을 검토.\n\n4. 마케팅 및 광고 진행 현황(to이호혁차장)\n-광고 성과 분석\n쿠팡 광고 성과 분석 중, 전환율 낮아 광고비 조정 검토.\n현재 광고비 8만 원 사용 중, 효율성을 고려하여 2~3만 원으로 조정 검토.\n메타 광고 전반적으로 효율 감소, 상세 데이터를 검토하여 최적화 필요.\n-콘텐츠 활용 및 테스트\n광고 원본을 활용하여 자사 페이지 및 메타 광고에 적용해 성과 테스트 예정.\n술 관련 콘텐츠는 빌드업 부족으로 전환율 낮음, 향후 방향 조정 검토.\n\n5. B2B 제안 및 협의(to박경열이사)\nB2B 제안서 작성 및 배포\n기존 유통사 및 실무자들과 협의 후 제안서 작성 및 배포 예정.\n콘텐츠 촬영 후 상세 페이지 스토리라인 작성.\n미팅 일정 조율\n\n6. 우아 컴퍼니 및 카페24 팀장과의 미팅 일정 조율 중.(to박경열이사)\n\n7. 내일 회의(아블러 생산업체) 준비(to권나경)\n화상 회의는 위챗으로 진행 예정.\n회의 전 내부적으로 개선 사항 검토 후 논의.\n권 과장이 중요도를 정리하여 제안 방안 마련."},
  {"id": "preset-m-2025-02-14", "date": "2025-02-14", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 생산 및 물류 진행 상황(이호혁차장)\n\n3월 말까지 10,000개 생산 요청하였으나 2개월 소요 예상.\n일부 물량만 3월 말에 입고 가능, 조립 일정 조정 필요.\n현재 조립은 내부에서 진행 중이며 2월 22일까지 마무리 예정.\n현재 입고된 수량: 900개, 450개, 1200개.\n1200개 입고 완료 예정일: 2월 23일.\n물류 이동 후 비용 분석 진행 중, 결과 공유 예정.\n\n2. 킥스타터 및 글로벌 판매 전략(이호혁차장)\n킥스타터의 주요 목표는 수익보다는 브랜드 신뢰 구축.\n광고 효과 분석 후 자체 광고를 활용한 직접 판매 전략 검토.\n쇼피파이 및 아마존 입점 진행 중.\n배송비 이슈 해결 필요 (현재 1kg당 12,000원~16,000원 수준).\nERP 도입 검토 중 (재고 및 주문 관리 자동화 필요성 대두).\n\n3. 인플루언서 협업 및 마케팅 진행 사항(박경열 이사)\n리뷰 콘텐츠 및 공동구매 일정: 2월 25일.\n유튜브 쇼핑 활용 확대 검토.\n인플루언서 협업 관련 계약 조정 진행 중.\n커뮤니티 마케팅 제안 검토 (맘카페 등 자연스러운 홍보 전략 논의 중).\n퍼포먼스 광고 테스트 지속 진행, 새로운 광고 소재 활용 검토.\n\n4. 신규 제품 소싱 및 추가 판매 전략\n얼음 집게 및 보관통 옵션 추가 판매 결정.\nERP 시스템 도입 검토 (재고 및 주문 자동화 필요성 대두).\n신규 제품 소싱 논의 (신박한 아이템 발굴 및 인플루언서 마케팅 활용 검토).\n텀블러 세척솔 판매 결정 (고객 반응 미흡).\n\n5. 성인용 제품 판매 관련 논의\n\nOmiel 브랜드 제품의 시장 반응 조사 진행 중.\n관련 플랫폼 검토 필요 (OnlyFans, 성인 방송 플랫폼 등 활용 검토).\n기존 마케팅 방식과 차별화된 전략 필요."},
  {"id": "preset-m-2025-02-10", "date": "2025-02-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 영상기획\n-제로텀블러 컨셉샷 촬영(이재현인턴, 박경열 이사)\n-각인얼음 영상촬영(이재현인턴) / 커스텀 아블러 b2b 제안서 (권과장)\n\n2. 제품소싱\n-빨대 1200개 발주, 식검 필요여부 체크(권나경 과장)\n-아블러 텀블러 재발주건 수량 차주 논의(전사)\n-텀블러 CS취합하여 생산처 전달할 문서작성(박경열 이사)\n\n3. 제로텀블러 부자재 생산관련\n-2월 마지막주 컬러 박스완성, 빨대수입통관 일정 팔로우업(박경열이사 / 권나경과장)\n\n4. 에프앤에이치 물류 내방건 보고, 개별몰드 판매 일정 (이호혁 차장)\n아블러 해골 몰드(400) - 개별포장+바코드\n아블러 아이스볼 (1,000)- 개별포장 +바코드\n부자재 입고 수익율 계산( 입고수량 - 프로모션 = 총 판매수량)"},
  {"id": "preset-m-2025-01-13", "date": "2025-01-13", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 어떤 업무던 문서화 시킬 것 / 보고할 때도 문서로 보고할 것\n2. 아블러 12월중 출고건 금일 발송예정(에프앤에이치)\n3. B급몰드 듀오메이커 결합하여 유통시작\n4. 아블러 광고 소재 기획하여 본격적으로 가동"},
  {"id": "preset-m-2024-12-26", "date": "2024-12-26", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 아블러(텀블러) 2차 발주 건 차주 입고예정\n2. 실리콘몰드 생산 수량에 맞추어 조립, 출고 전달\n3. 리퍼몰드(1,000)먼저 재고소진 할 것  \n4. 12월 매입 세금계산서 처리(성준테크)\n5. 진로 두껍 프로젝트 디자인에셋 오늘 전달예정( 추가 소싱할 제품 협업: 김과장or권과장)\n6. 아블러 인플루언서 섭외 진행(권과장)\n7. 광고소재 및 성과, 매출체크 데일리업무 진행 할 것 (이차장, 박이사)"},
  {"id": "preset-m-2024-12-20", "date": "2024-12-20", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 아블러(텀블러) 2차 발주 건 차주 입고예정\n2. 성준테크 10,000개 발주 건 생산진행상황 팔로우업(호혁차장)\n3. 오미엘 슬로건 결정\n4. FNH 이지어드민 검토, 액세서리 제품 바코드 생성하여 유통\n5. 불량스틱몰드 리퍼 유통판매 기획\n6. 외통제외한 듀오메이커 엔트리모델 기획 검토\n7. 웹페이지 리뉴얼 업체 견적 검토\n8. 1월중 생물 리뷰이벤트 진행 기획"},
  {"id": "preset-m-2024-12-02", "date": "2024-12-02", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 블프기획전 매출 부스팅 필요(카키 재고 소진할 수 있는 기획전 차주진행)\n2. 사무실 정리 계획(금주내로 일정픽스, 필요물품 대표님 컨펌)\n3. 오미엘 / 제로텀블러 기획안 공유 (바코드 생성 등 권과장 협력)"},
  {"id": "preset-m-2024-11-08", "date": "2024-11-08", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 아블러 생명의물 구독자 리뷰이벤트 진행시기 픽스 할 것(생명의물 측 의견 취합하여 결정)\n2. 블랙프라이데이 런칭준비(차주내로 완료할 것)\n3. 아블러 몰드 큐브 및 텀블러 실버 재고파악 먼저 할 것\n4. 아블러 박스 디자인수정\n5. 아블러 로고인쇄 샘플 체크 후 생산요청\n6. 블프런칭전까지 메타광고 투입금액 유지\n7. 12월말까지 텀블러 입고 및 실리콘몰드 10,000개 입고 완료할 것"},
  {"id": "preset-m-2024-11-04", "date": "2024-11-04", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 아블러 발주수량 파악(중국측 견적확인)\n2. 물류스토리 컨텍하여 조립, 배송비 견적체크(호혁차장)\n3. 긱불, 꺌랑 등 아블러 협업 유튜브채널 발굴(박이사)\n4. 생명의물 리뷰이벤트 예산 100만원선으로 기획(권과장)"},
  {"id": "preset-m-2024-10-18", "date": "2024-10-18", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 듀오메이커 생산완료일정 차주 수요일 예정\n2. 해외배송 선박요금 검토(우체국), 배송방법 고객이 선택할 수 있도록 할것\n3. 고객디비 메타자산입력완료 리타겟 마케팅에 적극 활용\n4. 자사몰 옵션가격수정(화이트 추가금액 품절처리)\n5. 플랫폼별 옵션등 체크하여 이탈방지할 수 있도록 수정(최대한 심플하게 통일)\n6. 쿠팡 리뷰 많은쪽 상품으로 주력판매(통합)\n7. 스타터킷 재고소진을 위한 마케팅 이벤트 기획, 메타광고 진행\n8. 차주 위즐볼 팝업이벤트를 위한 얼음지원 300개 발주예정"},
  {"id": "preset-m-2024-10-14", "date": "2024-10-14", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 어쿠스틱드링크 유튜브공동구매 달성률 107%로 마감\n2. 아블러 시딩형 캠페인 진행-브랜드커넥트\n3. 듀오메이커 플랫폼별 가격통일(69,000원)일괄적용/메타광고에도 적용\n4.아블러, 듀오메이커 배송메시지 기획,제작\n5.아블러 메타광고 예산증액->8만원\n6. 아블러 조립일정잡기\n7. 자사몰 아블러 리뷰 내부작성 가능한지 여부 체크"},
  {"id": "preset-m-2024-10-11", "date": "2024-10-11", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 카카오메시지 발송에 대한 기회비용을 메타광고쪽으로 전환할것\n2. 아블러 기타 플랫폼에도 입점할 것(달리, 펀샵, 오늘의집 등-권과장)\n3. 아블러 소개 리플릿 아웃라인잡고 기획(권과장)\n4. 와디즈 고객DB 메타자산으로 입력(리타켓팅 설정에 이용)\n5. 아블러 광고소재 생성/ 광고비 증액(6만원)\n6. 마케팅툴플랫폼에 대한 전반적인 검토필요 분석하여 보고(이차장)\n7. 알파리뷰 구독서비스 이용유무 검토(박이사)"},
  {"id": "preset-m-2024-10-10", "date": "2024-10-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 플랫폼별 상세페이지 가격 및 옵션선택동선 체크하여 보고(권과장)\n2. 메타광고 내용 줄이고 핵심만 표시할 것, 문구와 소재 톤앤매너 유지할 것\n3. 10만원이상 결제건 수 승인 후 결제\n4. 업무보고파일 활용할 것\n5. 인플루언서 리스트 업뎃 후 발송(+안내문)\n6. 아블러 광고소재 만들 것\n7. 아블러 자사몰 알파리뷰 끌어오기"},
  {"id": "preset-m-2024-10-07", "date": "2024-10-07", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 아블러 플랫폼별 입점등록(쿠팡,올웨이즈,도매꾹-권나경)-화요일까지 마무리\n2. 아블러 자사몰 메타광고 진행(화요일부터)\n3. 목요일(10일) 아블러 런칭완료(판매시작)예정\n4. 아블러 발주상황 팔로우업-호혁차장님\n5. 업무일정계획 업무보고파일 활용할 것\n6. 11월 블랙프라이데이 일정 기획필요"},
  {"id": "preset-m-2024-10-02", "date": "2024-10-02", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 어쿠스틱 공동구매링크에 보관통 옵션추가\n2. 아블러 플랫폼별 업로드 셋팅 후 문자발송(금요일예정)\n3. 아블러 메타광고 소재 기획하여 금요일까지 세팅\n4. 실리콘 발주수량체크 후 컨펌\n5. 아블러 선물용 쇼핑백 서칭 후 컨펌\n6. 아블러 제품지원시 소개서+공급가 제안서 같이 동봉하여 발송"},
  {"id": "preset-m-2024-09-23", "date": "2024-09-23", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 어쿠스틱드링크 특가판매시 아블러 배너노출하여 유입될 수 있게 구매유도 방안\n2. 아블러 런칭일정(금주 목요일 예정)\n3. 아블러와 쥬얼아이스는 같은 자사몰, 스마트스토어로 운영\n4. 아블러 리뷰이벤트 진행\n5. 아블러 b2b판매가 책정\n6. 로켓그로스의 수익율 상승을 위한 번들, 세트판매구성 검토\n7. 성인용품 제품 소싱 검토"},
  {"id": "preset-m-2024-08-29", "date": "2024-08-29", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 썸머이벤트 금주 내 마무리 지을것\n2. 추석이벤트 기획(선물세트 기획말고, 9월 상시 이벤트로 진행)\n3. 아블러 상세페이지 내용 축소하여 기획\n4. 카페쇼 부스 업체 네고견적 비교하여 결정할 것\n5. 메타광고 진행 건 수익율 계산하여 조정할 것"},
  {"id": "preset-m-2024-08-20", "date": "2024-08-20", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 와디즈-아블러 생산일정( 텀블러/실리콘 몰드 차주 내 입고예정)\n-스티커 및 유인물, 세척솔 입고 일정 취합하여 조립일정스케줄 작성 by이차장님\n2. 와디즈 배송관련 새소식 업데이트 by 박이사님\n3. 창고물건 정리할 적재앵글 서칭, 견적받기 by권과장\n4. 아블러 후속 유통을 위한 상세페이지 및 광고소재일정 짜기by 박이사님\n5. 8월 예상 수익율 산정 후 보고 by이차장님\n6. 카페쇼 9월중 기획안 마련(업체비교견적) by이차장님\n7. 아블러 SNS홍보를 위한 인플루언서 리스트업 by권과장\n8. 아블러 리뷰플레이스 기획 by권과장"},
  {"id": "preset-m-2024-06-03", "date": "2024-06-03", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 쿠팡 재고파악 후 광고집행\n2. 플랫폼별 파스텔에디션 업로드\n3. 코트라 업체 싱가포르나 홍콩쪽 제안(영상찍어 링크로)\n4. 아블러 체험단 영역확장하여 커뮤니티 등에서 모집(10명), 기획\n5. 인플루언서 마케팅 진행\n-비타민 가족 컨셉 브이로그처럼 자연스럽게 녹이기\n6. 와디즈 알림신청 6월10일부터 진행(3주)"},
  {"id": "preset-m-2024-05-13", "date": "2024-05-13", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 섭외가능한 인플루언서 리스트업하여 공유\n2. 와디즈 펀딩 가격책정 및 리워드 구성\n3. 캔쿨러 (프리파라 생산처 컨텍) 서치\n4. 와디즈 알림신청 이벤트 기획\n5. 쇼피파이 판매가 다운\n6.ablr 생산스케줄 타임라인짜기(텀블러, 실리콘몰드)"},
  {"id": "preset-m-2024-05-13-2", "date": "2024-05-13", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 와디즈 펀딩일정\n-6월 둘째주 예상\n-알림신청기간: 6월10~27일\n-본펀딩: 6월27일~\n-배송기간:8월말 예상\n\n2. 펀딩전 to do list\n-5월20일 알렌미디어 상세페이지 촬영\n-SGS 검사테스트(to박경열이사)\n-텀블러 3D도면, 작업지시서 등 전달(to권나경과장)\n-리워드 구성(to이호혁차장)"},
  {"id": "preset-m-2024-05-10", "date": "2024-05-10", "title": "주간업무회의(전사직원)", "attendees": "", "directives": "", "content": "1. 5월 20일 에이블러 촬영일정 픽스\n-실버, 블랙 도색을 위해 샘플 발송\n-상세페이지 작업시 여러가지 메세지 넣지말고 중요한것 3개 정도로 요약해서 작업\n\n2. 와디즈 펀딩\n-알림신청 활성화를 위한 마케팅 방안 마련(예산 200만원)\n-객단가 형성을 위한 수익율 분석(to이호혁차장)"},
];

// ── localStorage / API ───────────────────────────────────────
function loadLocalTasks() {
  try { return JSON.parse(localStorage.getItem('ob_tasks') || '[]'); } catch { return []; }
}
function saveLocalTasks(list) { localStorage.setItem('ob_tasks', JSON.stringify(list)); }
function loadMinutesLocal() {
  try { return JSON.parse(localStorage.getItem('ob_minutes') || '[]'); } catch { return []; }
}
function saveMinutesLocal(list) { localStorage.setItem('ob_minutes', JSON.stringify(list)); }

function apiHeaders() {
  const token = getToken();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
// ── 인앱 알림 ────────────────────────────────────────────────
async function fetchNotifications() {
  try {
    const data = await apiFetch('/notifications');
    return data.notifications || [];
  } catch { return []; }
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
    list.innerHTML = '<div class="notif-empty">알림 없음</div>';
    return;
  }
  list.innerHTML = notifs.map(n => {
    const t = new Date(n.createdAt);
    const timeStr = t.toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
    return `<div class="notif-item ${n.read ? '' : 'unread'}">
      <div class="notif-item-title">${n.title}</div>
      <div class="notif-item-body">${n.body.replace(/</g,'&lt;')}</div>
      <div class="notif-item-time">${timeStr}</div>
    </div>`;
  }).join('');
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

async function initNotifications() {
  const notifs = await fetchNotifications();
  renderNotifications(notifs);
  // 5분마다 뱃지 갱신
  setInterval(async () => {
    const notifs = await fetchNotifications();
    renderNotifications(notifs);
  }, 5 * 60 * 1000);
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

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...apiHeaders(), ...(opts.headers||{}) } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// 저장 상태 추적 (헤더 배지에 표시)
let dataSourceStatus = 'unknown'; // 'db' | 'local' | 'unknown'

async function fetchTeamTasks(from, to) {
  let dbTasks = null;
  try {
    const data = await apiFetch(`/team/tasks?from=${from}&to=${to}`);
    dbTasks = data.tasks.map(t => ({
      id: t.id, date: t.date?.slice(0,10), who: t.assignee,
      task: t.task, status: t.status, priority: t.priority, memo: t.memo||'',
      _origin: 'db',
    }));
    dataSourceStatus = 'db';
  } catch {
    dataSourceStatus = 'local';
  }

  // DB 성공: DB tasks + (DB에 없는) PRESET ghost + localStorage 잔여
  if (dbTasks) {
    const dbKeys = new Set(dbTasks.map(t => `${t.date}|${t.who}|${t.task}`));
    const presetGhost = SHEET_TASKS_PRESET
      .filter(t => !dbKeys.has(`${t.date}|${t.who}|${t.task}`))
      .map((t,i) => ({ id:`preset-${i}`, ...t, memo:'', _origin:'preset_ghost' }));
    const local = loadLocalTasks()
      .map(t => ({ ...t, _origin: 'local' }))
      .filter(t => !dbKeys.has(`${t.date}|${t.who}|${t.task}`));
    const merged = [...dbTasks, ...presetGhost, ...local];
    return merged.filter(t => (!from||t.date>=from) && (!to||t.date<=to));
  }

  // DB 실패: PRESET + localStorage
  const local = loadLocalTasks().map(t => ({ ...t, _origin: 'local' }));
  const preset = SHEET_TASKS_PRESET.map((t,i) => ({ id:`preset-${i}`, ...t, memo:'', _origin:'preset_ghost' }));
  const all = [...preset, ...local];
  return all.filter(t => (!from||t.date>=from) && (!to||t.date<=to));
}

function refreshStatusBadge() {
  const el = document.getElementById('dataStatusBadge');
  if (!el) return;
  if (dataSourceStatus === 'db') {
    el.textContent = '💾 백엔드 저장 중';
    el.title = '입력하시는 모든 데이터가 Render PostgreSQL에 영구 저장됩니다.';
    el.style.cssText = 'background:#D1FAE5;color:#065F46;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;';
  } else if (dataSourceStatus === 'local') {
    el.textContent = '⚠ 로컬 임시저장 (백엔드 연결 끊김)';
    el.title = '백엔드 연결 실패 — 데이터가 이 브라우저에만 저장됩니다.';
    el.style.cssText = 'background:#FEE2E2;color:#991B1B;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;';
  } else {
    el.textContent = '… 확인 중';
    el.style.cssText = 'background:#F3F4F6;color:#4B5563;padding:3px 10px;border-radius:999px;font-size:11px;';
  }
}

async function createTask(payload) {
  try {
    const data = await apiFetch('/team/tasks', { method:'POST', body: JSON.stringify({
      date:payload.date, assignee:payload.who, task:payload.task,
      status:payload.status, priority:payload.priority, memo:payload.memo,
    })});
    return { id:data.task.id, date:data.task.date?.slice(0,10), who:data.task.assignee,
      task:data.task.task, status:data.task.status, priority:data.task.priority, memo:data.task.memo||'' };
  } catch {
    const local = loadLocalTasks();
    const t = { id:`local-${Date.now()}`, ...payload };
    local.push(t);
    saveLocalTasks(local);
    return t;
  }
}

async function updateTask(id, patch) {
  try {
    await apiFetch(`/team/tasks/${id}`, { method:'PATCH', body:JSON.stringify(patch) });
  } catch {
    const local = loadLocalTasks();
    const idx = local.findIndex(t => t.id===id);
    if (idx>=0) { local[idx]={...local[idx],...patch}; saveLocalTasks(local); }
    // preset task → add updated version to local
    const preset = SHEET_TASKS_PRESET.find((_,i)=>`preset-${i}`===id);
    if (preset) {
      const updated = {...preset, id:`local-${Date.now()}`, ...patch};
      const newLocal = loadLocalTasks().filter(t=>t.id!==id);
      newLocal.push(updated);
      saveLocalTasks(newLocal);
    }
  }
}

async function deleteTask(id) {
  if (!id.startsWith('preset-')) {
    try { await apiFetch(`/team/tasks/${id}`, { method:'DELETE' }); }
    catch {
      const local = loadLocalTasks().filter(t=>t.id!==id);
      saveLocalTasks(local);
    }
  }
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
  let dbList = [];
  let dbAvailable = false;
  try {
    const data = await apiFetch('/team/minutes');
    dbList = data.minutes.map(m => ({
      id: m.id,
      date: m.date?.slice(0,10),
      title: m.title,
      directives: m.directives,
      content: m.content,
      attendees: m.attendees,
      status: m.status || '진행',
      directive_states: Array.isArray(m.directive_states) ? m.directive_states : [],
      _origin: 'db',
    }));
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  // PRESET + local + DB 머지 — date+title 키 기준 DB 우선
  const local = loadMinutesLocal();
  const presetList = [...MINUTES_PRESET, ...local].map(m => ({ ...m, _origin: m._origin || 'preset' }));
  const keyOf = (m) => `${m.date}::${(m.title || '').slice(0, 40)}`;
  const dbKeys = new Set(dbList.map(keyOf));
  const merged = [...dbList];
  for (const p of presetList) {
    if (!dbKeys.has(keyOf(p))) merged.push(p);
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
  // DB 회의록 → API PATCH, preset/local → localStorage
  if (origin === 'db') {
    try {
      await apiFetch(`/team/minutes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      return true;
    } catch (err) {
      console.warn('[minutes] PATCH 실패, localStorage fallback', err);
      setMinuteStateLocal(id, patch);
      return false;
    }
  }
  setMinuteStateLocal(id, patch);
  return true;
}

async function createMinutes(payload) {
  try {
    const data = await apiFetch('/team/minutes', { method:'POST', body:JSON.stringify(payload) });
    return { minutes: data.minutes, autoCount: data.auto_tasks_count || 0, autoTasks: data.auto_tasks || [] };
  } catch {
    const list = loadMinutesLocal();
    const m = { id:`local-${Date.now()}`, ...payload };
    list.unshift(m);
    saveMinutesLocal(list);
    return { minutes: m, autoCount: 0, autoTasks: [] };
  }
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

    // 업무 표시 (최대 3개 + 더보기)
    const visible = dayTasks.slice(0, 3);
    visible.forEach(t => {
      const style = getMemberStyle(t.who);
      const el = document.createElement('div');
      el.className = `cal-month-task${t.status==='완료'?' done':''}`;
      el.style.cssText = `background:${style.bg};border-left:2px solid ${style.color};color:${style.color}`;
      el.textContent = `${t.who.slice(0,2)} ${t.task}`;
      el.title = `${t.who}: ${t.task} (${t.status})`;
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

    // 주간뷰는 모든 task 표시 (제한 X)
    dayTasks.forEach(t => {
      const style = getMemberStyle(t.who);
      const el = document.createElement('div');
      el.className = `cal-month-task${t.status==='완료'?' done':''}`;
      el.style.cssText = `background:${style.bg};border-left:3px solid ${style.color};color:${style.color}`;
      el.textContent = `${t.who.slice(0,3)} ${t.task}`;
      el.title = `${t.who}: ${t.task} (${t.status} · ${t.priority})`;
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
  if (dataSourceStatus === 'db') await migrateLocalToBackend();
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
  // 과거 task에 있던 비활성 담당자 보강 (preset 데이터 호환)
  for (const legacy of ['박지현']) {
    if (!ids.has(legacy)) extras.push({ id:legacy, name:legacy, role:'(과거)' });
  }
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
  viewer.appendChild(headerWrap);

  const titleEl=document.createElement('div'); titleEl.className='minutes-doc-title'; titleEl.textContent=m.title;
  viewer.appendChild(titleEl);

  if (m.attendees) {
    const att=document.createElement('div'); att.className='minutes-doc-attendees';
    att.textContent=`👥 참석: ${m.attendees}`;
    viewer.appendChild(att);
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
    const p=document.createElement('p'); p.textContent=m.content;
    cb.appendChild(h3); cb.appendChild(p); viewer.appendChild(cb);
  }
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

// ── 이벤트 바인딩 ────────────────────────────────────────────
function bindMinutesEvents() {
  document.getElementById('addMinutesBtn')?.addEventListener('click',()=>{
    const dateEl = document.getElementById('minutesDate');
    if (dateEl && !dateEl.value) dateEl.value = toYMD(new Date());
    document.getElementById('minutesModal').style.display='flex';
    setTimeout(()=>document.getElementById('minutesTitle')?.focus(), 60);
  });
  const closeModal=()=>{
    document.getElementById('minutesModal').style.display='none';
    ['minutesTitle','minutesAttendees','minutesDirectives','minutesContent'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  };
  document.getElementById('closeMinutesModal')?.addEventListener('click',closeModal);
  document.getElementById('cancelMinutes')?.addEventListener('click',closeModal);
  document.getElementById('minutesModal')?.addEventListener('click',e=>{ if(e.target===document.getElementById('minutesModal')) closeModal(); });
  document.getElementById('saveMinutes')?.addEventListener('click',async()=>{
    const title=document.getElementById('minutesTitle')?.value.trim();
    if (!title) { alert('회의 제목을 입력하세요'); return; }
    const saveBtn = document.getElementById('saveMinutes');
    saveBtn.disabled = true;
    saveBtn.textContent = 'AI 분석 중...';
    const dateInput = document.getElementById('minutesDate')?.value;
    const meetingDate = dateInput || toYMD(new Date());
    const result = await createMinutes({ date: meetingDate, title,
      attendees: document.getElementById('minutesAttendees')?.value.trim() || '',
      directives:document.getElementById('minutesDirectives')?.value.trim()||'',
      content:document.getElementById('minutesContent')?.value.trim()||'' });
    saveBtn.disabled = false;
    saveBtn.textContent = '저장';
    closeModal();
    renderMinutesSection();
    if (result.autoCount > 0) {
      showAutoTasksToast(result.autoCount, result.autoTasks);
      loadTeamTasks();
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
      renderMonthCalendar();
    }
  });
  document.getElementById('calToday')?.addEventListener('click',()=>{
    calMonth = new Date(); calMonth.setDate(1);
    calSelectedDate = new Date();
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

  // Sheets PRESET → 백엔드 DB 영구 저장 (실제 import)
  document.getElementById('importSheetBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('importSheetBtn');
    if (!btn) return;
    if (dataSourceStatus !== 'db') {
      alert('백엔드 연결이 끊긴 상태입니다. 연결 후 다시 시도해 주세요.');
      return;
    }
    const ghosts = teamTasks.filter(t => t._origin === 'preset_ghost');
    if (!ghosts.length) {
      alert('✅ 모든 시트 데이터가 이미 백엔드에 저장되어 있습니다.');
      return;
    }
    if (!confirm(`시트 데이터 ${ghosts.length}건을 백엔드에 영구 저장합니다.\n저장 후엔 OneBoard에서 자유롭게 수정·삭제 가능합니다. 계속할까요?`)) return;
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      const payload = ghosts.map(t => ({
        date: t.date, assignee: t.who, task: t.task,
        status: t.status, priority: t.priority, memo: t.memo || ''
      }));
      const result = await apiFetch('/team/import-sheet', {
        method: 'POST',
        body: JSON.stringify({ tasks: payload })
      });
      alert(`✅ ${result.imported || ghosts.length}건 백엔드에 영구 저장되었습니다.\n이제 OneBoard에서 자유롭게 수정·삭제 가능합니다.`);
      await loadTeamTasks();
    } catch (err) {
      alert('저장 실패: ' + (err?.message || err));
    } finally {
      btn.disabled = false; btn.textContent = '영구 저장';
    }
  });

  bindMinutesEvents();
}

document.addEventListener('DOMContentLoaded', () => {
  bindSectionEvents();
  bindNotifEvents();
  initNotifications();
  // 팀 업무 탭 기본 시작 월: 오늘 (실행 시점 기준)
  calMonth = (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); })();
  // v2 신규 초기화
  renderMemberTabs();
  bindMonthlyWeeklyEvents();
  bindManualEvents();
  bindSettingsEvents();
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
      if (!confirm(`"${m.name} ${m.role||''}" 탭을 삭제할까요?\n(해당 팀원의 월간/주간 데이터도 함께 삭제됩니다)`)) return;
      const next = loadTeamMembers().filter(x => x.id !== m.id);
      saveTeamMembers(next);
      // 월간·주간 데이터 정리
      const mo = loadMonthlyAll(); delete mo[m.id]; saveMonthlyAll(mo);
      const wk = loadWeeklyAll(); delete wk[m.id]; saveWeeklyAll(wk);
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
let monthlyViewYM = ymNow();
let weeklyViewYM = ymNow();

function ymNow() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function shiftYM(ym, delta) {
  const [y,m] = ym.split('-').map(Number);
  const d = new Date(y, m-1+delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function loadMonthlyAll() {
  try { return JSON.parse(localStorage.getItem('ob_team_monthly') || '{}'); } catch { return {}; }
}
function saveMonthlyAll(data) { localStorage.setItem('ob_team_monthly', JSON.stringify(data)); }

function getMonthlyFor(memberId, ym) {
  const all = loadMonthlyAll();
  return (all[memberId]?.[ym]) || [];
}
function setMonthlyFor(memberId, ym, rows) {
  const all = loadMonthlyAll();
  if (!all[memberId]) all[memberId] = {};
  all[memberId][ym] = rows;
  saveMonthlyAll(all);
}

function renderMonthlyPanel(memberId) {
  const block = document.getElementById('monthlyBlock');
  if (!block) return;
  const label = document.getElementById('monthlyMonthLabel');
  if (label) label.textContent = monthlyViewYM;
  const body = document.getElementById('monthlyBody');
  if (!body) return;
  body.innerHTML = '';
  const rows = getMonthlyFor(memberId, monthlyViewYM);
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
        const list = getMonthlyFor(memberId, monthlyViewYM);
        list[idx][inp.dataset.f] = inp.value;
        setMonthlyFor(memberId, monthlyViewYM, list);
      });
    });
    tr.querySelector('.tier-del').addEventListener('click', () => {
      const list = getMonthlyFor(memberId, monthlyViewYM);
      list.splice(idx, 1);
      setMonthlyFor(memberId, monthlyViewYM, list);
      renderMonthlyPanel(memberId);
    });
    body.appendChild(tr);
  });
}

function escapeAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

// ── 주간 업무 (1주차~5주차 + 상시) ──────────────────────────
const WEEK_SLOTS = ['1주차','2주차','3주차','4주차','5주차','상시'];

function loadWeeklyAll() {
  try { return JSON.parse(localStorage.getItem('ob_team_weekly') || '{}'); } catch { return {}; }
}
function saveWeeklyAll(data) { localStorage.setItem('ob_team_weekly', JSON.stringify(data)); }
function getWeeklyFor(memberId, ym) {
  const all = loadWeeklyAll();
  const m = all[memberId]?.[ym];
  if (m) return m;
  return Object.fromEntries(WEEK_SLOTS.map(s => [s, []]));
}
function setWeeklyFor(memberId, ym, data) {
  const all = loadWeeklyAll();
  if (!all[memberId]) all[memberId] = {};
  all[memberId][ym] = data;
  saveWeeklyAll(all);
}

function renderWeeklyPanel(memberId) {
  const grid = document.getElementById('weeklyGrid');
  if (!grid) return;
  const label = document.getElementById('weeklyMonthLabel');
  if (label) label.textContent = weeklyViewYM;
  const data = getWeeklyFor(memberId, weeklyViewYM);
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
      row.innerHTML = `
        <input type="checkbox" ${it.done?'checked':''}>
        <span class="weekly-item-text" contenteditable="true">${escapeAttr(it.text||'')}</span>
        <span class="weekly-item-del" title="삭제">✕</span>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        const d = getWeeklyFor(memberId, weeklyViewYM);
        d[slot][idx].done = e.target.checked;
        setWeeklyFor(memberId, weeklyViewYM, d);
        row.classList.toggle('done', e.target.checked);
      });
      row.querySelector('.weekly-item-text').addEventListener('blur', (e) => {
        const d = getWeeklyFor(memberId, weeklyViewYM);
        d[slot][idx].text = e.target.textContent.trim();
        setWeeklyFor(memberId, weeklyViewYM, d);
      });
      row.querySelector('.weekly-item-del').addEventListener('click', () => {
        const d = getWeeklyFor(memberId, weeklyViewYM);
        d[slot].splice(idx, 1);
        setWeeklyFor(memberId, weeklyViewYM, d);
        renderWeeklyPanel(memberId);
      });
      body.appendChild(row);
    });
    col.querySelector('.weekly-add').addEventListener('click', () => {
      const d = getWeeklyFor(memberId, weeklyViewYM);
      d[slot] = d[slot] || [];
      d[slot].push({ text:'새 항목', done:false });
      setWeeklyFor(memberId, weeklyViewYM, d);
      renderWeeklyPanel(memberId);
    });
    grid.appendChild(col);
  });
}

function bindMonthlyWeeklyEvents() {
  document.getElementById('monthlyPrev')?.addEventListener('click', () => {
    monthlyViewYM = shiftYM(monthlyViewYM, -1);
    if (currentMemberTab !== '통합') renderMonthlyPanel(currentMemberTab);
  });
  document.getElementById('monthlyNext')?.addEventListener('click', () => {
    monthlyViewYM = shiftYM(monthlyViewYM, 1);
    if (currentMemberTab !== '통합') renderMonthlyPanel(currentMemberTab);
  });
  document.getElementById('monthlyAddRow')?.addEventListener('click', () => {
    if (currentMemberTab === '통합') return;
    const list = getMonthlyFor(currentMemberTab, monthlyViewYM);
    list.push({ task:'', platform:'', automation:'' });
    setMonthlyFor(currentMemberTab, monthlyViewYM, list);
    renderMonthlyPanel(currentMemberTab);
  });
  document.getElementById('weeklyPrev')?.addEventListener('click', () => {
    weeklyViewYM = shiftYM(weeklyViewYM, -1);
    if (currentMemberTab !== '통합') renderWeeklyPanel(currentMemberTab);
  });
  document.getElementById('weeklyNext')?.addEventListener('click', () => {
    weeklyViewYM = shiftYM(weeklyViewYM, 1);
    if (currentMemberTab !== '통합') renderWeeklyPanel(currentMemberTab);
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
      const res = await fetch(`manuals/${encodeURIComponent(file)}`);
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
const SETTINGS_PASSWORD = 'JEWELICE';

const CHANNEL_KEYS_DEF = [
  // ── 매출 ──
  { id:'cafe24',            name:'🛒 카페24 (자사몰)',          keys:['mall_id','client_id','client_secret','access_token','refresh_token'], doc:'developers.cafe24.com', group:'sales' },
  { id:'smartstore',        name:'🟢 네이버 스마트스토어',      keys:['client_id','client_secret'],                                          doc:'apicenter.commerce.naver.com', group:'sales' },
  { id:'coupang_hanbando',  name:'🛍️ 쿠팡 한반도 (듀오)',       keys:['access_key','secret_key','vendor_id'],                                doc:'wing.coupang.com', group:'sales' },
  { id:'coupang_nemochip',  name:'🛍️ 쿠팡 네모칩 (아블러)',     keys:['access_key','secret_key','vendor_id'],                                doc:'wing.coupang.com', group:'sales' },
  { id:'kakao_biz',         name:'💛 카카오 비즈메시지 (알림톡)', keys:['rest_api_key','sender_key'],                                          doc:'business.kakao.com', group:'sales' },
  // ── 광고 ──
  { id:'meta',              name:'📘 META (페이스북/인스타)',    keys:['app_id','app_secret','access_token','ad_account_id'],                 doc:'developers.facebook.com', group:'ads' },
  { id:'naver_ad',          name:'🟢 네이버 검색광고',           keys:['api_key','secret_key','customer_id'],                                 doc:'searchad.naver.com', group:'ads' },
  { id:'kakao',             name:'💛 카카오모먼트',              keys:['access_token','ad_account_id'],                                       doc:'moment.kakao.com', group:'ads' },
];

function isSettingsUnlocked() {
  return !!localStorage.getItem('ob_admin_token');
}
function getAdminToken() {
  return localStorage.getItem('ob_admin_token') || '';
}
async function adminFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': getAdminToken(),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// CHANNEL_KEYS_DEF의 id ↔ server platform id 매핑
// (구버전 호환: 기존 'coupang' 백엔드 키는 'coupang_hanbando'로 alias)
const CHANNEL_PLATFORM_MAP = {
  cafe24:            'cafe24',
  smartstore:        'naver_store',
  coupang_hanbando:  'coupang',           // 기존 'coupang' 백엔드 그대로 (한반도가 primary)
  coupang_nemochip:  'coupang_nemochip',  // 백엔드 신규 platform 필요
  kakao_biz:         'kakao_biz',         // 백엔드 신규 platform 필요
  meta:              'meta',
  naver_ad:          'naver_ads',
  kakao:             'kakao',
};

let channelStatusCache = {};

async function fetchChannelStatus() {
  try {
    const data = await adminFetch('/admin/platforms');
    channelStatusCache = {};
    (data.platforms || []).forEach(p => {
      channelStatusCache[p.id] = p;
    });
  } catch (e) {
    console.warn('[settings] platforms 조회 실패:', e.message);
    channelStatusCache = {};
  }
}

function renderChannelKeys() {
  const grid = document.getElementById('channelKeysGrid');
  if (!grid) return;
  grid.innerHTML = '';
  let lastGroup = null;
  CHANNEL_KEYS_DEF.forEach(ch => {
    // 매출/광고 그룹 헤더 (group이 바뀔 때 한 번 삽입)
    if (ch.group && ch.group !== lastGroup) {
      const groupLabel = document.createElement('div');
      groupLabel.className = `channel-keys-group-header channel-keys-group-${ch.group}`;
      groupLabel.textContent = ch.group === 'sales' ? '📈 매출 채널' : '📢 광고 채널';
      grid.appendChild(groupLabel);
      lastGroup = ch.group;
    }
    const platformId = CHANNEL_PLATFORM_MAP[ch.id] || ch.id;
    const info = channelStatusCache[platformId] || { status:'pending' };
    const st = info.status;
    const stLabel = st==='connected'?'🟢 연결됨':st==='error'?'🔴 오류':'⚪ 미연동';
    const lastSync = info.lastSync ? new Date(info.lastSync).toLocaleString('ko-KR') : null;
    const card = document.createElement('div');
    card.className = `channel-key-card${ch.group ? ' channel-key-card-' + ch.group : ''}`;
    card.innerHTML = `
      <div class="channel-key-head">
        <div class="channel-key-name">${ch.name}</div>
        <div class="channel-key-status">${stLabel}</div>
      </div>
      <div class="channel-key-keys">필요 키: ${ch.keys.join(' · ')}</div>
      <div class="channel-key-doc">발급: ${ch.doc}</div>
      ${lastSync ? `<div class="channel-key-doc" style="color:#10B981">최근 저장: ${lastSync}</div>` : ''}
      <div class="channel-key-actions">
        <button class="btn-primary" data-ch="${ch.id}" data-act="enter">🔑 키 입력</button>
        ${ch.id==='cafe24' ? '<button class="btn-secondary" data-ch="cafe24" data-act="oauth">🔗 OAuth 인증 시작</button>' : ''}
        ${st==='connected' ? `<button class="btn-danger" data-ch="${ch.id}" data-act="delete">삭제</button>` : ''}
      </div>
    `;
    card.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => handleChannelAction(ch, b.dataset.act));
    });
    grid.appendChild(card);
  });
}

async function handleChannelAction(ch, act) {
  const platformId = CHANNEL_PLATFORM_MAP[ch.id] || ch.id;
  if (act === 'enter') {
    openCredModal(ch, platformId);
  } else if (act === 'oauth') {
    if (!confirm('카페24 OAuth 인증을 시작합니다.\n먼저 mall_id, client_id, client_secret 3개가 저장되어 있어야 합니다.\n\n계속하시겠습니까?')) return;
    const token = encodeURIComponent(getAdminToken());
    window.location.href = `${API_BASE}/admin/oauth/cafe24/start?admin_token=${token}`;
  } else if (act === 'delete') {
    if (!confirm(`${ch.name} 연동을 삭제할까요?`)) return;
    try {
      await adminFetch(`/admin/platforms/${platformId}`, { method:'DELETE' });
      await fetchChannelStatus();
      renderChannelKeys();
    } catch (e) {
      alert(`삭제 실패: ${e.message}`);
    }
  }
}

function openCredModal(ch, platformId) {
  const modal = document.getElementById('credModal');
  const title = document.getElementById('credModalTitle');
  const body = document.getElementById('credModalBody');
  if (!modal || !body) return;
  title.textContent = `${ch.name} — 키 입력`;
  body.innerHTML = `
    <div class="cred-modal-hint">
      각 필드에 플랫폼에서 발급받은 키를 입력하세요. 키는 서버에서 암호화되어 저장됩니다. 프론트에는 저장되지 않습니다.
      <br><br>
      <strong>발급 위치:</strong> ${escapeAttr(ch.doc)}
    </div>
    ${ch.keys.map(k => `
      <div class="form-group">
        <label class="form-label">${k}</label>
        <input type="text" class="form-input cred-input" data-key="${escapeAttr(k)}" placeholder="${escapeAttr(k)} 값 입력" autocomplete="off">
      </div>
    `).join('')}
    ${ch.id==='cafe24' ? '<div class="cred-modal-note">💡 access_token, refresh_token은 자동으로 생성됩니다. mall_id · client_id · client_secret 3개만 입력하세요.</div>' : ''}
  `;
  modal.dataset.platform = platformId;
  modal.dataset.chId = ch.id;
  modal.style.display = 'flex';
  setTimeout(() => body.querySelector('.cred-input')?.focus(), 50);
}

function closeCredModal() {
  const modal = document.getElementById('credModal');
  if (modal) modal.style.display = 'none';
}

async function saveCredModal() {
  const modal = document.getElementById('credModal');
  const platformId = modal.dataset.platform;
  const chId = modal.dataset.chId;
  const creds = {};
  modal.querySelectorAll('.cred-input').forEach(inp => {
    if (inp.value.trim()) creds[inp.dataset.key] = inp.value.trim();
  });
  if (Object.keys(creds).length === 0) {
    alert('최소 1개 이상의 키를 입력해주세요.');
    return;
  }
  const saveBtn = document.getElementById('credModalSave');
  saveBtn.disabled = true; saveBtn.textContent = '저장 중...';
  try {
    await adminFetch(`/admin/platforms/${platformId}`, {
      method:'POST', body: JSON.stringify(creds),
    });
    closeCredModal();
    await fetchChannelStatus();
    renderChannelKeys();
    alert(`✅ ${Object.keys(creds).length}개 키 저장 완료`);
  } catch (e) {
    alert(`저장 실패: ${e.message}`);
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = '저장';
  }
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
      if (!confirm(`${m.name} 탭을 삭제할까요? (월간/주간 데이터 함께 삭제)`)) return;
      const next = loadTeamMembers().filter(x => x.id !== m.id);
      saveTeamMembers(next);
      const mo = loadMonthlyAll(); delete mo[m.id]; saveMonthlyAll(mo);
      const wk = loadWeeklyAll(); delete wk[m.id]; saveWeeklyAll(wk);
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
  document.getElementById('settingsGate').style.display = 'none';
  document.getElementById('settingsBody').style.display = '';
  refreshAuthUI();
  renderChannelKeys();
  renderTeamMgmtList();
  populateSettingsInputs();
  await fetchChannelStatus();
  renderChannelKeys();
}

function lockSettings() {
  localStorage.removeItem('ob_admin_token');
  localStorage.removeItem('ob_settings_auth');
  document.getElementById('settingsGate').style.display = '';
  document.getElementById('settingsBody').style.display = 'none';
  const pw = document.getElementById('settingsPassword'); if (pw) pw.value = '';
}

function bindSettingsEvents() {
  const unlock = document.getElementById('settingsUnlock');
  const pw = document.getElementById('settingsPassword');
  const err = document.getElementById('settingsErr');
  const tryUnlock = async () => {
    const input = (pw?.value || '').trim();
    if (!input) return;
    if (err) { err.style.display='none'; }
    unlock.disabled = true; unlock.textContent = '확인 중...';
    try {
      // 서버에 토큰 검증 요청
      const res = await fetch(`${API_BASE}/admin/verify`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'X-Admin-Token': input },
      });
      if (res.ok) {
        localStorage.setItem('ob_admin_token', input);
        localStorage.setItem('ob_settings_auth', 'true');
        await openSettingsBody();
      } else if (res.status === 503) {
        // 서버 환경변수 미설정 — 로컬 폴백 (데모 모드)
        if (input.toUpperCase() === SETTINGS_PASSWORD) {
          localStorage.setItem('ob_admin_token', input);
          localStorage.setItem('ob_settings_auth', 'true');
          if (err) {
            err.textContent = '⚠️ 서버에 ONEBOARD_ADMIN_TOKEN이 미설정 — 로컬 모드로 진입 (실제 키 저장 불가)';
            err.style.color = '#F59E0B';
            err.style.display = '';
          }
          await openSettingsBody();
        } else {
          if (err) { err.textContent='❌ 비밀번호가 틀렸습니다.'; err.style.display=''; err.style.color=''; }
        }
      } else {
        if (err) { err.textContent='❌ 비밀번호가 틀렸습니다.'; err.style.display=''; err.style.color=''; }
      }
    } catch (e) {
      // 네트워크 에러 — 로컬 폴백
      if (input.toUpperCase() === SETTINGS_PASSWORD) {
        localStorage.setItem('ob_admin_token', input);
        localStorage.setItem('ob_settings_auth', 'true');
        if (err) {
          err.textContent = '⚠️ 서버 연결 실패 — 로컬 모드 (실제 키 저장 불가)';
          err.style.color = '#F59E0B';
          err.style.display = '';
        }
        await openSettingsBody();
      } else {
        if (err) { err.textContent=`❌ ${e.message}`; err.style.display=''; err.style.color=''; }
      }
    } finally {
      unlock.disabled = false; unlock.textContent = '잠금 해제';
    }
  };
  unlock?.addEventListener('click', tryUnlock);
  pw?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.getElementById('settingsLockBtn')?.addEventListener('click', lockSettings);

  // ── 워크스페이스 로그인 (팀 데이터 동기화) ──
  const authErrShow = (msg) => {
    const err = document.getElementById('authErr');
    if (err) { err.textContent = msg; err.style.display = ''; }
  };
  const authErrHide = () => {
    const err = document.getElementById('authErr');
    if (err) err.style.display = 'none';
  };

  document.getElementById('authLoginBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) return authErrShow('이메일·비밀번호를 입력하세요.');
    authErrHide();
    const btn = document.getElementById('authLoginBtn');
    btn.disabled = true; btn.textContent = '로그인 중...';
    try {
      await authLogin(email, password);
      await refreshAuthUI();
      alert('✅ 로그인 성공. 백엔드 데이터를 불러오기 위해 페이지를 새로고침합니다.');
      location.reload();
    } catch (e) {
      authErrShow(`❌ ${e.message}`);
    } finally {
      btn.disabled = false; btn.textContent = '🔐 로그인';
    }
  });

  document.getElementById('authPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('authLoginBtn')?.click();
  });

  document.getElementById('authRegisterBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) return authErrShow('이메일·비밀번호를 입력한 후 등록을 눌러주세요.');
    if (password.length < 6) return authErrShow('비밀번호는 6자 이상 권장합니다.');
    const name = prompt('관리자 이름 (예: Charles)');
    if (!name) return;
    const workspaceName = prompt('워크스페이스 이름 (예: 쥬얼아이스)');
    if (!workspaceName) return;
    if (!confirm(`다음 정보로 새 워크스페이스를 만듭니다:\n\n이메일: ${email}\n관리자 이름: ${name}\n워크스페이스: ${workspaceName}\n\n계속할까요?`)) return;
    authErrHide();
    try {
      await authRegister(email, password, name, workspaceName);
      await refreshAuthUI();
      alert(`✅ 워크스페이스 "${workspaceName}" 등록 완료.\n\n팀원들에게 다음을 공유하세요:\n• 이메일: ${email}\n• 비밀번호: (방금 입력하신 값)\n\n페이지를 새로고침합니다.`);
      location.reload();
    } catch (e) {
      authErrShow(`❌ ${e.message}`);
    }
  });

  document.getElementById('authLogoutBtn')?.addEventListener('click', () => {
    if (!confirm('로그아웃하시겠습니까?\n이후 입력은 로컬 임시저장만 됩니다 (팀원과 동기화 안 됨).')) return;
    authLogout();
    refreshAuthUI();
    alert('로그아웃 완료. 페이지를 새로고침합니다.');
    location.reload();
  });

  // 키 입력 모달 이벤트
  document.getElementById('credModalClose')?.addEventListener('click', closeCredModal);
  document.getElementById('credModalCancel')?.addEventListener('click', closeCredModal);
  document.getElementById('credModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'credModal') closeCredModal();
  });
  document.getElementById('credModalSave')?.addEventListener('click', saveCredModal);

  // OAuth 성공 리턴 처리 (?oauth=success)
  if (new URLSearchParams(location.search).get('oauth') === 'success') {
    setTimeout(() => alert('✅ OAuth 인증 완료! access/refresh 토큰이 서버에 저장되었습니다.'), 500);
    history.replaceState({}, '', location.pathname);
  }

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
      const res = await fetch(`${API_BASE}/health`, { method:'GET' });
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
      monthly: loadMonthlyAll(),
      weekly: loadWeeklyAll(),
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
      if (data.monthly) saveMonthlyAll(data.monthly);
      if (data.weekly) saveWeeklyAll(data.weekly);
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
    if (isSettingsUnlocked()) openSettingsBody();
    else {
      document.getElementById('settingsGate').style.display = '';
      document.getElementById('settingsBody').style.display = 'none';
    }
  }
};
