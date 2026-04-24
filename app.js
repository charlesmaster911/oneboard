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

// ── 회의록 프리셋 (시트 13yy1MtUh... gid=1125757148 29건 전수 반영) ─────────
const MINUTES_PRESET = [
  { id:'preset-m-2026-04-23', date:'2026-04-23', title:'AMPM글로벌 광고대행사 미팅', attendees:'박지현', directives:'광고 계정 권한 전달 후 현재 데이터 정밀 분석 요청\n예산안·매체 운영안 포함 1차 제안안 4/24 금요일까지 수령\n내부 광고 소재·콘텐츠 자산 정리 후 순차 전달\nCTR 하락·장바구니 이탈·구매 전환 저하 대응 필요', content:'1. 현재 광고 진단: CTR 하락·장바구니 이탈·구매 전환 저하\n2. 제안받은 광고 운영 방향 — 3단계 퍼널(신규 유입→리타겟팅→재구매/확장)\n3. 소재/메시지 전략: 퍼널별 맞춤 메시지, 실사용 콘텐츠·인플루언서·레시피 활용\n4. 자사 상황: 보고 체계 필요, 주요 SKU — 듀오메이커·아블러·아블러 제로\n5. 상품 확장: 듀오메이커 커피/우유/막걸리/팥빙수 활용, 아블러 제로 40-50대 여성 반응 좋음\n6. 추가: 유튜브 쇼핑·인플루언서·공동구매·라이브커머스 연계, 경쟁사 분석 요청' },
  { id:'preset-m-2026-04-20', date:'2026-04-20', title:'주간회의', attendees:'장정훈 박지현 권나경 권수지', directives:'업무의 입체화 — 회의록을 타 부서 업무와 크로싱 점검\n단순 업무 자동화 — 팀장급은 핵심 업무 집중, 단순 업무는 하급자/AI 위임\n데이터 중심 보고 — 매출 변동 큰 채널 원인 분석(재고/광고효율)\n와디즈 4/23 목요일 오픈\n메타 광고 대행사 2곳 대면 미팅 후 결정', content:'1. 마케팅: 와디즈 4/23 오픈, 블라썸 공동구매 시작, CJ 온스타일 팔로업, 자사몰 스토리텔링 랜딩 기획\n2. 생산·물류: 아블러 컬러 이슈로 5월 초 완료, 재고 오늘 3시까지 파악\n3. 인사·행정: 콘텐츠 마케터 면접 2시, SK 스토어 지원 사업 스케줄 확인\n4. 대표 지시: 업무 입체화·단순업무 자동화·데이터 중심 보고' },
  { id:'preset-m-2026-04-17', date:'2026-04-17', title:'주간회의', attendees:'장정훈 박지현 권나경 권수지', directives:'mop Structure — 점(Library)→선(Frame)→입체(Structure) 업무 방식\n와디즈 4/23 오픈, 집게 2,000개 추가 발주 검토\n쇼핑백+더스트백 패키지 리뉴얼 추진\nSNS 콘텐츠 대표 캐릭터 활용 실험\n4/20 월: 아블러 샘플 도착 + 음료 얼음 테스트 품평회', content:'1. 마케팅: 광고 350만원 집행, 체험단 10명, 와디즈 4/23 오픈\n2. 제품·물류: 패키지 쇼핑백+더스트백 리뉴얼, 아블러 신규 컬러 샘플 DHL 월요일 도착\n3. R&D: 아블러+듀오메이커 우유/콜라/주스/막걸리 품평회 월요일\n4. 시스템: AI 통합 리포트 툴 비교 분석 중\n5. 대표 지시: 소통의 맥락(mop) 파악, 점·선·구조(Circulation)' },
  { id:'preset-m-2026-04-16', date:'2026-04-16', title:'GS홈쇼핑 MD 미팅', attendees:'박지현', directives:'GS홈쇼핑 MD 미팅 (상세: Notion)', content:'https://chatter-mountain-80e.notion.site/GS-MD-3440301561db800985b7e4651c4c29e5?source=copy_link' },
  { id:'preset-m-2026-04-15', date:'2026-04-15', title:'협력사 현장 방문', attendees:'장정훈 박지현 권수지', directives:'협력사 현장 방문 (상세: Notion)', content:'https://chatter-mountain-80e.notion.site/26-04-15-3430301561db80c49a93f26f8cbac972' },
  { id:'preset-m-2026-04-14', date:'2026-04-14', title:'정동우 대표님 미팅 (해외 크라우드펀딩)', attendees:'장정훈 박지현', directives:'ABLR/쥬얼아이스 메인: 아블러 텀블러(3-in-1)\n40mm 큐브 몰드 6월 출시 — 컵+몰드 세트 구성 판매\n인디고고 단독 or 킥스타터→인디고고 투트랙 검토\n7월 초~중순 해외 크라우드펀딩 캠페인 오픈 목표\n펀딩 목표 30~50만불 기준 비용 구조표 수령\n첼로스퀘어(삼성) 물류 활용 검토\nMeta 광고 계정 보안 강화 (구글 OTP+별도 인증앱)', content:'1. 현황: 아블러 텀블러 메인, 40mm 큐브 몰드 6월 출시, 팀장 신규 합류\n2. 해외 펀딩: 인디고고(Backerkit 인수, 3,000불 선납, 수수료 5%, 배너 무료), 킥스타터(벤티스 후불 검토)\n3. 타임라인: 6월 큐브 몰드 완료 → 7월 초~중순 캠페인 오픈\n4. 기타: 첼로스퀘어 물류, 일본 마쿠아케 재진출 검토, 대만 짝짝이 유통\n5. 액션: 시제품 샘플 확보, 촬영 일정 확정, 투트랙 여부 결정, 정동훈 대표 비용 구조표 송부' },
  { id:'preset-m-2026-04-13', date:'2026-04-13', title:'주간회의', attendees:'장정훈 박지현 권나경 권수지', directives:'광고 대행업체 활용 새 방향성 모색\n브랜드 커넥트 공동구매(고정비 20만+수수료 20%) 다음 주 초 2곳 진행\n구독자 60만 유튜버 콘텐츠 제작비 별도 요청 → 내부 보고 후 결정\n블로그 대대적 개편 작업 내일 오전까지\n잔디로 4월 가격표/프로세스/투자 검토 링크 공유\n글라스 잔 어쿠스틱 1,000+채널 500~1,000세트 대표님 최종', content:'1. 마케팅·영업: 광고 방향성 모색, 블로그 개편, 60만 유튜버 검토\n2. 재고·발주: 가격표/프로세스 문서 업로드 완료, 글라스 잔 채널용 추가 발주, 아블러 신규 컬러 DHL 입고\n3. 패키징: 스틱/아이스볼 분리, 어쿠스틱 외통 폰트 진하게, 개별 박스 + 쇼핑백 묶음\n4. 기타: 노트북 LM으로 영상 요약, 클로드 코드 1~2시간 매뉴얼 숙지 강조' },
  { id:'preset-m-2026-04-10', date:'2026-04-10', title:'주간회의', attendees:'장정훈 박지현 권나경 권수지', directives:'실재고 파악 후 사방넷 기준 재고 알림 시스템 구축\n글라스잔 단품→세트 판매 전환 (수익성)\n듀오 컬러박스 5,000개 선발주 후 추가\n추석·B2B 제안 일정 앞당기기 — 4월부터 자료 준비\n쥬얼아이스 브랜드 컨셉 "음료의 마지막 보석"', content:'1. 재고·물류: 시스템 미반영 발주 오류, 물류사 방문 원인 파악, 사방넷 기준 재고 알림 구축\n2. 상품·발주: 글라스잔 세트 판매, 듀오 컬러박스 5,000개 선발주, 실링 스티커 필요 시점 발주\n3. 추석/B2B: 4월부터 제안 자료·이미지·구성안 준비\n4. 브랜드·패키지: "음료의 마지막 보석", 프리미엄·보석 이미지 중심\n5. 마케팅: 브랜드 인지 vs 제품 판매 광고 분리, 브랜드 커넥트·공동구매·스마트스토어 집중' },
  { id:'preset-m-2026-04-07', date:'2026-04-07', title:'주간회의록 (CJ 주방가전 총괄)', attendees:'박지현, 안정균(CJ 주방가전 총괄)', directives:'CJ 공동구매 수수료 30% (광고비 부담 없음)\n총괄 MD 직접 방송·공동구매·프로모션 공동 추진\n판매 방식 — 방송형(모바일 라이브) 쪽으로 구체화\n시험성적서·특허증 서류 미리 정리 필요', content:'1. 온라인 정상가 오픈, 추가 프로모션 진행\n2. 총괄 MD 방송·공동구매·프로모션 공동 추진\n3. CJ 공동구매 30% 조건, 광고비 없이 확장성\n4. 공동구매 셀러들도 CJ 타이틀로 입점 — 신뢰도·규모감 유리\n5. 자사몰 매출: 인플루언서/유튜브 쇼핑 유입, 인스타 반응 확인\n6. 판매 방식: 방송형(모바일 라이브) 적합 — 사용감·활용 장면 직접 노출 필요\n7. CJ 채널과 외부 진행 건 연결 가능성' },
  { id:'preset-m-2026-04-06', date:'2026-04-06', title:'주간업무회의 (전사)', attendees:'장정훈 박지현 권나경 권수지 조송희', directives:'이번 주 핵심 — 실재고 최종 점검 + 세무회계 세팅 + 가격/행사/구성안 확정\n와디즈 실오픈 4/22~23 예정\n메타 광고 재점검 필요 (유입 감소)\n사방넷 이번 주까지 상품 연동 완료\n어쿠스틱 협업 — 컵·얼음 분리 판매\n조 대리 오늘부로 업무 마무리', content:'1. 실재고 최종 점검·세무회계 세팅·가격/행사/구성안 확정\n2. 와디즈 알림받기 오픈, 실오픈 4/22~23\n3. 광고: 네이버 양호, 메타 유입 감소로 재점검\n4. 사방넷: 이번 주 상품 연동 완료, 신규 코드 중심 재운영\n5. 어쿠스틱: 세트 박스 없이 컵/얼음 분리 판매, 하얀 박스+띠지+실링 스티커\n6. 티코스터 제외, 글라스잔/실링스티커 부자재 함께 발주\n7. 공동구매 매출 30만원 미만, 다른 채널 제안 병행\n8. 조 대리 오늘부로 업무 마무리, 팀은 주간계획·성과관리·KPI 중심' },
  { id:'preset-m-2026-03-30', date:'2026-03-30', title:'주간회의', attendees:'박지현 권나경 권수지', directives:'사방넷 완료된 신규몰 우선 연동·상품 전송\n신규 광고대행사 이관 및 사전 컨펌 프로세스 도입\n이번 주 금요일 통합 매출 양식 배포\n4월 8일 물류사 미팅 — 재고 실사 강화 요청\n아블러 매트 컬러 샘플 공장 재요청\nB2B 각인·브랜드 스토리 중심 자사몰 리뉴얼 기획', content:'1. 쇼핑몰 상품 등록: 사방넷 세팅 신규몰 우선 연동, 리멤버 수기 등록\n2. 광고 대행사 이관 오늘 오후, 사전 컨펌 프로세스 도입\n3. 물류·재고: 4/8 물류사 미팅, 정기 재고 실사 강화\n4. 제품: 아블러 매트 신규 컬러 샘플 3종 재요청, 어쿠스틱 글라스·아이스볼 보관통 입고\n5. 마케팅: 아블러 제로 블로그 공구, B2B 각인·브랜드 스토리 자사몰 리뉴얼 기획(외주 검토)' },
  { id:'preset-m-2026-03-23', date:'2026-03-23', title:'주간회의', directives:'채널 입점 완료 순서대로 프로모션 시작\n사방넷 연동·운영 양식 정립 (수요일 신규인력 합류)\n재고 부족 2,400개 조리 후 입고\n광고 소재 실촬영 기반 확대\n매출 회복·효율 중심 운영\n이번 주 최우선 — 메타 광고 효율 개선', content:'1. 영업·운영: 입점 채널 확대, 사방넷 연동, 발주·상품 관리 이지어드민+사방넷 병행\n2. 상품·물류: 상품명/정가 재정리, 썸네일·상세페이지 최종본, 아블러 몰드 4월 말 일정\n3. 마케팅·광고: 메타 재가동, 듀오메이커 입고 시 메타·쿠팡·네이버 즉시 활성화, 실촬영 콘텐츠 확대\n4. 콘텐츠: 브랜드커넥트·태그바이 체험단, 공동구매 4/1 연기, 어쿠스틱 토요일 업로드\n5. 조직: 신규 인력 수요일 출근, 반복 업무 체계화\n6. 대표 전달: 매출 회복·효율 중심, 부정적 언어 지양, 메타 효율 개선 최우선' },
  { id:'preset-m-2026-03-20', date:'2026-03-20', title:'주간업무회의', directives:'신규 입점 오늘까지 신청 마무리, 현황 별도 시트\n내부 데이터 양식 금주 최종 정리\n메타 광고 정상 운영 지연 — 계속 점검\n듀오메이커 3/24 입고 후 3/25~26 판매 준비\n어쿠스틱 드링크 프로모션 심플하게\n실무진→팀장→대표 보고 체계 통일\n대표 — 사업계획서·자금 조달·인력 보충 집중', content:'1. 신규 입점 오늘까지 신청 마무리\n2. 내부 데이터 양식 금주 중 정리\n3. 메타 광고 일부 노출, 정상 운영 지연\n4. 듀오메이커 3/24 입고, 25~26일 판매 준비\n5. 쇼핑몰 연동 완료, 카테고리·상품 등록·프로모션 기획\n6. 어쿠스틱 프로모션 심플\n7. 광고·콘텐츠 보고서·협업 제안서 다음 주 공유\n8. 올해 업무 보고 체계 통일' },
  { id:'preset-m-2026-03-18', date:'2026-03-18', title:'주간업무회의(전사직원)', directives:'박스/패키지 리뉴얼 — 2일 내 초안, 컬러 변경·이메일·쿠팡 규격 반영\n아블러 신규 컬러 딥그린·코랄, 은색 레이저 로고\n아블러 제로 즉시 변경X — 장점 소구+VOC 대응 강화\n메타 광고 부진 — 일매출 하락, 3월 매출 방어\n11개 채널 입점 확대\n4/1 블로그 공동구매\n상세페이지 효익·리뷰·전환 포인트 상단\n아블러 4월 넷째 주 생산 / 5월 초 입고', content:'1. 박스/패키지 리뉴얼 — 초안 2일 내\n2. 아블러 신규 컬러 확정 (딥그린·코랄)\n3. 아블러 제로 VOC 대응 강화, 빨대/뚜껑/누수 안내 보완\n4. 매출: 메타 광고 이슈, 11개 채널 입점·공동구매·체험단 추진\n5. 상세페이지 개선 — 효익/리뷰/전환 포인트 상단\n6. 스피어 재고(1,200개) 단기 프로모션\n7. 생산: 아블러 4월 넷째 주 / 5월 초 입고, 스틱 보관통 다음주, 아이스볼 2~3주\n8. 닐링체어 초도 50개 발주 검토\n9. 사방넷 이번 주 쇼핑몰 연동, 다음 주 카테고리 매칭\n10. 얼음 괄사 시장성 검토(소싱 판매 선행)' },
  { id:'preset-m-2026-03-16', date:'2026-03-16', title:'주간업무회의(전사직원)', directives:'아블러 메인 집중, 아블러 제로 품질 이슈 신중\n와디즈 1차 러프안 구성/가격안 전달, 보상판매 별도 검토\n상세페이지 신규 촬영 X — 기존 자료 활용 개편\n메타 광고 계정·픽셀·사방넷 점검·정비\n컬러 최종안 — 딥포레스트, 세이지그린', content:'1. 아블러 메인, 아블러 제로 신중\n2. 와디즈 1차 러프안 전달, 보상판매 별도\n3. 상세페이지 기존 자료 활용\n4. 메타 광고·픽셀·사방넷 운영 점검\n5. 신규 소싱·컬러 추가 검토\n액션: 제안서 금일 전달, 와디즈 구성/가격안, 보상판매 재검토, 아블러 제로 개선 확인, 메타 세팅, 컬러 대표님 확인(딥포레스트/세이지그린)' },
  { id:'preset-m-2026-03-13', date:'2026-03-13', title:'와디즈 미팅', directives:'와디즈 목표 매출 3,000만~5,000만원\n구성: 듀오·아블러·얼음틀·집게·보관통 (보냉백 차기)\n오픈 후 3일 알림신청 푸시, 4~14일차 신규유입 확대\n미식여행 프로모션 쿠폰(2만원)\n보상판매 할인 프로모션 추가 검토\n상세페이지 150만원 상당 무상 지원\n수수료 최대한 조정', content:'1. 목표 매출 3,000만~5,000만원\n2. 행사 제품: 듀오, 아블러, 얼음틀, 집게, 보관통 (보냉백 차기)\n3. 오픈 후 3일 알림신청 푸시, 4~14일차 신규유입\n4. 미식여행 프로모션 쿠폰 2만원 할인\n5. 보상판매 할인 프로모션 검토\n6. 와디즈 측: 상세페이지 150만원 상당 무상 지원\n7. 보상판매 시스템 구현 여부·데이터 추출·구매이력 PD 측 추가 확인\n8. 수수료 최대한 조정, 새소식/커뮤니티 적극 운영' },
  { id:'preset-m-2026-03-09', date:'2026-03-09', title:'주간업무회의', directives:'아블러 조립·재고 반영 진행\n듀오메이커 외통 인쇄·납품\n신규 컬러 MOQ 1,500개 협의 완료\n사방넷 이번 주 세팅 완료 목표\n와디즈 수수료 조건 회신 대기\n신규 컬러 SNS 투표 운영', content:'1. 진행 중: 아블러 조립·재고, 듀오메이커 외통, 신규 컬러 MOQ 1,500개, 사방넷 세팅, 와디즈 수수료 회신 대기\n2. 결정 필요: 외통 단색(브라운/네이비)/이미지, 와디즈 아블러 중심·듀오 비중\n3. 이번 주: 신규 컬러 SNS 투표, 사방넷 마무리, 외통 인쇄 업체 추가 확인, 와디즈 피드백 반영' },
  { id:'preset-m-2026-03-07', date:'2026-03-07', title:'외부미팅 - 에벤에셀', content:'완료 | 기존 시트에서 이전' },
  { id:'preset-m-2026-03-05', date:'2026-03-05', title:'주간업무회의', directives:'아블러 신규 컬러 1~2종 추가 (실버 제외, 여성 타깃)\n전체 발주 5,000개, 신규 컬러 추가 시 6,000~7,000개\n신규 컬러 내부 후보 4~5개 → SNS 투표 검증\n큐브 화이트 재고 부족 원인·출고 경로 확인\n와디즈 — 아블러 메인 + 듀오 옵션 서브\n3월 인플루언서 — 어쿠스틱 3/28 확정\n4~5월 추가 인플루언서 협업 가능성\n컬러/로고/디자인 시안 이미지 먼저 제작', content:'1. 제품·생산: 아블러 신규 컬러 1~2종 (실버 제외), 발주 5,000개 기준, 생산 리드타임 3개월, 듀오 라운딩 다음 회차\n2. 마케팅: 3월 어쿠스틱 3/28, 4~5월 추가 협업, 미스터 위스키 성과 좋음 (제품 스토리 설득력)\n3. 와디즈: 아블러 메인+듀오 옵션 서브 효율적, 신규 유입·브랜드 노출용\n4. 디자인: 컬러 시안 이미지 우선 제작\n5. 신규 사업: 별도 브랜드 샘플·상표·패키지 진행, 담당자 퇴사로 멈춤, 진입장벽 낮은 변형 런칭 검토\n6. 운영: 메타 광고 관리자 권한 오류 점검' },
  { id:'preset-m-2026-03-03', date:'2026-03-03', title:'주간업무회의', directives:'메타 광고 25만~30만원 증액 (리타겟팅)\n신규 얼음 몰드 40mm 설계 확정 (실물 테스트 우선)\n재고 부족 SKU 전체 파악 + 추가 생산 발주\n아블러 제로 광고 소재 신제작, 시딩/공구 100만원 테스트\n닐링체어 수정 샘플 확인 후 최종 판단\n와디즈 미팅 전 사전 협의', content:'1. 광고: 메타 리타겟팅 25~30만원 증액\n2. 제품: 40mm 몰드 기준 설계 (AI 데이터 < 실물 테스트)\n3. 재고·생산: 이번 주 전체 파악·추가 발주, SKU 품절 점검\n4. 아블러 제로: 광고 소재 신제작, 시딩/공구 100만원 예산\n5. 와디즈/닐링체어: 사전 협의, 수정 샘플 확인\n대표 확인: 증액 속도, 40mm 다음 개발 단계, 아블러 제로 테스트 예산, 와디즈 우선 아이템, 닐링체어 통과 기준' },
  { id:'preset-m-2026-02-27', date:'2026-02-27', title:'주간업무회의', directives:'미스터 위스키 썸네일 최종 선택 (찰스 대표)\n브릭스 진행 여부 검토 (찰스 대표)\n박지현 팀장 — 다음 주 대표 보고자료\n권나경 과장 — 미스터위스키 가편집본 수정, 아블러 제로 공동구매/벤더사 확인\n조송희 대리 — 듀오/아블러제로 광고 소재, SNS 리포트 보완', content:'1. 찰스 대표님: 미스터 위스키 썸네일 선택, 브릭스 검토\n2. 박지현 팀장: 다음 주 대표 보고자료\n3. 이호혁 차장: 광고 소재 여분 확보\n4. 권나경 과장: 미스터위스키 가편집본 수정(볼륨·확대 삭제), 샘플 재작업, 아블러 제로 공동구매 후보\n5. 조송희 대리: 듀오/아블러제로 광고 소재, SNS 업로드, 리포트 다음 주 공유' },
  { id:'preset-m-2026-02-23', date:'2026-02-23', title:'주간업무회의', directives:'금요일 업로드 목표 (랜딩·썸네일)\n촬영 제품 우선순위 — 스피어 중심\n상세페이지/GIF 다플랫폼 피그마 한계\n징소싱 샘플 품질 문제, 반값 재샘플 제안\n글라스 발주 계획·단가, 스틱 사이즈 회신 대기\n외통 컬러 테스트\nNabbi 계약 해지 + 계정 삭제 명확화\n광고 소재 2~3개 우선 제작/개선\n핵심지표+매출 트래킹 시트 구축\n주유소 채널 월 10만원 주 1회 목요일 업로드 4회 테스트', content:'권과장: 금요일 업로드(랜딩·썸네일), 촬영 스피어 중심, 피그마 구현 한계, 징소싱 품질·반값 재샘플, 글라스·스틱 회신, 외통 컬러, Nabbi 해지/계정 삭제, 업로드 연휴 현실성, 상세페이지 대표 컨펌 후 전체 적용, 샘플 대표 체험 후 Go/Stop\n조대리: 광고 소재 2~3개 개선, 핵심지표+매출 트래킹 시트, 주유소 채널 월 10만원 주 1회 목요일 4회 테스트(시청완료율), 쥬얼아이스 소개서 이관' },
  { id:'preset-m-2026-02-19', date:'2026-02-19', title:'회의록 (어쿠스틱 규격·광고)', directives:'어쿠스틱 40×40 규격 우선 존중 (사용자 의미)\n65ml 큰 잔 기준 43 적합 — 상대 의견 수용\n몰드 3개 구성 언급\n스틱 투명도 이슈 — 뒤쪽 차폐 테스트 2개 월요일 보고\n네이버 검색광고 자동충전 재세팅\nGFA 정상화, 메타 재세팅 모니터링\n주말 효율 좋은 캠페인 증액 검토\n외주 샘플 코팅·도장 불량 — 개선 소통, 현장 방문 압박\nnabbi 영상 내일 저녁\n미스터 위스키 초안 → 다음 주 금요일 업로드\n닐링체어 상품소개서 와디즈 PD 전달', content:'1. 결정: 40×40 어쿠스틱 우선, 65ml 기준 43 내부 의견, 몰드 3개 구성\n2. 실행: 스틱 투명도 테스트 2개 월요일 / 네이버 검색광고 재세팅, GFA/메타 모니터링, 주말 증액 / 샘플 코팅·포장 불량 컴플레인, 징소싱 중간업자 구조, 현장 방문 압박 / nabbi 내일 업로드, 미스터 위스키 다음주 금요일, 큐브 몰드 오늘 발송, 어쿠스틱 3월 일정 재확인\n3. 공유: 닐링체어 와디즈 PD 전달, 대표 재택 가능성, 월요일 박지현 팀장 합류' },
  { id:'preset-m-2026-02-09', date:'2026-02-09', title:'회의록 (구정 전 재고·광고)', directives:'구정 전 재고·생산 관리 + 광고 세팅 완료\n성과 좋은 광고 20%내 증액\n쿠팡 상세 GIF/영상 노출 들쭉날쭉 — 유튜브 정책 확인, 대체안 준비\n유튜브 쇼핑 상세 개선 (전일 30만원 사례)\n각인 이벤트 — 20종 3카테고리 댓글 투표, 오늘~2/22, 당첨 3명 (아블러 제로)\n탈형 "쉽게 빼는 법" GIF/영상 (구정 이후)', content:'1. 이번 주 우선순위: 구정 전 재고·생산 + 광고 세팅 (연휴 매출 유지)\n2. 성과 좋은 광고 20% 증액\n3. 쿠팡 상세 GIF/영상 노출 이슈 — 유튜브 정책 확인\n4. 유튜브 쇼핑 상세 개선\n5. 각인 이벤트 20종 3카테고리 투표 ~2/22, 당첨 3명\n6. 탈형 GIF/영상 구정 이후' },
  { id:'preset-m-2026-02-02', date:'2026-02-02', title:'회의록', directives:'에버런스 메타 대행 종료, 직접 운영+소재 제작 (조송희)\nGFA 담당자 변경 요청 회신 대기\n이지어드민 품절 전 미리 조립·생산\n어쿠스틱 전자계약 진행, 미스터위스키 업로드 후 계약서\n술익는집 하반기 판단 (수수료·RS 비쌈)\nSNS 각인 이벤트 / UGC 진행\n아블러 제로 개선·신규 컬러 신제품 필요 (뚜껑·분리·고무패킹·이물질)', content:'1. 에버런스 메타 대행 종료, 조송희 직접 운영+소재\n2. GFA 담당자 이슈 회신 대기\n3. 이지어드민 품절 전 사전 조립·생산\n4. 어쿠스틱 드링크 전자계약, 미스터위스키 업로드 후 계약\n5. 술익는집 하반기 판단, SNS 각인 이벤트/UGC\n6. 아블러 제로 개선·신규 컬러 필요 (뚜껑·유리 분리·패킹 이물질)' },
  { id:'preset-m-2026-01-30', date:'2026-01-30', title:'회의록', directives:'소싱 — 와인병 조명·안새는 텀블러 샘플구매, 향수 가습기·차고 열쇠고리 대표 확인, 정과 패키지 투표 중\n인플루언서 — 나삐위스키 1/29 계약서, 홈텐딩백과/띠동갑바텐더 AI 성과 후 결정(롱폼 500만원), 미스터위스키 2~3월 초, 술익는집 3천만 OR 2천만+RS, 어쿠스틱 계약서 수정\n주말 광고 — 메타 22만원(아블러6·듀오8·아블러제로8), 쇠맛×여자 소재 전환, GFA 15만원 유지\n고객 CS — 아블러 뚜껑 이슈, 내부 유리 파손, 피플 재고 오류 13건 배송완료\n아블러 명절 각인 이벤트\nCS 대표 인터뷰 유튜브/인스타 업로드', content:'1. 소싱: 와인병 조명·텀블러 샘플구매, 향수 가습기·열쇠고리 대표 확인, 정과 패키지 투표, 상세페이지 디자인 수정\n2. 인플루언서: 나삐위스키 1/29 계약서, 홈텐딩백과/띠동갑바텐더 AI 후 결정, 미스터위스키 2월말~3월초 아블러, 술익는집/어쿠스틱 조건\n3. 광고: 메타 22만(아블러6·듀오8·아블러제로8), 쇠맛×여자 반응, GFA 15만 유지 월말 증액 검토\n4. CS: 아블러 뚜껑·유리 파손·누수, 피플 재고 오류 13건 배송완료, 아블러 볼 화이트 품절\n5. 특이: 아블러 명절 각인 이벤트, CS 대표 인터뷰 업로드' },
  { id:'preset-m-2026-01-26', date:'2026-01-26', title:'회의록', directives:'네이버 AI방송 — 아블러제로 팔로업\n미스터위스키 큐브 듀오메이커 제작 일정 / 어쿠스틱 금형 신규 제작\n정과 프로젝트 "넛넛" 결정, 금일 패키지 투표\n주유소 유튜브 화요일 무알콜 막걸리 촬영\n메타 소재 미리 제작, 중단 방지 푸시', content:'1. 네이버 AI방송 아블러제로 팔로업\n2. 미스터위스키 큐브 듀오메이커 일정, 어쿠스틱 금형 신규\n3. 정과 프로젝트 "넛넛" 결정, 금일 투표\n4. 주유소 유튜브 화요일 무알콜 막걸리 촬영\n5. 메타 소재 사전 제작 지속' },
  { id:'preset-m-2026-01-19', date:'2026-01-19', title:'회의록', directives:'에버런스·원정대 주간 광고 운영 공유\n인플루언서 상반기 계획 잡고 진행\n"한국전통주하이볼" 유튜브 개설 및 주 1회 영상 업로드 — 기획안\n정과 및 영상 콘텐츠 대표 직접 노출\n대표 참여 브랜드 철학·회사 방향 오픈 토킹 기획', content:'1. 주간 광고 운영 계획 공유\n2. 인플루언서 상반기 계획\n3. 유튜브 "한국전통주하이볼" 개설, 주 1회 업로드, 기획안 작성\n4. 영상 콘텐츠 대표 직접 참여\n5. 브랜드 이미지·철학 오픈 토킹 기획' },
  { id:'preset-m-2026-01-13', date:'2026-01-13', title:'회의록', directives:'메타 광고 아블러/듀오 이미지 배너 에버런스 요청\n리퍼 블프 자사몰 미노출, 광고 유입만\n2026 마케팅 캘린더 → 참여형 콘텐츠·각인 몰드 제작\n영상 세부 기획안 잔디 공유\n닐링체어 주문 3건 발송, DIY 사이트 공지 필요', content:'1. 메타 광고 이미지 배너 에버런스\n2. 리퍼 블프 광고로만 유입\n3. 2026 마케팅 캘린더 → 참여형 콘텐츠·각인 몰드\n4. 영상 세부 기획안, 콘텐츠 아이디어 잔디 공유\n5. 닐링체어 발송 + DIY 공지' },
  { id:'preset-m-2026-01-09', date:'2026-01-09', title:'회의록', directives:'전직원 KPI 전달\n주간 업무 공유\n인플루언서 섭외 관련 구글 닷 등 제작\n영상 콘텐츠 아이디어 발표', content:'1. 전직원 KPI 전달\n2. 주간 업무 공유\n3. 인플루언서 섭외 (구글 닷)\n4. 영상 콘텐츠 아이디어 발표' },
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
  { cat:'🎧 CS 대응', color:'#EF4444', desc:'고객 문의·증상별 응대 가이드', items:[
    { file:'소스_CS_얼음증상_대응가이드.md', title:'얼음 증상 대응 가이드', hot:true, summary:'뽀얀얼음·안떨어짐·깨짐 등 실제 증상별 응대 스크립트' },
    { file:'소스_CS_트러블슈팅DB.md', title:'트러블슈팅 DB', summary:'실전 사례 기반 문제 해결 DB' },
    { file:'소스_CS_응대프로세스_4단계.md', title:'CS 응대 4단계 프로세스', summary:'문의확인 → FAQ답변 → 응대기록 → Slack 알림' },
    { file:'소스_CS_채널8개_FAQ22_2021.md', title:'8채널 FAQ22', summary:'네이버·쿠팡 등 8채널 접속법 + FAQ 22개' },
    { file:'소스_채널운영_권수지_인수인계.md', title:'채널 운영 인수인계 (권수지)', summary:'4채널 CS 운영 + 개선 과제' },
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
  { id:'cafe24', name:'🛒 카페24 (자사몰)', keys:['mall_id','client_id','client_secret','access_token','refresh_token'], doc:'developers.cafe24.com' },
  { id:'smartstore', name:'🟢 네이버 스마트스토어', keys:['client_id','client_secret'], doc:'apicenter.commerce.naver.com' },
  { id:'coupang', name:'🟡 쿠팡', keys:['access_key','secret_key','vendor_id'], doc:'wing.coupang.com' },
  { id:'meta', name:'📘 META (페이스북/인스타)', keys:['app_id','app_secret','access_token','ad_account_id'], doc:'developers.facebook.com' },
  { id:'naver_ad', name:'🟢 네이버 검색광고', keys:['api_key','secret_key','customer_id'], doc:'searchad.naver.com' },
  { id:'kakao', name:'🟡 카카오모먼트', keys:['access_token','ad_account_id'], doc:'moment.kakao.com' },
];

function isSettingsUnlocked() {
  return localStorage.getItem('ob_settings_auth') === 'true';
}

function renderChannelKeys() {
  const grid = document.getElementById('channelKeysGrid');
  if (!grid) return;
  const saved = JSON.parse(localStorage.getItem('ob_channel_status') || '{}');
  grid.innerHTML = '';
  CHANNEL_KEYS_DEF.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'channel-key-card';
    const st = saved[ch.id]?.status || 'pending';
    const stLabel = st==='connected'?'🟢 연결됨':st==='error'?'🔴 오류':'⚪ 미연동';
    card.innerHTML = `
      <div class="channel-key-head">
        <div class="channel-key-name">${ch.name}</div>
        <div class="channel-key-status">${stLabel}</div>
      </div>
      <div class="channel-key-keys">필요 키: ${ch.keys.join(' · ')}</div>
      <div class="channel-key-doc">발급: ${ch.doc}</div>
      <div class="channel-key-actions">
        <button class="btn-secondary" data-ch="${ch.id}" data-act="enter">키 입력</button>
        ${ch.id==='cafe24' ? '<button class="btn-secondary" data-ch="cafe24" data-act="oauth">OAuth 인증 시작</button>' : ''}
      </div>
    `;
    card.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'enter') {
          alert(`[${ch.name}] 키 입력은 oneboard-server 환경변수로 관리됩니다.\n필요 키: ${ch.keys.join(', ')}\n\n보안 정책상 프론트에서는 키를 저장하지 않습니다.\n서버 측에 발급한 키를 전달해 주세요.`);
        } else if (act === 'oauth') {
          alert('카페24 OAuth 인증은 oneboard-server 설정 후 활성화됩니다.');
        }
      });
    });
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

function openSettingsBody() {
  document.getElementById('settingsGate').style.display = 'none';
  document.getElementById('settingsBody').style.display = '';
  renderChannelKeys();
  renderTeamMgmtList();
  populateSettingsInputs();
}

function lockSettings() {
  localStorage.removeItem('ob_settings_auth');
  document.getElementById('settingsGate').style.display = '';
  document.getElementById('settingsBody').style.display = 'none';
  const pw = document.getElementById('settingsPassword'); if (pw) pw.value = '';
}

function bindSettingsEvents() {
  const unlock = document.getElementById('settingsUnlock');
  const pw = document.getElementById('settingsPassword');
  const err = document.getElementById('settingsErr');
  const tryUnlock = () => {
    if ((pw?.value || '').trim().toUpperCase() === SETTINGS_PASSWORD) {
      localStorage.setItem('ob_settings_auth', 'true');
      openSettingsBody();
    } else {
      if (err) { err.textContent='❌ 비밀번호가 틀렸습니다.'; err.style.display=''; }
    }
  };
  unlock?.addEventListener('click', tryUnlock);
  pw?.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  document.getElementById('settingsLockBtn')?.addEventListener('click', lockSettings);

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
