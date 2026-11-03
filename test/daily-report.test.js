import {test,expect} from 'vitest';
import {renderDailyReport,installDailySales} from '../modules/daily-sales.js';
const report={report_date:'2026-11-02',updated_at:'2026-11-03T00:48:00Z',summary:{confirmed_subtotal:440000,confirmed_ad_spend:12,verified_sales_channels:1,required_sales_channels:20,missing_sales:['smartstore'],missing_ads:['meta'],sales_complete:false,ads_complete:false},records:[{channel:'toss',status:'verified',metrics:{revenue:440000},basis:'<img src=x onerror=alert(1)>',collected_at:'2026-11-03T00:30:00Z',account:'TEST'}],backups:{sales:{status:'failed'}}};
test('partial total, unknown and zero stay distinct, source text is escaped, backup failure is visible',()=>{
  const target=document.createElement('div');renderDailyReport(target,report);
  expect(target.textContent).toContain('확인분 매출 소계');expect(target.textContent).toContain('440,000원');expect(target.textContent).toContain('미확인');expect(target.textContent).toContain('백업 실패');expect(target.querySelector('img')).toBeNull();
  renderDailyReport(target,null);expect(target.textContent).toContain('아직 저장되지');expect(target.textContent).not.toContain('0원');
});
test('logout during pending fetch clears report and stale fetch cannot restore it',async()=>{
  document.body.innerHTML='<section id="dailySalesReport"><form><input type="date"></form><p role="status"></p><div data-report-body></div></section>';
  let resolve;const controller=installDailySales({fetcher:()=>new Promise(r=>{resolve=r;})});
  controller.setUser({role:'ops'});controller.setUser(null);resolve({ok:true,json:async()=>({report})});await new Promise(r=>setTimeout(r,0));
  expect(document.querySelector('#dailySalesReport').hidden).toBe(true);expect(document.querySelector('[data-report-body]').textContent).toBe('');
});
test('original sheet links remain visible before first report without claiming backup success',()=>{
  const target=document.createElement('div');renderDailyReport(target,null);
  expect([...target.querySelectorAll('a')].map(a=>a.href)).toEqual([
    'https://docs.google.com/spreadsheets/d/11byYTuUleS-kq3idS4e0Mgt368FssfnrHchyalHPuRI/edit',
    'https://docs.google.com/spreadsheets/d/1bQXabJqvT6ytJgHZ-CzjGDbGxD2--ZDSJUsZBK3XTbk/edit'
  ]);
  expect(target.textContent).toContain('백업 대기');expect(target.textContent).not.toContain('저장·재조회 확인');
});
