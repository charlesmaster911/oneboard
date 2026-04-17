/**
 * OneBoard — 원보드 메인 앱
 * Google Sheets CSV 실시간 연동 + Chart.js 대시보드
 *
 * 데이터 구조 (통합 탭):
 *   날짜 | 총 매출 | 총 유입 | 전환 매출 | 총 광고비 | 총 ROAS | 전환 ROAS | 광고비율
 */

// OneBoard API 서버 (로컬: 4000, 배포: Render URL)
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:4000'
  : 'https://oneboard-server.onrender.com';

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

// ─── 데이터 테이블 ───────────────────────────────────────────
function renderTable(data) {
  const tbody = document.getElementById('tableBody');
  if (!tbody) return;

  const rows = [...data].reverse().slice(0, 60);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-row">데이터 없음</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const roasClass = r.totalROAS >= 1000 ? 'td-up' : r.totalROAS < 500 ? 'td-down' : '';
    const adClass   = r.adRatio  <= 8    ? 'td-up' : r.adRatio  > 15   ? 'td-down' : '';
    return `
      <tr>
        <td>${r.date}</td>
        <td>${fmtKRW(r.totalSales)}</td>
        <td>${r.totalTraffic.toLocaleString('ko-KR')}</td>
        <td>${fmtKRW(r.convSales)}</td>
        <td>${fmtKRW(r.totalAdSpend)}</td>
        <td class="${roasClass}">${r.totalROAS}%</td>
        <td class="${adClass}">${r.adRatio.toFixed(1)}%</td>
      </tr>`;
  }).join('');
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
        // 매핑 미정 채널
        notice.style.display = 'block';
        notice.querySelector('span').textContent = `⚠️ ${currentChannel} 채널 연동 준비 중입니다.`;
      }
    });
  });

  // CSV 내보내기
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    exportCSV(filteredData);
  });
}

// ─── API 호출 헬퍼 ──────────────────────────────────────────
async function apiGet(path) {
  const token = localStorage.getItem('ob_token');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const token = localStorage.getItem('ob_token');
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ─── AI 인사이트 배너 ────────────────────────────────────────
async function loadInsights() {
  const bar = document.getElementById('insightsBar');
  const list = document.getElementById('insightsList');
  if (!bar || !list) return;

  try {
    const insights = await apiGet('/api/insights?limit=5&unread=true');
    if (!insights.length) { bar.style.display = 'none'; return; }

    bar.style.display = 'flex';
    list.innerHTML = insights.map(ins => `
      <div class="insight-chip priority-${Math.min(ins.priority, 3)}"
           title="${ins.body}" data-id="${ins.id}">
        <span class="insight-dot"></span>
        <span class="insight-chip-text">${ins.title}</span>
      </div>
    `).join('');

    list.querySelectorAll('.insight-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        alert(chip.title);
        await apiPost(`/api/insights/read/${chip.dataset.id}`, {}).catch(() => {});
        chip.style.opacity = '0.4';
      });
    });
  } catch {
    bar.style.display = 'none';
  }
}

async function triggerAiAnalysis() {
  const btn = document.getElementById('insightsRefresh');
  if (btn) { btn.textContent = '분석 중...'; btn.disabled = true; }
  try {
    await apiPost('/api/insights/analyze', {});
    await loadInsights();
  } catch {
    // 서버 미연결 시 조용히 실패
  } finally {
    if (btn) { btn.textContent = '↻ AI 분석'; btn.disabled = false; }
  }
}

// ─── 연간 목표 달성 ──────────────────────────────────────────
async function loadGoalProgress() {
  try {
    const data = await apiGet('/api/projects/simulate');
    document.getElementById('goalTarget').textContent = fmtKRW(data.goal);
    document.getElementById('goalYtd').textContent    = fmtKRW(data.ytd_sales);
    document.getElementById('goalRemain').textContent  = fmtKRW(data.remaining_goal);
    document.getElementById('goalPipeline').textContent = fmtKRW(data.project_pipeline);
    document.getElementById('goalPct').textContent    = `${data.achievement_pct}%`;

    const pct = Math.min(parseFloat(data.achievement_pct), 100);
    const fill = document.getElementById('goalBarFill');
    if (fill) fill.style.width = `${pct}%`;
  } catch {
    // Google Sheets 매출 합산으로 폴백
    const ytd = allData.reduce((s, d) => s + d.totalSales, 0);
    const goal = 2000000000;
    const pct  = ((ytd / goal) * 100).toFixed(1);
    document.getElementById('goalYtd').textContent     = fmtKRW(ytd);
    document.getElementById('goalRemain').textContent   = fmtKRW(Math.max(goal - ytd, 0));
    document.getElementById('goalPct').textContent     = `${pct}%`;
    document.getElementById('goalPipeline').textContent = '—';
    const fill = document.getElementById('goalBarFill');
    if (fill) fill.style.width = `${Math.min(parseFloat(pct), 100)}%`;
  }
}

