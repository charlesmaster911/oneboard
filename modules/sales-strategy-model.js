// One model for the authenticated dashboard, preview and unit tests.
export const LABELS={cafe24:'자사몰 · 카페24',youtube:'유튜브 쇼핑',smartstore:'스마트스토어',coupang_mmg:'쿠팡 MMG',coupang_cnf:'쿠팡 C&F',coupang_legacy:'쿠팡 · 기존 합산',kakao_talk:'톡스토어',kakao_gift:'선물하기',wadiz_store:'와디즈 스토어',wadiz_funding:'와디즈 펀딩',newtem:'뉴템',ohouse:'오늘의집',oasis:'오아시스',toss:'토스',cjonstyle:'CJ온스타일',auction:'옥션',gmarket:'G마켓',elevenst:'11번가',lotteon:'롯데온',ssg:'SSG',other_manual:'직거래·기타',naver_sa:'네이버 검색광고',naver_da:'네이버 GFA',meta:'Meta',kakao_ads:'카카오 광고'};
export const SALES=Object.keys(LABELS).filter(x=>!['naver_sa','naver_da','meta','kakao_ads','coupang_legacy'].includes(x));
Object.assign(LABELS,{cafe24_combined:'자사몰+유튜브 · 기존 합산',cafe24_scope_unknown:'카페24 · 몰 범위 미확인',coupang_scope_unknown:'쿠팡 · 계정 범위 미확인',coupang_ezadmin:'쿠팡(자체) · 기존 이지어드민'});
const AD_CHANNELS=['naver_sa','naver_da','meta','coupang_mmg','coupang_cnf','coupang_legacy','youtube','kakao_ads'];
const ALIASES={naver_store:'smartstore',naver_ads:'naver_sa',coupang:'coupang_legacy',kakao:'kakao_ads',youtube_shopping:'youtube',youtube_shop:'youtube',kakao_talk_store:'kakao_talk',today_house:'ohouse',wadiz:'wadiz_store',coupang_abler:'coupang_cnf'};
export const shift=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const kstToday=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(now);
export function windowFor(mode='7d',today=kstToday()) {
  const yesterday=shift(today,-1); let to=yesterday,from;
  if(mode==='weekend') {while(new Date(to+'T00:00:00Z').getUTCDay()!==0)to=shift(to,-1);from=shift(to,-1);}
  else if(mode==='week') {const weekday=new Date(today+'T00:00:00Z').getUTCDay()||7;from=shift(today,1-weekday);if(from>to)from=shift(from,-7);}
  else from=shift(to,mode==='30d'?-29:-6);
  const length=(Date.parse(to)-Date.parse(from))/86400000+1;
  const previous=mode==='weekend'?Array.from({length:4},(_,i)=>({from:shift(from,-7*(i+1)),to:shift(to,-7*(i+1))})):[{from:shift(from,mode==='week'?-7:-length),to:shift(to,mode==='week'?-7:-length)}];
  return {mode,from,to,previous,mondayFallback:mode==='week'&&new Date(today+'T00:00:00Z').getUTCDay()===1,rankFrom:shift(yesterday,-29),rankTo:yesterday,historyFrom:shift(yesterday,-63),historyTo:yesterday};
}
const numeric=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
const ratio=(n,d,factor=1)=>n!==null&&d!==null&&d>0?n/d*factor:null;
const rangeDays=(from,to)=>Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
const inside=(p,r)=>p.date>=r.from&&p.date<=r.to;
export function normalizeHistory(data) {
  const sales=new Map(),ads=new Map(),unclassified=[],mockExcluded=[];
  for(const row of data.legacy||[]) {
    const raw=row.raw_data||{},date=String(row.date).slice(0,10),m={};
    if(raw.mode==='mock'){mockExcluded.push({date,platform:row.platform});continue;}
    let channel=ALIASES[row.platform]||row.platform;
    if(!LABELS[channel]){unclassified.push({date,platform:row.platform});continue;}
    if(row.platform==='coupang')channel=raw.source==='ezadmin'?'coupang_ezadmin':'coupang_scope_unknown';
    const shops=Array.isArray(raw.shop_nos)?raw.shop_nos.map(Number):[];
    if(channel==='cafe24')channel=shops.includes(4)?'cafe24_combined':shops.length===1&&shops[0]===1?'cafe24':'cafe24_scope_unknown';
    const base={channel,date,quality:'collected',source:'기존 원보드 수집',basis:raw.sales_basis||(channel.startsWith('cafe24')?'주문일 기준·취소 주문 제외':'기존 집계 기준 확인 필요'),collected_at:row.collected_at};
    if(SALES.includes(channel)||['coupang_legacy','coupang_scope_unknown','coupang_ezadmin','cafe24_combined','cafe24_scope_unknown'].includes(channel)) {
      m.revenue=numeric(row.total_sales);m.orders=numeric(raw.order_count);
      // Historic zero may be an API failure. Positive historical visits remain provisional.
      m.visitors=raw.traffic_status==='confirmed'||numeric(row.total_traffic)>0?numeric(row.total_traffic):null;
      if(channel!=='cafe24')m.visitors=null;
      sales.set(date+channel,{...base,metrics:m,orderUnit:channel==='smartstore'?'상품결제':'주문',visitUnit:'방문',ratioAllowed:channel==='cafe24'});
    }
    // Only fields actually collected by each source are evidence; DB defaults are not measurements.
    if(['meta','naver_sa','kakao_ads'].includes(channel)&&raw.source!=='ezadmin') {
      const complete=channel!=='kakao_ads';
      ads.set(date+channel,{...base,metrics:{spend:numeric(row.ad_spend),conversion_sales:numeric(row.conversion_sales),purchases:complete?numeric(row.conversions):null,clicks:numeric(row.clicks),impressions:complete?numeric(row.impressions):null},basis:'매체 기여 기준 · 집계기간 확인 필요',clickUnit:channel==='meta'?'전체 클릭':'출처 클릭'});
    }
  }
  for(const report of data.reports||[])for(const record of report.records||[]) {
    if(record.status!=='verified')continue;
    const channel=record.channel,date=record.date||report.report_date,m=record.metrics||{};
    const base={...record,date,quality:'verified',source:record.source||'오전 원천 확인',metrics:m};
    if(SALES.includes(channel)&&numeric(m.revenue)!==null) {
      sales.set(date+channel,{...base,orderUnit:channel==='smartstore'?'상품결제':'주문',visitUnit:channel==='smartstore'?'상품상세 방문':'방문',ratioAllowed:['cafe24','smartstore'].includes(channel)});
    }
    if(AD_CHANNELS.includes(channel)&&numeric(m.spend)!==null)ads.set(date+channel,{...base,clickUnit:'출처 클릭'});
  }
  // A complete pair replaces its legacy combined row. One account alone must not erase the other.
  for(const map of [sales,ads])for(const [key,p] of map) {
    const parts=['coupang_legacy','coupang_scope_unknown'].includes(p.channel)?['coupang_mmg','coupang_cnf']:p.channel==='coupang_ezadmin'?['coupang_mmg']:['cafe24_combined','cafe24_scope_unknown'].includes(p.channel)?['cafe24','youtube']:null;
    if(parts&&parts.every(ch=>map.get(p.date+ch)?.quality==='verified'))map.delete(key);
  }
  return {sales:[...sales.values()],ads:[...ads.values()],unclassified,mockExcluded};
}
function aggregate(points,ranges,channel,type='sales') {
  const selected=points.filter(p=>p.channel===channel&&ranges.some(r=>inside(p,r)));
  const expected=ranges.reduce((n,r)=>n+rangeDays(r.from,r.to),0);
  const sum=key=>{const values=selected.map(p=>numeric(p.metrics[key])).filter(v=>v!==null);return {value:values.length?values.reduce((a,b)=>a+b,0):null,days:values.length};};
  const fields=type==='sales'?['revenue','orders','visitors','gross','refund']:['spend','conversion_sales','purchases','clicks','impressions'];
  const metrics=Object.fromEntries(fields.map(k=>[k,sum(k)]));
  const coverage=metrics[type==='sales'?'revenue':'spend'].days;
  const full=key=>selected.length>0&&metrics[key]?.days===selected.length;
  const bases=[...new Set(selected.map(p=>p.basis||'미확인'))];
  const basisKeys=[...new Set(selected.map(p=>p.basis_code||p.basis||'미확인'))];
  const unit=key=>[...new Set(selected.map(p=>p[key]).filter(Boolean))].join(' / ');
  const consistent=basisKeys.length===1;
  // Do not rank or present a total made from incompatible daily sales/attribution definitions.
  if(basisKeys.length>1)for(const [key,metric] of Object.entries(metrics))if(type==='sales'||['conversion_sales','purchases'].includes(key))metric.value=null;
  const paired=(a,b)=>(consistent||(type==='ads'&&[a,b].every(k=>['spend','clicks','impressions'].includes(k))))&&full(a)&&full(b);
  const verified=selected.filter(p=>p.quality==='verified').length;
  const orders=metrics.orders?.value,visitors=metrics.visitors?.value;
  return {channel,label:LABELS[channel],metrics,coverage,expected,verified,bases,basisKeys,consistent,mixed:basisKeys.length>1,orderUnit:unit('orderUnit'),visitUnit:unit('visitUnit'),clickUnit:unit('clickUnit'),
    active:selected.some(p=>numeric(p.metrics.gross)>0||numeric(p.metrics.revenue)>0||numeric(p.metrics.orders)>0),
    // Product payments / detail visits are deliberately not presented as a universal CVR.
    cvr:type==='sales'&&paired('orders','visitors')&&selected.every(p=>p.ratioAllowed)?ratio(orders,visitors,100):null,
    aov:type==='sales'&&paired('revenue','orders')&&unit('orderUnit')==='주문'?ratio(metrics.revenue.value,orders):null,
    roas:type==='ads'&&paired('conversion_sales','spend')?ratio(metrics.conversion_sales.value,metrics.spend.value,100):null,
    cpa:type==='ads'&&paired('spend','purchases')?ratio(metrics.spend.value,metrics.purchases.value):null,
    ctr:type==='ads'&&paired('clicks','impressions')?ratio(metrics.clicks.value,metrics.impressions.value,100):null,
    cpc:type==='ads'&&paired('spend','clicks')?ratio(metrics.spend.value,metrics.clicks.value):null};
}
export function buildStrategy(data,window) {
  const history=normalizeHistory(data),current=[{from:window.from,to:window.to}],ranking=[{from:window.rankFrom,to:window.rankTo}];
  const channels=[...new Set([...SALES,...history.sales.map(p=>p.channel)])];
  const sales=channels.map(channel=>{
    const row=aggregate(history.sales,current,channel),rank=aggregate(history.sales,ranking,channel),previous=aggregate(history.sales,window.previous,channel);
    const compareReady=row.coverage===row.expected&&previous.coverage===previous.expected&&row.consistent&&previous.consistent&&row.basisKeys[0]===previous.basisKeys[0];
    const baseline=previous.metrics.revenue.value/(window.mode==='weekend'?4:1);
    return {...row,rank,previous,change:compareReady&&baseline>0?(row.metrics.revenue.value/baseline-1)*100:null,group:rank.active?'active':rank.coverage===30&&rank.verified===30&&rank.metrics.revenue.value===0?'zero':'unknown'};
  }).sort((a,b)=>(b.rank.metrics.revenue.value??-Infinity)-(a.rank.metrics.revenue.value??-Infinity));
  const ads=AD_CHANNELS.map(ch=>aggregate(history.ads,current,ch,'ads')).sort((a,b)=>(b.metrics.spend.value??-1)-(a.metrics.spend.value??-1));
  const visible=history.sales.filter(p=>inside(p,current[0]));
  const overlapExclusions=visible.filter(p=>{
    const combined=['cafe24','youtube'].includes(p.channel)?['cafe24_combined']:p.channel==='coupang_mmg'?['coupang_legacy','coupang_ezadmin']:p.channel==='coupang_cnf'?['coupang_legacy']:[];
    return visible.some(x=>x.date===p.date&&combined.includes(x.channel));
  });
  const included=visible.filter(p=>!overlapExclusions.includes(p));
  const ambiguousScope=visible.some(p=>((p.channel==='cafe24_scope_unknown'&&visible.some(x=>x.date===p.date&&['cafe24','youtube'].includes(x.channel)))||(p.channel==='coupang_scope_unknown'&&visible.some(x=>x.date===p.date&&['coupang_mmg','coupang_cnf'].includes(x.channel)))));
  const mixedSales=sales.filter(s=>s.mixed&&included.some(p=>p.channel===s.channel));
  const subtotal=included.reduce((s,p)=>s+(numeric(p.metrics.revenue)??0),0);
  const spend=ads.some(a=>a.metrics.spend.value!==null)?ads.reduce((s,a)=>s+(a.metrics.spend.value??0),0):null;
  const latest=[...history.sales,...history.ads].map(p=>p.collected_at).filter(Boolean).sort().at(-1)||null;
  return {window,sales,ads,subtotal:included.length&&!mixedSales.length&&!ambiguousScope?subtotal:null,spend,latest,
    overlapExclusions,mixedSales,ambiguousScope,unclassified:history.unclassified.filter(p=>inside(p,current[0])),mockExcluded:history.mockExcluded.filter(p=>inside(p,current[0])),
    active:sales.filter(x=>x.group==='active'),zero:sales.filter(x=>x.group==='zero'),unknown:sales.filter(x=>x.group==='unknown'),
    alerts:ads.filter(a=>a.metrics.spend.value>0&&a.metrics.purchases.value===0&&a.metrics.purchases.days===a.metrics.spend.days),
    reports:data.reports||[]};
}
