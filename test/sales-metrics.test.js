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

test('manual backfill requests thirty Seoul dates without changing the daily schedule', async () => {
  const calls=[];
  const windowStub={addEventListener(){},ONEBOARD_CURRENT_USER:{role:'owner'},ONEBOARD_API:{fetch:async(path, options)=>{
    calls.push({path,options}); return {ok:true,status:202,json:async()=>({})};
  }}};
  const context=vm.createContext({window:windowStub,document,console,Intl,Date,setInterval,clearInterval,AbortController});
  vm.runInContext(await readFile('app.js','utf8'),context);
  await context.requestFullSync(30);
  expect(calls[0].path).toBe('/sync');
  const range=JSON.parse(calls[0].options.body);
  expect((Date.parse(range.date_to)-Date.parse(range.date_from))/86400000).toBe(29);
});

 test('Kakao manual form submits only the selected channel and explicit daily values', async () => {
  const calls=[];
  const windowStub={addEventListener(){},ONEBOARD_WORKSPACE:workspaceHelpers,ONEBOARD_CURRENT_USER:{role:'owner'},ONEBOARD_API:{fetch:async(path,options)=>{
    calls.push({path,options});return {ok:true,status:200,json:async()=>({rows:[],platforms:[]})};
  }}};
  const context=vm.createContext({window:windowStub,document,console,Intl,Date,setInterval,clearInterval,AbortController});
  vm.runInContext(await readFile('app.js','utf8'),context);
  const form=context.manualMetricForm('kakao','카카오모먼트'); document.body.replaceChildren(form);
  const values={date:'2026-09-20',ad_spend:'1000',clicks:'2',conversion_sales:'2500'};
  for(const [name,value] of Object.entries(values))form.elements.namedItem(name).value=value;
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(calls[0].path).toBe('/manual-metrics');
  expect(JSON.parse(calls[0].options.body)).toEqual({platform:'kakao',date:'2026-09-20',ad_spend:1000,clicks:2,conversion_sales:2500});
 });
