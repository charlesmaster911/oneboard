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

const SHEET_ID = '11byYTuUleS-kq3idS4e0Mgt368FssfnrHchyalHPuRI';

// 시트 gid (gid=0 하나에 모든 채널이 가로로 나열된 구조)
const SHEET_GIDS = { main: 0 };

/**
 * 실제 CSV 컬럼 레이아웃 (0-indexed, 검증 완료 2026-04-17):
 *
 *  통합     col 1-8  : 날짜, 총매출, 총유입, 전환매출, 총광고비, 총ROAS, 전환ROAS, 광고비율
 *  자사몰   col 10-17: 날짜, 자사매출, 유입, 광고매출, 광고비, 자사ROAS, 광고ROAS, 광고비율
 *  META     col 19-23: 날짜, 광고매출, 광고비, ROAS, 광고비율  (유입 없음)
 *  쿠팡     col 31-37: 날짜, 전체매출, 유입, 광고매출, 광고비, ROAS, 광고비율
 *  네이버   col 39-45: 날짜, 전체매출, 유입, 광고매출, 광고비, ROAS, 광고비율
 *  유튜브   col 47-53: 날짜, 전체매출, 유입, 광고매출, 광고비, ROAS, 광고비율
 *  카카오   col 55-59: 날짜, 광고매출, 광고비, ROAS, 광고비율  (유입 없음)
 *  아블러   col 61-67: 날짜, 전체매출, 유입, 광고매출, 광고비, ROAS, 광고비율
 *
 *  검증: 자사몰(2,581,000)+쿠팡(932,460)+네이버(458,640)+유튜브(299,000)+아블러(122,000)
 *       = 4,393,100 = 통합 총매출 ✓ (2025-07-01 기준)
 */
const CHANNEL_COL_MAP = {
  '통합':      { dateCol: 1,  salesCol: 2,  trafficCol: 3,  convCol: 4,  adCol: 5,  roasCol: 6,  adRatioCol: 8,  hasTraffic: true  },
  '자사몰':    { dateCol: 10, salesCol: 11, trafficCol: 12, convCol: 13, adCol: 14, roasCol: 15, adRatioCol: 17, hasTraffic: true  },
  'META':      { dateCol: 19, salesCol: 20, trafficCol: null,convCol: 20, adCol: 21, roasCol: 22, adRatioCol: 23, hasTraffic: false },
  '쿠팡':      { dateCol: 31, salesCol: 32, trafficCol: 33, convCol: 34, adCol: 35, roasCol: 36, adRatioCol: 37, hasTraffic: true  },
  '네이버':    { dateCol: 39, salesCol: 40, trafficCol: 41, convCol: 42, adCol: 43, roasCol: 44, adRatioCol: 45, hasTraffic: true  },
  '유튜브쇼핑':{ dateCol: 47, salesCol: 48, trafficCol: 49, convCol: 50, adCol: 51, roasCol: 52, adRatioCol: 53, hasTraffic: true  },
  '카카오모먼트':{ dateCol: 55, salesCol: 56, trafficCol: null,convCol: 56, adCol: 57, roasCol: 58, adRatioCol: 59, hasTraffic: false },
  '아블러':    { dateCol: 61, salesCol: 62, trafficCol: 63, convCol: 64, adCol: 65, roasCol: 66, adRatioCol: 67, hasTraffic: true  },
};

// 채널별 색상
const CHANNEL_COLORS = {
  '자사몰':    '#3B82F6',
  'META':      '#EC4899',
  '쿠팡':      '#F59E0B',
  '네이버':    '#10B981',
  '유튜브쇼핑':'#EF4444',
  '카카오모먼트':'#8B5CF6',
};

