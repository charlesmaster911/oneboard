import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as workspaceHelpers from '../modules/workspace.js';

async function app(fetch) {
  document.body.innerHTML = new DOMParser().parseFromString(await readFile('index.html', 'utf8'), 'text/html').body.innerHTML;
  const windowStub = { addEventListener() {}, ONEBOARD_WORKSPACE: workspaceHelpers,
    ONEBOARD_CURRENT_USER: { role: 'owner' }, ONEBOARD_API: { fetch } };
  const context = vm.createContext({ window: windowStub, document, console, Intl, Date, setInterval, clearInterval, AbortController });
  vm.runInContext(await readFile('app.js', 'utf8'), context);
  return context;
}
const response = payload => ({ ok: true, status: 200, json: async () => payload });

test('a selected date filters both requests, horizontal sales and ad tables, and KPI totals', async () => {
  const paths = [];
  const ctx = await app(async path => {
    paths.push(path);
    if (path.startsWith('/data/daily?')) return response({ rows: [{ date: '2026-09-20', total_sales: 120, ad_spend: 40, clicks: 2 }] });
    if (path.startsWith('/data/daily-by-platform?')) return response({ rows: [
      { date: '2026-09-20', platform: 'cafe24', total_sales: '120' },
      { date: '2026-09-20', platform: 'coupang', total_sales: 0 },
      { date: '2026-09-20', platform: 'meta', ad_spend: 40 },
    ] });
    return response({ platforms: [] });
  });
  await ctx.applySalesRange('2026-09-20', '2026-09-20');
  expect(paths).toContain('/data/daily?from=2026-09-20&to=2026-09-20');
  expect(paths).toContain('/data/daily-by-platform?from=2026-09-20&to=2026-09-20');
  expect([...document.querySelectorAll('#channelMatrixHead th')].map(el => el.textContent))
    .toEqual(['날짜', '카페24', '스마트스토어', '쿠팡 한반도', '카카오 톡스토어', '카카오 선물하기', '합계']);
  expect(document.querySelectorAll('#channelMatrixBody tr')).toHaveLength(1);
  expect([...document.querySelector('#channelMatrixBody tr').children].map(el => el.textContent))
    .toEqual(['2026-09-20', '₩120', '—', '₩0', '—', '—', '₩120']);
  expect(document.querySelector('#channelMatrixFoot td:last-child').textContent).toBe('₩120');
  expect(document.querySelector('#adMatrixFoot td:last-child').textContent).toBe('₩40');
  expect(document.getElementById('val-sales').textContent).toBe('₩120');
  expect(document.getElementById('val-adspend').textContent).toBe('₩40');
  const count = paths.length;
  await ctx.applySalesRange('2026-09-20', '2026-09-19');
  expect(paths).toHaveLength(count);
  expect(document.getElementById('salesDateStatus').textContent).toContain('시작일');
});

test('a late previous date response cannot overwrite the more recently selected date', async () => {
  const releases = [];
  const ctx = await app(async path => {
    if (path.includes('from=2026-09-19')) await new Promise(resolve => releases.push(resolve));
    if (path.startsWith('/data/daily?')) return response({ rows: [{ date: path.includes('09-19') ? '2026-09-19' : '2026-09-20', total_sales: path.includes('09-19') ? 999 : 120 }] });
    return response({ rows: [], platforms: [] });
  });
  const oldRequest = ctx.applySalesRange('2026-09-19', '2026-09-19');
  await ctx.applySalesRange('2026-09-20', '2026-09-20');
  releases.forEach(resolve => resolve());
  await oldRequest;
  expect(document.getElementById('val-sales').textContent).toBe('₩120');
  expect(document.querySelector('#channelMatrixBody th').textContent).toBe('2026-09-20');
});

test('manual shortcut opens the owner form and carries the one-day selection without saving', async () => {
  const calls = [];
  const ctx = await app(async (path, options) => {
    calls.push({ path, options });
    if (path === '/admin/platforms') return response({ data: { platforms: [] } });
    if (path === '/sync/status') return response([]);
    return response({ rows: [], platforms: [{ id: 'coupang', source: 'manual' }] });
  });
  await ctx.applySalesRange('2026-09-20', '2026-09-20');
  ctx.bindHandlersOnce();
  document.querySelector('[data-manual-entry="coupang"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.getElementById('section-settings').style.display).toBe('');
  const form = document.querySelector('[data-manual-metrics="coupang"]');
  expect(form.elements.namedItem('date').value).toBe('2026-09-20');
  expect(form.elements.namedItem('total_sales').value).toBe('');
  expect(document.activeElement).toBe(form.elements.namedItem('date'));
  expect(calls.some(call => call.options?.method === 'POST')).toBe(false);
});

test('failed platform read reports a failed query instead of fabricated zero sales', async () => {
  const ctx = await app(async path => path.startsWith('/data/daily-by-platform?')
    ? { ok: false, status: 500 }
    : response({ rows: [], platforms: [] }));
  await ctx.applySalesRange('2026-09-20', '2026-09-20');
  expect(document.getElementById('salesDateStatus').textContent).toContain('불러오지 못했습니다');
  expect(document.getElementById('val-sales').textContent).toBe('—');
  expect(document.getElementById('matrixSource').textContent).toBe('조회 실패');
});

test('a failed summary after an empty detailed period is not reported as zero sales', async () => {
  const ctx = await app(async path => path.startsWith('/data/summary?')
    ? { ok: false, status: 500 }
    : response({ rows: [], platforms: [] }));
  await ctx.applySalesRange('2026-09-20', '2026-09-20');
  expect(document.getElementById('val-sales').textContent).toBe('—');
  expect(document.getElementById('salesDateStatus').textContent).toContain('불러오지 못했습니다');
});
