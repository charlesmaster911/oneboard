import { test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as workspaceHelpers from '../modules/workspace.js';

test('sales dashboard uses attributed revenue for ROAS and clicks rather than site visits', async () => {
  document.body.innerHTML = '<div id="val-sales"></div><div id="val-roas"></div><div id="val-traffic"></div><table><tbody id="tableBody"></tbody></table>';
  const windowStub = {
    addEventListener() {},
    ONEBOARD_WORKSPACE: workspaceHelpers,
    ONEBOARD_CURRENT_USER: { role: 'owner' },
    ONEBOARD_API: { fetch: async path => ({
      ok: true, status: 200,
      json: async () => path.startsWith('/data/daily?')
        ? { rows: [{ date: '2026-09-20', total_sales: 10000, conversion_sales: 2000, ad_spend: 1000, total_traffic: 999, clicks: 20 }] }
        : { rows: [], platforms: [] },
    }) },
  };
  const context = vm.createContext({ window: windowStub, document, console, Intl, Date, setInterval, clearInterval, AbortController });
  vm.runInContext(await readFile('app.js', 'utf8'), context);
  await context.init();
  expect(document.querySelector('#val-sales').textContent).toContain('10,000');
  expect(document.querySelector('#val-roas').textContent).toBe('200%');
  expect(document.querySelector('#val-traffic').textContent).toBe('20');
  expect(document.querySelectorAll('#tableBody td')[5].textContent).toBe('200%');
});