// 채널별 비중 목업 (API 연동 전)
const CHANNEL_MOCK_SHARE = {
  labels: ['자사몰', 'META', '쿠팡', '네이버', '유튜브', '카카오'],
  data:   [38, 22, 20, 12, 5, 3],
  colors: ['#3B82F6', '#EC4899', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6'],
};

// 상태
let rawCSV = null;          // 패치된 원본 CSV (채널 전환 시 재사용)
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

// ─── Google Sheets CSV 패치 ──────────────────────────────────
async function fetchSheetCSV(gid = 0) {
  if (rawCSV) return rawCSV;
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rawCSV = await res.text();
  return rawCSV;
}

// 채널 데이터 로드 (캐시 활용)
function loadChannelData(channel) {
  if (channelDataCache[channel]) return channelDataCache[channel];
  if (!rawCSV) return [];
  const rows = parseSheetRows(rawCSV, channel);
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

  // 채널 탭 — 실데이터 전환
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChannel = btn.dataset.channel;
      const notice = document.getElementById('channelNotice');

      if (rawCSV && CHANNEL_COL_MAP[currentChannel]) {
        // 채널 데이터 전환
        allData = loadChannelData(currentChannel);
        notice.style.display = 'none';
        updateDashboard();
        // 유입 없는 채널 (META, 카카오) 처리
        if (!CHANNEL_COL_MAP[currentChannel].hasTraffic) {
          setText('val-traffic', '—');
          const chgEl = document.getElementById('chg-traffic');
          if (chgEl) { chgEl.textContent = '유입 미집계 채널'; chgEl.className = 'kpi-change neutral'; }
        }
      } else {
        // 매핑 미정 채널 — textContent로 XSS 방지
        notice.style.display = 'block';
        const spanEl = notice.querySelector('span');
        if (spanEl) spanEl.textContent = `⚠️ ${currentChannel} 채널 연동 준비 중입니다.`;
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
  { id: '박지현', name: '박지현', role: '팀장', color: '#3B82F6', bg: '#EFF6FF' },
  { id: '권나경', name: '권나경', role: '과장', color: '#10B981', bg: '#F0FDF4' },
  { id: '권수지', name: '권수지', role: '대리', color: '#F59E0B', bg: '#FFFBEB' },
  { id: '컨텐츠팀', name: '컨텐츠팀', role: '콘텐츠', color: '#8B5CF6', bg: '#F5F3FF' },
];
const DAYS_KO = ['월','화','수','목','금','토','일'];

// ── 상태 ──────────────────────────────────────────────────────
let calMonth = new Date(2026, 2, 1); // 기본값: 2026년 3월
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
];

// ── 회의록 프리셋 (Google Sheets gid=1125757148 기반) ─────────
const MINUTES_PRESET = [
  { id:'preset-m-2026-04-16', date:'2026-04-16', title:'GS홈쇼핑 MD 미팅 요약', directives:'GS홈쇼핑 입점 관련 MD 면담 진행\n온라인 정상가 오픈 상태, 방송·공동구매·프로모션 공동 추진 방향 논의', content:'2026-04-16 GS홈쇼핑 MD 미팅. 참석: 박지현' },
  { id:'preset-m-2026-04-15', date:'2026-04-15', title:'협력사 현장 방문 요약', directives:'협력사 현장 방문 및 미팅 진행\n물류·재고 현장 파악', content:'2026-04-15 협력사 현장 방문. 참석: 장정훈, 박지현, 권수지' },
  { id:'preset-m-2026-04-14', date:'2026-04-14', title:'정동우 대표님 미팅 (아블러/해외)', directives:'아블러 텀블러 메인 제품 집중 전략 확정\n40mm 큐브 몰드 6월 출시 예정\n해외 크라우드펀딩 인디고고 단독 또는 킥스타터+인디고고 투트랙 검토\n7월 초~중순 해외 크라우드펀딩 캠페인 오픈 목표\n첼로스퀘어(삼성) 물류 활용 검토', content:'1. 아블러 텀블러 메인 제품 집중, 40mm 큐브 몰드 개발 중 → 6월 출시 예정\n2. 팀장(온라인 15~20년 경력) 신규 합류, 마케팅 디렉터(캐나다·미국 출신) 기획 전담\n3. Shopify+DHL 운영 → 배송비 15~20% 초과로 일시 중단\n4. 인디고고: 초기 3,000불 선납, 플랫폼 수수료 5%, 메인배너·뉴스레터 무료 제공\n5. 킥스타터: 기존 후원자 DB 재활용 가능' },
  { id:'preset-m-2026-04-13', date:'2026-04-13', title:'주간회의 (전체)', directives:'광고 대행업체 활용 등 새로운 광고 방향성 이번 주 내 모색\n기존 채널 프로모션 + 오프라인 B2B 입점 동시 추진\n브랜드 커넥트 공동구매 (고정비 20만+수수료 20%) 다음 주 초 진행\n구독자 60만명 유튜버 협업 검토', content:'1. 마케팅·영업: 신규 업체 소통 및 프로모션 계획 수립 중\n2. 콘텐츠 마케팅 일시 중단 → 지표 점검 중\n3. 광고 대행업체 활용 새 방향성 모색 예정\n4. 채널 프로모션 + B2B 오프라인 입점 동시 추진\n5. 브랜드 커넥트 공동구매 다음 주 초 진행 확정' },
  { id:'preset-m-2026-04-10', date:'2026-04-10', title:'재고·물류 점검 회의', directives:'실재고 파악 후 사방넷 기준 재고 알림 시스템 구축\n글라스잔 단품→세트 판매로 전환 (수익성 우선)\n듀오 컬러박스 5,000개 우선 발주 후 추가 발주\n추석·B2B 제안 일정 기준 재고 생산 계획 수립', content:'1. 재고·물류: 실재고 있으나 시스템 미반영으로 발주 오류 발생. 물류사 방문해 원인 파악 예정\n2. 상품·발주: 글라스잔 세트 판매 전환, 듀오 컬러박스 5천개 선발주\n3. 추석·B2B 제안 일정 기준으로 재고 캘린더 통합 관리 필요' },
  { id:'preset-m-2026-04-07', date:'2026-04-07', title:'CJ 홈쇼핑 미팅 (주간)', directives:'CJ 공동구매 수수료 30% 조건 검토 (광고비 부담 없음)\nCJ 측 방송·공동구매·SNS 공동 추진 방향 논의\n공동구매 셀러들도 CJ 타이틀로 입점하는 구조 활용 가능', content:'1. CJ: 온라인 정상가 오픈 상태, 추가 프로모션 방향 논의\n2. 총괄 MD 직접 방송·공동구매·프로모션 공동 추진 가능\n3. CJ 공동구매 수수료 30% 조건, 광고비 없이 확장성 있는 조건' },
  { id:'preset-m-2026-04-06', date:'2026-04-06', title:'주간업무회의 (전사)', directives:'이번 주 핵심: 실재고 최종 점검 + 세무회계 시스템 세팅 + 가격/행사/구성안 확정\n와디즈 실오픈 4/22~23 전후 예정\n메타 광고 재점검 필요 (유입 감소로 매출 하락)\n사방넷 이번 주까지 상품 연동 완료\n어쿠스틱 드링크 협업: 세트 박스 없이 분리 판매', content:'1. 실재고 최종 점검, 세무회계 세팅, 가격/구성안 확정이 이번 주 핵심\n2. 와디즈 알림받기 오픈 중, 실오픈 4/22~23\n3. 네이버 광고 효율 양호, 메타 재점검 필요\n4. 사방넷 이번 주까지 상품 연동 목표\n5. 어쿠스틱 드링크 컵·얼음 분리 판매 확정' },
  { id:'preset-m-2026-03-30', date:'2026-03-30', title:'주간업무회의 (전사)', directives:'사방넷 완료된 신규몰 우선 연동·상품 전송\n신규 광고대행사 이관 및 사전 컨펌 프로세스 도입\n이번 주 금요일 통합 매출 양식 배포\n4월 8일 물류사 미팅 → 정기 재고 실사 강화 요청', content:'1. 사방넷 세팅 완료 신규몰 우선 연동\n2. 오늘 오후 신규 대행사로 광고 이관\n3. 물류·재고: 4월 8일 물류사 미팅 예정\n4. 아블러 매트 컬러 방향 확정 예정' },
  { id:'preset-m-2026-03-23', date:'2026-03-23', title:'주간업무회의 (전사)', directives:'채널 입점 완료 순서대로 프로모션 시작\n사방넷 연동 및 운영 양식 정립 (수요일 신규인력 합류)\n재고 부족 상품 2,400개 조리 후 입고\n썸네일·상세페이지 최종본 정리 필요', content:'1. 채널 입점 확대 신청 진행, 완료 채널부터 순차 프로모션\n2. 사방넷 연동·운영 양식 정립, 수요일 신규 인력 합류\n3. 재고 부족 상품 2,400개 입고 예정' },
  { id:'preset-m-2026-03-20', date:'2026-03-20', title:'주간업무회의 (전사직원)', directives:'신규 입점 오늘까지 신청 마무리, 현황 별도 시트 공유\n내부 데이터 양식 금주 최종 정리\n메타 광고 정상 운영 지연 → 계속 점검 필요\n듀오메이커 3월 24일 입고 후 25~26일 판매 준비\n어쿠스틱 드링크 프로모션 심플하게 구성 방향 검토', content:'1. 신규 입점 오늘까지 신청 마무리\n2. 메타 광고 정상 운영 지연, 계속 점검\n3. 듀오메이커 24일 입고, 25~26일 판매 준비\n4. 광고·콘텐츠 보고서 및 협업 제안서 다음 주 공유' },
  { id:'preset-m-2026-03-13', date:'2026-03-13', title:'와디즈 미팅', directives:'와디즈 행사 목표 매출: 3,000만~5,000만원\n아블러 메인, 듀오 서브 구성 유력\n오픈 후 3일 알림신청 푸시 집중, 이후 신규유입 병행\n보상판매 할인 프로모션 추가 검토', content:'1. 와디즈 행사 목표: 3,000만~5,000만원\n2. 아블러 메인, 듀오 옵션형 서브 구성\n3. 오픈 후 3일: 알림신청 푸시 집중 / 4~14일차: 신규유입 확대\n4. 보상판매 할인 프로모션 추가 검토' },
  { id:'preset-m-2026-03-09', date:'2026-03-09', title:'주간업무회의 (전사직원)', directives:'아블러 조립·재고 반영 진행 중\n듀오메이커 외통 인쇄·납품 진행 중\n신규 컬러 MOQ 1,500개까지 협의 완료\n사방넷 이번 주 세팅 완료 목표\n와디즈 수수료 조건 회신 대기 중\n신규 컬러 SNS 투표 운영', content:'1. 아블러 조립·재고 반영 진행\n2. 사방넷 이번 주 세팅 완료 목표\n3. 와디즈 수수료 조건 회신 대기\n4. 신규 컬러 SNS 투표 운영' },
  { id:'preset-m-2026-03-05', date:'2026-03-05', title:'주간업무회의 (전사직원)', directives:'아블러 신규 컬러 1~2종 추가 검토 (실버 제외)\n와디즈: 아블러 메인 + 듀오 옵션형 서브 구성 방향\n3월 인플루언서 진행·메타 광고 세팅 실행', content:'1. 아블러 신규 컬러 1~2종 추가 검토 (실버 재고로 실버 제외)\n2. 와디즈: 아블러 메인, 듀오 옵션형 서브 구성 방향\n3. 전체 발주 5,000개 기준, 신규 컬러 추가 시 6,000개' },
  { id:'preset-m-2026-03-03', date:'2026-03-03', title:'주간업무회의 (전사직원)', directives:'메타 광고 25만~30만원 증액 테스트 (리타겟팅 중심)\n신규 얼음 몰드 40mm 기준으로 설계 확정 (실물 테스트 우선)\n재고 부족 SKU 이번 주 내 전체 파악', content:'1. 메타 광고 25~30만원 증액, 리타겟팅 중심 운영\n2. 얼음 몰드 40mm 설계 확정 (AI 데이터보다 실물 테스트 우선)\n3. 재고 부족 SKU 전체 파악' },
  { id:'preset-m-2026-02-27', date:'2026-02-27', title:'주간업무회의 (전사직원)', directives:'미스터 위스키 썸네일 최종 선택 (찰스 대표님)\n브릭스 진행 여부 검토 (찰스 대표님)\n박지현 팀장: 다음 주 대표 보고자료 준비\n권나경 과장: 아블러 제로 공동구매/벤더사 후보 확인\n광고 소재 여분 확보 운영', content:'1. 찰스 대표님 확인: 미스터 위스키 썸네일 선택, 브릭스 진행 여부\n2. 박지현 팀장: 다음 주 보고자료 준비\n3. 권나경 과장: 미스터위스키 가편집본 수정 요청, 아블러 제로 공동구매 후보 확인\n4. 광고 소재 여분 확보 운영' },
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

async function fetchTeamTasks(from, to) {
  try {
    const data = await apiFetch(`/team/tasks?from=${from}&to=${to}`);
    return data.tasks.map(t => ({
      id: t.id, date: t.date?.slice(0,10), who: t.assignee,
      task: t.task, status: t.status, priority: t.priority, memo: t.memo||'',
    }));
  } catch {
    const local = loadLocalTasks();
    const preset = SHEET_TASKS_PRESET.map((t,i) => ({ id:`preset-${i}`, ...t, memo:'' }));
    const all = [...preset, ...local];
    return all.filter(t => (!from||t.date>=from) && (!to||t.date<=to));
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

async function fetchMinutes() {
  try {
    const data = await apiFetch('/team/minutes');
    return data.minutes.map(m => ({ id:m.id, date:m.date?.slice(0,10), title:m.title, directives:m.directives, content:m.content }));
  } catch {
    const local = loadMinutesLocal();
    return [...MINUTES_PRESET, ...local];
  }
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
function toYMD(d) { return d.toISOString().slice(0,10); }
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
  // 월요일 시작
  const startDow = first.getDay()===0 ? 6 : first.getDay()-1;
  const start = new Date(first); start.setDate(first.getDate()-startDow);
  const endDow = last.getDay()===0 ? 0 : 7-last.getDay();
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

  // 요일 헤더
  DAYS_KO.forEach(day => {
    const th = document.createElement('div');
    th.className = 'cal-col-header';
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

    const cell = document.createElement('div');
    cell.className = 'cal-month-cell' + (isToday(d)?' today':'') + (inMonth?'':' other-month');

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
      // 삭제 버튼
      const delBtn = document.createElement('span');
      delBtn.textContent = '✕';
      delBtn.style.cssText = 'float:right;cursor:pointer;opacity:0;transition:opacity .1s';
      delBtn.addEventListener('mouseenter', ()=>delBtn.style.opacity='1');
      delBtn.addEventListener('mouseleave', ()=>delBtn.style.opacity='0');
      delBtn.addEventListener('click', async e=>{ e.stopPropagation(); if(confirm('삭제?')) await deleteTask(t.id); });
      el.appendChild(delBtn);
      cell.appendChild(el);
    });

    if (dayTasks.length > 3) {
      const more = document.createElement('div');
      more.className = 'cal-month-more';
      more.textContent = `+${dayTasks.length-3}개 더`;
      more.addEventListener('click', ()=>{ calSelectedDate=d; switchCalView('day'); });
      cell.appendChild(more);
    }

    // + 추가
    const addBtn = document.createElement('button');
    addBtn.className = 'cal-month-add';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e=>{ e.stopPropagation(); openTaskModal(ymd, null); });
    cell.appendChild(addBtn);

    fragment.appendChild(cell);
  });

  grid.replaceChildren(fragment);
  grid.style.gridTemplateColumns = 'repeat(7,1fr)';

  const labelEl = document.getElementById('calWeekLabel');
  if (labelEl) {
    labelEl.textContent = `${calMonth.getFullYear()}년 ${calMonth.getMonth()+1}월`;
  }
}

// ── 일간 뷰 ──────────────────────────────────────────────────
function fmtKo(d) { return d.toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'}); }

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
  addBtn.addEventListener('click', ()=>openTaskModal(ymd, null));
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
  calView = view;
  document.querySelectorAll('[data-calview]').forEach(b=>b.classList.toggle('active',b.dataset.calview===view));
  const weekWrap = document.getElementById('calWeekView');
  const dayWrap  = document.getElementById('calDayView');
  if (view==='month' || view==='week') {
    if (weekWrap) weekWrap.style.display='';
    if (dayWrap)  dayWrap.style.display='none';
    renderMonthCalendar();
  } else {
    if (weekWrap) weekWrap.style.display='none';
    if (dayWrap)  dayWrap.style.display='';
    renderDayView(calSelectedDate||new Date());
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

// ── 통합 뷰 렌더링 ────────────────────────────────────────────
function renderIntegratedView() {
  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (today.getDay()===0?6:today.getDay()-1));
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const ws = toYMD(weekStart), we = toYMD(weekEnd);

  // 블로커: 높음 우선순위 + 미완료
  const blockers = teamTasks.filter(t => t.priority==='높음' && t.status!=='완료');
  const blockersEl = document.getElementById('intBlockers');
  if (blockersEl) {
    if (!blockers.length) {
      blockersEl.innerHTML = '<div class="int-empty">이번 주 블로커 없음 ✅</div>';
    } else {
      blockersEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      blockers.slice(0,10).forEach(t => {
        const style = getMemberStyle(t.who);
        const row = document.createElement('div');
        row.className = 'int-item';
        row.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 'int-member-badge';
        badge.style.cssText = `background:${style.bg};color:${style.color};border:1px solid ${style.color}20`;
        badge.textContent = t.who;
        const text = document.createElement('span');
        text.className = 'int-task-text';
        text.textContent = t.task;
        const status = document.createElement('span');
        status.className = `int-status int-status-${t.status==='진행'?'progress':'todo'}`;
        status.textContent = t.status;
        const date = document.createElement('span');
        date.className = 'int-date';
        date.textContent = t.date;
        row.appendChild(badge); row.appendChild(text); row.appendChild(status); row.appendChild(date);
        frag.appendChild(row);
      });
      blockersEl.appendChild(frag);
    }
  }

  // 팀원별 현황
  const memberGrid = document.getElementById('intMemberStatus');
  if (memberGrid) {
    memberGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    TEAM_MEMBERS.forEach(member => {
      const mTasks = teamTasks.filter(t => t.who===member.id||t.who===member.name);
      const todo = mTasks.filter(t=>t.status==='예정').length;
      const progress = mTasks.filter(t=>t.status==='진행').length;
      const done = mTasks.filter(t=>t.status==='완료').length;
      const latest = mTasks.filter(t=>t.status!=='완료').sort((a,b)=>a.date>b.date?1:-1)[0];

      const card = document.createElement('div');
      card.className = 'int-member-card';
      card.style.cssText = `border-top:3px solid ${member.color}`;

      const header = document.createElement('div');
      header.className = 'int-member-card-header';
      const dot = document.createElement('div');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${member.color};flex-shrink:0`;
      const name = document.createElement('span');
      name.style.cssText = `font-weight:600;font-size:13px;color:${member.color}`;
      name.textContent = `${member.name} ${member.role}`;
      header.appendChild(dot); header.appendChild(name);

      const stats = document.createElement('div');
      stats.className = 'int-member-stats';
      stats.innerHTML = `<span class="int-stat todo-stat">예정 ${todo}</span><span class="int-stat prog-stat">진행 ${progress}</span><span class="int-stat done-stat">완료 ${done}</span>`;

      const taskPreview = document.createElement('div');
      taskPreview.className = 'int-member-task';
      taskPreview.textContent = latest ? `▶ ${latest.task}` : '진행 중인 업무 없음';

      const openBtn = document.createElement('button');
      openBtn.className = 'int-open-btn';
      openBtn.textContent = '업무 보기 →';
      openBtn.addEventListener('click', () => switchMemberTab(member.id));

      card.appendChild(header); card.appendChild(stats); card.appendChild(taskPreview); card.appendChild(openBtn);
      frag.appendChild(card);
    });
    memberGrid.appendChild(frag);
  }

  // 최신 회의록 지시사항 → 통합 뷰 상단 배너
  const latestMinutes = MINUTES_PRESET[0];
  if (latestMinutes?.directives) {
    const alertsBlock = document.querySelector('.integrated-block:last-child .integrated-block-title');
    if (alertsBlock) {
      const minBanner = document.createElement('div');
      minBanner.className = 'int-minutes-banner';
      minBanner.style.cssText = 'background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#1E40AF';
      minBanner.innerHTML = `<strong>📋 최근 회의 (${latestMinutes.date})</strong><div style="margin-top:4px;color:#3B82F6">${latestMinutes.title}</div>`;
      alertsBlock.parentElement.insertBefore(minBanner, alertsBlock);
    }
  }

  // 협업 알림: 진행 중이면서 날짜가 오늘 이전인 항목 (지연 가능성)
  const delayed = teamTasks.filter(t => t.status==='진행' && t.date < toYMD(today));
  const alertsEl = document.getElementById('intAlerts');
  if (alertsEl) {
    if (!delayed.length) {
      alertsEl.innerHTML = '<div class="int-empty">지연 항목 없음 ✅</div>';
    } else {
      alertsEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      delayed.slice(0,8).forEach(t => {
        const style = getMemberStyle(t.who);
        const row = document.createElement('div');
        row.className = 'int-item int-item-delay';
        const badge = document.createElement('span');
        badge.className = 'int-member-badge';
        badge.style.cssText = `background:${style.bg};color:${style.color};border:1px solid ${style.color}20`;
        badge.textContent = t.who;
        const text = document.createElement('span');
        text.className = 'int-task-text';
        text.textContent = t.task;
        const info = document.createElement('span');
        info.className = 'int-delay-badge';
        info.textContent = `${t.date} 진행 중`;
        row.appendChild(badge); row.appendChild(text); row.appendChild(info);
        frag.appendChild(row);
      });
      alertsEl.appendChild(frag);
    }
  }
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
  const from = '2026-03-01', to = '2026-04-30';
  teamTasks = await fetchTeamTasks(from, to);
  switchMemberTab(currentMemberTab);
}

// ── 업무 입력 모달 ────────────────────────────────────────────
function openTaskModal(date, assignee) {
  editingTaskId = null;
  const modal = document.getElementById('taskModal');
  const el = id => document.getElementById(id);
  if (el('taskDate')) el('taskDate').value = date||toYMD(new Date());
  // 현재 탭이 특정 팀원이면 자동 세팅
  const autoAssignee = assignee || (currentMemberTab !== '통합' ? currentMemberTab : null);
  if (autoAssignee && el('taskAssignee')) el('taskAssignee').value = autoAssignee;
  el('taskContent').value=''; el('taskMemo').value='';
  el('taskStatus').value='예정'; el('taskPriority').value='보통';
  el('saveTask').textContent='저장';
  if (modal) modal.style.display='flex';
  setTimeout(()=>el('taskContent')?.focus(),50);
}

function openTaskEditModal(task) {
  editingTaskId = task.id;
  const el = id => document.getElementById(id);
  el('taskDate').value=task.date;
  el('taskAssignee').value=task.who;
  el('taskContent').value=task.task;
  el('taskStatus').value=task.status;
  el('taskPriority').value=task.priority;
  el('taskMemo').value=task.memo||'';
  el('saveTask').textContent='수정';
  document.getElementById('taskModal').style.display='flex';
}

function closeTaskModal() {
  const modal = document.getElementById('taskModal');
  if (modal) modal.style.display='none';
  editingTaskId=null;
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

function renderMinutesList(minutes) {
  const list = document.getElementById('minutesList');
  if (!list) return;
  if (!minutes.length) { list.innerHTML='<div class="empty-state">회의록이 없습니다.\n+ 새 회의록으로 시작하세요.</div>'; return; }
  const fragment = document.createDocumentFragment();
  minutes.forEach((m,idx)=>{
    const item=document.createElement('div');
    item.className=`minutes-list-item${idx===0?' active':''}`;
    const dateEl=document.createElement('div'); dateEl.className='minutes-item-date'; dateEl.textContent=m.date;
    const titleEl=document.createElement('div'); titleEl.className='minutes-item-title'; titleEl.textContent=m.title;
    const preview=document.createElement('div'); preview.className='minutes-item-preview';
    const dirs=m.directives?m.directives.trim().split('\n').filter(Boolean):[];
    preview.textContent=dirs.length?`지시사항 ${dirs.length}건`:'지시사항 없음';
    item.appendChild(dateEl); item.appendChild(titleEl); item.appendChild(preview);
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
  const dateEl=document.createElement('div'); dateEl.className='minutes-doc-date'; dateEl.textContent=m.date;
  const titleEl=document.createElement('div'); titleEl.className='minutes-doc-title'; titleEl.textContent=m.title;
  viewer.appendChild(dateEl); viewer.appendChild(titleEl);
  const directives=m.directives?m.directives.trim().split('\n').filter(Boolean):[];
  if (directives.length) {
    const block=document.createElement('div'); block.className='minutes-directive-block';
    const bt=document.createElement('div'); bt.className='minutes-directive-title'; bt.textContent='찰스 지시사항 (판단 기준)';
    block.appendChild(bt);
    directives.forEach((d,i)=>{
      const row=document.createElement('div'); row.className='directive-item';
      const num=document.createElement('div'); num.className='directive-num'; num.textContent=i+1;
      const text=document.createElement('span'); text.textContent=d.replace(/^\d+\.\s*/,'');
      row.appendChild(num); row.appendChild(text); block.appendChild(row);
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
  document.getElementById('addMinutesBtn')?.addEventListener('click',()=>{ document.getElementById('minutesModal').style.display='flex'; });
  const closeModal=()=>{
    document.getElementById('minutesModal').style.display='none';
    ['minutesTitle','minutesDirectives','minutesContent'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
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
    const today=new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit'}).replace(/\.\s*/g,'-').slice(0,10);
    const result = await createMinutes({ date:today, title,
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

  // 월 네비게이션
  document.getElementById('calPrev')?.addEventListener('click',()=>{
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()-1, 1);
    renderMonthCalendar();
  });
  document.getElementById('calNext')?.addEventListener('click',()=>{
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()+1, 1);
    renderMonthCalendar();
  });
  document.getElementById('calToday')?.addEventListener('click',()=>{
    calMonth = new Date(); calMonth.setDate(1);
    switchCalView('month');
  });
  document.getElementById('refreshTeamBtn')?.addEventListener('click',renderTeamSection);

  // 팀원 탭 전환
  document.querySelectorAll('.member-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMemberTab(btn.dataset.member));
  });

  document.querySelectorAll('[data-calview]').forEach(btn=>btn.addEventListener('click',()=>{
    if(btn.dataset.calview==='day') calSelectedDate=new Date();
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
  document.getElementById('taskContent')?.addEventListener('keydown',e=>{ if(e.key==='Enter') handleSaveTask(); });

  // Sheets import 버튼 — 명시적 클릭만
  document.getElementById('importSheetBtn')?.addEventListener('click',()=>{
    const bar=document.getElementById('importBar');
    if(bar) bar.style.display='none';
    // 이미 SHEET_TASKS_PRESET 로드됨 — 안내만
    alert('✅ Google Sheets 데이터가 이미 캘린더에 반영되어 있습니다.');
  });

  bindMinutesEvents();
}

document.addEventListener('DOMContentLoaded', () => {
  bindSectionEvents();
  bindNotifEvents();
  initNotifications();
  // 팀 업무 탭 기본 시작 월: 3월
  calMonth = new Date(2026, 2, 1);
});
