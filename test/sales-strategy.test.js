import {test,expect} from 'vitest';
import {normalizeHistory,buildStrategy,windowFor,shift} from '../modules/sales-strategy-model.js';
import {renderStrategy,installSalesStrategy} from '../modules/sales-strategy.js';
const window=windowFor('30d','2026-11-03');
const legacy=(platform,date,total_sales,extra={})=>({platform,date,total_sales,raw_data:platform==='cafe24'?{shop_nos:[1]}:{},...extra});
test('ranking uses 30 complete KST days; weekend reference has four non-overlapping weekends',()=>{
  expect(window.rankFrom).toBe('2026-10-04');expect(window.to).toBe('2026-11-02');
  const w=windowFor('weekend','2026-11-03');expect(w.from).toBe('2026-10-31');expect(w.to).toBe('2026-11-01');expect(w.previous).toHaveLength(4);expect(w.previous[0].to).toBe('2026-10-25');
});
test('sales priorities, refund-active, missing vs verified zero, ad clicks excluded from store traffic',()=>{
  const reports=Array.from({length:30},(_,i)=>({report_date:shift('2026-10-04',i),records:[{channel:'oasis',status:'verified',metrics:{revenue:0},basis:'net'}]}));
  const model=buildStrategy({reports,legacy:[legacy('cafe24','2026-11-02',100),legacy('naver_store','2026-11-02',200),legacy('toss','2026-11-02',-20,{raw_data:{order_count:1}}),legacy('meta','2026-11-02',5000,{total_traffic:900,ad_spend:10,conversion_sales:20,conversions:1})]},window);
  expect(model.active.map(x=>x.channel)).toEqual(['smartstore','cafe24','toss']);expect(model.zero.map(x=>x.channel)).toEqual(['oasis']);expect(model.unknown.map(x=>x.channel)).toContain('gmarket');expect(model.subtotal).toBe(280);expect(model.ads.find(x=>x.channel==='meta').roas).toBe(200);expect(model.sales.some(x=>x.channel==='meta')).toBe(false);
});
test('report replaces a daily source without adding twice; missing traffic remains unknown',()=>{
 const data={legacy:[legacy('cafe24','2026-11-02',100,{total_traffic:0,raw_data:{order_count:3}})],reports:[{report_date:'2026-11-02',records:[{channel:'cafe24',status:'verified',basis:'net',metrics:{revenue:80}}]}]};
 const rows=normalizeHistory(data).sales;expect(rows.find(x=>x.channel==='cafe24').metrics.revenue).toBe(80);expect(rows.find(x=>x.channel==='cafe24').metrics.orders).toBeUndefined();
 const m=buildStrategy(data,window);expect(m.active[0].cvr).toBeNull();expect(m.active[0].change).toBeNull();
});
const report=(date,records)=>({report_date:date,records:records.map(r=>({status:'verified',basis:'net',...r}))});
test('separate morning Cafe24 and YouTube are additive and replace a combined legacy day only as a pair',()=>{
 const records=[{channel:'cafe24',metrics:{revenue:30}},{channel:'youtube',metrics:{revenue:70}}];
 const data={legacy:[legacy('cafe24','2026-11-01',100,{raw_data:{shop_nos:[1,4]}}),legacy('cafe24','2026-11-02',120,{raw_data:{shop_nos:[1,4]}})],reports:[report('2026-11-02',records)]};
 expect(buildStrategy(data,window).subtotal).toBe(200);
 expect(buildStrategy({reports:data.reports},window).subtotal).toBe(100);
 expect(normalizeHistory(data).sales.filter(x=>x.date==='2026-11-02')).toHaveLength(2);
 const partial={...data,reports:[report('2026-11-02',records.slice(0,1))]};
 expect(buildStrategy(partial,window).subtotal).toBe(220);
 expect(buildStrategy(partial,window).overlapExclusions).toHaveLength(1);
});
test('mixed daily bases suppress sums and rankings; combined orders never divide by main-store visits',()=>{
 const data={legacy:[legacy('smartstore','2026-11-01',100,{raw_data:{sales_basis:'order date'}}),legacy('cafe24','2026-11-02',50,{total_traffic:100,raw_data:{shop_nos:[1,4],order_count:10,traffic_status:'confirmed'}})],reports:[report('2026-11-02',[{channel:'smartstore',metrics:{revenue:200}}])]};
 const m=buildStrategy(data,window),row=m.sales.find(x=>x.channel==='smartstore');
 expect(m.subtotal).toBeNull();expect(row.mixed).toBe(true);expect(row.metrics.revenue.value).toBeNull();expect(row.rank.metrics.revenue.value).toBeNull();
 expect(m.sales.find(x=>x.channel==='cafe24_combined').cvr).toBeNull();
});
test('known historical aliases map, unknown names surface, mock data is excluded',()=>{
 const m=buildStrategy({legacy:[legacy('kakao_talk_store','2026-11-02',10),legacy('today_house','2026-11-02',20),legacy('wadiz','2026-11-02',30),legacy('coupang_abler','2026-11-02',40),legacy('youtube_shop','2026-11-02',50),legacy('etc:unknown','2026-11-02',999),legacy('toss','2026-11-02',1000,{raw_data:{mode:'mock',source:'ezadmin'}})]},window);
 expect(m.subtotal).toBe(150);expect(m.unclassified).toHaveLength(1);expect(m.mockExcluded).toHaveLength(1);expect(m.active).toHaveLength(5);
});
test('manual sales do not invent ads; Kakao missing purchase counts never trigger zero-purchase alert',()=>{
 const m=buildStrategy({legacy:[legacy('coupang','2026-11-02',100,{ad_spend:0,conversions:0,raw_data:{collector:'manual'}}),legacy('kakao','2026-11-02',0,{ad_spend:50000,conversion_sales:150000,conversions:0,clicks:100,impressions:0,raw_data:{collector:'manual'}})]},window);
 const kakao=m.ads.find(x=>x.channel==='kakao_ads');expect(kakao.roas).toBe(300);expect(kakao.metrics.purchases.value).toBeNull();expect(kakao.ctr).toBeNull();expect(m.alerts).toHaveLength(0);expect(m.ads.find(x=>x.channel==='coupang_legacy').metrics.spend.value).toBeNull();
});
test('attribution changes hold purchase ratios but preserve measured ad spend, clicks and impressions',()=>{
 const m=buildStrategy({legacy:[legacy('meta','2026-11-01',0,{ad_spend:100,clicks:10,impressions:1000,conversions:1,conversion_sales:200})],reports:[report('2026-11-02',[{channel:'meta',basis:'new attribution',metrics:{spend:200,clicks:20,impressions:2000,purchases:2,conversion_sales:300}}])]},window);
 const a=m.ads.find(a=>a.channel==='meta');expect(m.spend).toBe(300);expect(a.metrics.clicks.value).toBe(30);expect(a.metrics.impressions.value).toBe(3000);expect(a.roas).toBeNull();expect(a.cpa).toBeNull();expect(a.ctr).toBe(1);
});
test('verified stable contract code survives daily note changes, while changed contract versions hold totals',()=>{
 const records=[report('2026-11-01',[{channel:'toss',basis:'11/1 note',basis_code:'toss_daily_source_v1',metrics:{revenue:100}}]),report('2026-11-02',[{channel:'toss',basis:'11/2 new note',basis_code:'toss_daily_source_v1',metrics:{revenue:200}}])];
 expect(buildStrategy({reports:records},window).subtotal).toBe(300);
 records[1].records[0].basis_code='toss_daily_source_v2';expect(buildStrategy({reports:records},window).subtotal).toBeNull();
});
test('Ezadmin own-store and Abler accounts remain additive; unknown manual account overlap is held',()=>{
 const rows=[legacy('coupang','2026-11-02',100,{raw_data:{source:'ezadmin'}}),legacy('coupang_abler','2026-11-02',200,{raw_data:{source:'ezadmin'}})];
 expect(buildStrategy({legacy:rows},window).subtotal).toBe(300);
 expect(buildStrategy({legacy:[{...rows[0],raw_data:{collector:'manual'}},rows[1]]},window).subtotal).toBeNull();
});
test('unknown Cafe24 scope overlapping YouTube blocks subtotal, never silently discards YouTube',()=>{
 const m=buildStrategy({legacy:[legacy('cafe24','2026-11-02',100,{raw_data:{}})],reports:[report('2026-11-02',[{channel:'youtube',metrics:{revenue:70}}])]},window);
 expect(m.subtotal).toBeNull();expect(m.ambiguousScope).toBe(true);expect(m.overlapExclusions).toHaveLength(0);
});
test('week windows across all weekdays and visible coverage/click types/Monday fallback',()=>{
 for(let i=0;i<7;i++){const w=windowFor('week',shift('2026-11-02',i));expect(w.from).toBe(i?'2026-11-02':'2026-10-26');expect(w.to).toBe(shift('2026-11-02',i-1));expect(w.mondayFallback).toBe(i===0);}
 const w=windowFor('week','2026-11-02'),m=buildStrategy({legacy:[legacy('meta','2026-11-01',0,{ad_spend:1,clicks:1,impressions:100}),legacy('toss','2026-11-01',100)]},w),target=document.createElement('div');renderStrategy(target,m);
 expect(target.textContent).toContain('지난주 전체');expect(target.textContent).toContain('선택 기간 1/7일');expect(target.textContent).toContain('전체 클릭');
});
test('ratios use matched numerator/denominator days; zero spend is unavailable',()=>{
 const records=[{channel:'meta',status:'verified',basis:'purchase7d',metrics:{spend:0,conversion_sales:100,purchases:1}}];
 const data={reports:[{report_date:'2026-11-01',records},{report_date:'2026-11-02',records:[{channel:'meta',status:'verified',basis:'purchase7d',metrics:{spend:10}}]}]};
 expect(buildStrategy(data,window).ads.find(x=>x.channel==='meta').roas).toBeNull();
 expect(buildStrategy({reports:data.reports.slice(0,1)},window).ads.find(x=>x.channel==='meta').roas).toBeNull();
});
test('rendering is text safe; period buttons and sections remain visible without invented funnel',()=>{
 const m=buildStrategy({legacy:[legacy('cafe24','2026-11-02',100,{raw_data:{sales_basis:'<img src=x onerror=alert(1)>'}})]},window);const target=document.createElement('div');renderStrategy(target,m);expect(target.querySelector('img')).toBeNull();expect(target.textContent).toContain('연결 미측정');expect(target.textContent).toContain('원천 대조 0일');expect(target.querySelectorAll('details').length).toBeGreaterThan(2);
});
test('logout clears strategy and ignores an outstanding history response',async()=>{
 document.body.innerHTML='<section id="salesStrategy"><button data-strategy-period="7d"></button><p role="status"></p><div data-strategy-body></div></section>';let resolve;const c=installSalesStrategy({fetcher:()=>new Promise(r=>resolve=r),today:()=> '2026-11-03'});c.setUser({role:'ops'});c.setUser(null);resolve({ok:true,json:async()=>({from:'2026-08-31',to:'2026-11-02',legacy:[],reports:[]})});await new Promise(r=>setTimeout(r,0));expect(document.querySelector('#salesStrategy').hidden).toBe(true);expect(document.querySelector('[data-strategy-body]').textContent).toBe('');
});