// ─── 재고 위험 현황 ──────────────────────────────────────────
async function loadInventory() {
  const list = document.getElementById('stockList');
  const badge = document.getElementById('stockAlertCount');
  if (!list) return;

  try {
    const items = await apiGet('/api/inventory');
    const alerts = items.filter(i => i.stock_status !== 'ok');
    if (badge) {
      badge.textContent = alerts.length ? `${alerts.length}개 위험` : '정상';
      badge.className = `ops-badge ${alerts.length ? '' : 'badge-blue'}`;
    }

    if (!items.length) { list.innerHTML = '<div class="ops-empty">등록된 상품 없음</div>'; return; }

    list.innerHTML = items.slice(0, 6).map(item => {
      const days = item.days_remaining;
      const daysText = days != null ? `${days}일 후 품절` : '소진율 미설정';
      const statusMap = { critical: ['status-critical','위험'], warning: ['status-warning','주의'], ok: ['status-ok','정상'] };
      const [cls, label] = statusMap[item.stock_status] || ['status-ok','정상'];
      return `
        <div class="stock-item">
          <div>
            <div class="stock-name">${item.product_name}</div>
            <div class="stock-sub">현재 재고 ${item.current_stock.toLocaleString()}개</div>
          </div>
          <div class="stock-right">
            <span class="stock-days" style="color:${item.stock_status==='critical'?'#EF4444':item.stock_status==='warning'?'#F59E0B':'#64748B'}">${daysText}</span>
            <span class="stock-status ${cls}">${label}</span>
          </div>
        </div>`;
    }).join('');
  } catch {
    // 목업 데이터
    if (badge) { badge.textContent = '서버 미연결'; badge.className = 'ops-badge'; }
    list.innerHTML = `
      <div class="stock-item">
        <div><div class="stock-name">듀오메이커 2kg</div><div class="stock-sub">현재 재고 240개</div></div>
        <div class="stock-right"><span class="stock-days" style="color:#F59E0B">12일 후 품절</span><span class="stock-status status-warning">주의</span></div>
      </div>
      <div class="stock-item">
        <div><div class="stock-name">쥬얼아이스 3kg</div><div class="stock-sub">현재 재고 85개</div></div>
        <div class="stock-right"><span class="stock-days" style="color:#EF4444">4일 후 품절</span><span class="stock-status status-critical">위험</span></div>
      </div>
      <div class="stock-item">
        <div><div class="stock-name">쥬얼아이스 1kg</div><div class="stock-sub">현재 재고 620개</div></div>
        <div class="stock-right"><span class="stock-days" style="color:#64748B">30일 후 품절</span><span class="stock-status status-ok">정상</span></div>
      </div>`;
  }
}

// ─── 프로젝트 우선순위 ───────────────────────────────────────
async function loadProjects() {
  const list = document.getElementById('projectList');
  const badge = document.getElementById('projectCount');
  if (!list) return;

  try {
    const projects = await apiGet('/api/projects?status=planned');
    if (badge) badge.textContent = `${projects.length}개 진행중`;

    if (!projects.length) { list.innerHTML = '<div class="ops-empty">등록된 프로젝트 없음</div>'; return; }

    list.innerHTML = projects.slice(0, 5).map((p, i) => {
      const rank = i + 1;
      const roi = p.roi_pct ? `ROI ${p.roi_pct}%` : '—';
      const riskDots = [1,2,3,4,5].map(n =>
        `<span class="risk-dot ${n <= p.risk_level ? 'filled' : ''}"></span>`
      ).join('');
      return `
        <div class="project-item">
          <div class="project-rank rank-${Math.min(rank,3)}">${rank}</div>
          <div class="project-info">
            <div class="project-name">${p.name}</div>
            <div class="project-sub">${fmtKRW(p.budget)} 투입 · 기대 ${fmtKRW(p.expected_revenue)}</div>
          </div>
          <div class="project-right">
            <div class="project-roi">${roi}</div>
            <div class="project-risk" title="리스크 레벨">${riskDots}</div>
          </div>
        </div>`;
    }).join('');
  } catch {
    // 목업
    if (badge) badge.textContent = '서버 미연결';
    list.innerHTML = `
      <div class="project-item">
        <div class="project-rank rank-1">1</div>
        <div class="project-info"><div class="project-name">MIF (마이크로 아이스팩토리)</div><div class="project-sub">₩0 투입 · 기대 ₩4,000만</div></div>
        <div class="project-right"><div class="project-roi">ROI ∞</div><div class="project-risk"><span class="risk-dot filled"></span><span class="risk-dot"></span><span class="risk-dot"></span><span class="risk-dot"></span><span class="risk-dot"></span></div></div>
      </div>
      <div class="project-item">
        <div class="project-rank rank-2">2</div>
        <div class="project-info"><div class="project-name">킥스타터 해외 진출</div><div class="project-sub">₩500만 투입 · 기대 ₩5,000만</div></div>
        <div class="project-right"><div class="project-roi">ROI 900%</div><div class="project-risk"><span class="risk-dot filled"></span><span class="risk-dot filled"></span><span class="risk-dot filled"></span><span class="risk-dot"></span><span class="risk-dot"></span></div></div>
      </div>`;
  }
}

// ─── 초기화 ──────────────────────────────────────────────────
async function init() {
  bindEvents();

  // AI 인사이트 새로고침 버튼
  document.getElementById('insightsRefresh')?.addEventListener('click', triggerAiAnalysis);

  // Google Sheets에서 데이터 패치
  try {
    const csv = await fetchSheetCSV(SHEET_GIDS.main);
    allData = parseSheetRows(csv, '통합');
    channelDataCache['통합'] = allData;
    if (allData.length === 0) throw new Error('파싱된 데이터 없음');
    const srcEl = document.getElementById('dataSource');
    if (srcEl) srcEl.textContent = `Google Sheets 실시간 연동 ✓  (${allData.length}일 · 채널 8개)`;
  } catch (err) {
    console.warn('[OneBoard] 시트 연동 실패 → 목업 데이터 사용:', err.message);
    allData = buildMockData();
    channelDataCache['통합'] = allData;
    const srcEl = document.getElementById('dataSource');
    if (srcEl) srcEl.textContent = '목업 데이터 (시트 공개 후 자동 연동)';
  }

  updateDashboard();

  // 운영 패널 병렬 로드
  Promise.all([
    loadInsights(),
    loadGoalProgress(),
    loadInventory(),
    loadProjects(),
  ]);
}

document.addEventListener('DOMContentLoaded', init);
