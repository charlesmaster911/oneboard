import {buildStrategy,windowFor,kstToday} from './sales-strategy-model.js';
const number=v=>v===null||v===undefined?'—':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:0}).format(v);
const won=v=>v===null||v===undefined?'—':number(v)+'원';
const percent=v=>v===null||v===undefined?'—':v.toFixed(1)+'%';
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const change=v=>v===null?'비교 대기':(v>0?'+':'')+percent(v);
function table(headers,rows,label) {
  const wrap=node('div',undefined,'strategy-table');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',label);
  const t=node('table'),h=node('thead'),tr=node('tr');for(const title of headers){const th=node('th',title);th.scope='col';tr.append(th);}h.append(tr);t.append(h);
  const body=node('tbody');for(const row of rows){const r=node('tr');row.forEach((v,i)=>{const c=node(i?'td':'th');if(!i)c.scope='row';if(v instanceof Node)c.append(v);else c.textContent=v;r.append(c);});body.append(r);}t.append(body);wrap.append(t);return wrap;
}
function channelTitle(r){const e=node('span',undefined,'strategy-channel');e.append(node('strong',r.label),node('small',`선택 기간 ${r.coverage}/${r.expected}일 · 30일 ${r.rank.coverage}/30일 자료 · 원천 대조 ${r.rank.verified}일${r.rank.mixed?' · 기준 혼합: 순위 보류':''}`));return e;}
function salesTable(rows){return table(['판매채널 · 최근 30일 매출순','기간 실매출','실제 유입','구매','구매/방문 비율','객단가','이전 기간 대비'],rows.map(r=>[channelTitle(r),r.mixed?'기준 혼합 · 합산 보류':won(r.metrics.revenue.value),`${number(r.metrics.visitors.value)} ${r.visitUnit||'미측정'}`,`${number(r.metrics.orders.value)} ${r.orderUnit||'미측정'}`,percent(r.cvr),won(r.aov),change(r.change)]),'판매채널별 매출과 구매 흐름');}
function section(title,description){const s=node('section',undefined,'strategy-section');s.append(node('h3',title));if(description)s.append(node('p',description,'strategy-muted'));return s;}
export function renderStrategy(target,model) {
  target.replaceChildren();const w=model.window;
  const compare=w.mode==='weekend'?'직전 4번 주말의 주말당 평균':w.previous.map(x=>`${x.from} ~ ${x.to}`).join(', ');
  target.append(node('p',`${w.from} ~ ${w.to} · 비교 ${compare}`,'strategy-period'));
  if(w.mondayFallback)target.append(node('p','월요일에는 이번 주 완료일이 없어 지난주 전체를 보여줍니다.','strategy-muted'));
  const summary=node('dl',undefined,'strategy-summary');
  for(const [label,value] of [['실매출 · 수집분 소계',won(model.subtotal)],['광고비 · 수집분 소계',won(model.spend)],['최근 30일 매출 발생',model.active.length+'개 채널'],['30일 확인 필요',model.unknown.length+'개 채널']]){const d=node('div');d.append(node('dt',label),node('dd',value));summary.append(d);}target.append(summary);
  if(model.mixedSales.length||model.ambiguousScope)target.append(node('p','매출 기준 또는 몰 포함 범위가 섞여 실매출 소계 합산을 보류했습니다. 아래 집계 기준을 확인하세요.'));
  if(model.unclassified.length||model.mockExcluded.length)target.append(node('p',`미분류 원천 ${model.unclassified.length}건 · 시험 자료 제외 ${model.mockExcluded.length}건. 소계에 포함되지 않았습니다.`));
  const top=section('이번 주 먼저 볼 것','확인된 근거부터 판단합니다. 자료가 부족한 항목은 실행 권고를 보류합니다.');
  const actions=node('ol',undefined,'strategy-actions');
  const waste=model.alerts.length?model.alerts.map(a=>`${a.label} ${won(a.metrics.spend.value)}`).join(' · '):'선택 기간의 광고비·구매 집계 완성도 확인';
  for(const [title,body] of [['광고비 점검',model.alerts.length?`${waste} · 수집된 구매 0건. 집계 지연과 구매 원천을 먼저 확인하세요.`:waste],['집중 판매채널',model.active.length?`${model.active.slice(0,3).map(x=>x.label).join(' · ')}부터 확인하세요. 순위는 ${w.rankFrom}~${w.rankTo} 자료 기준이며 누락일은 제외한 잠정 순위입니다.`:'최근 30일의 판매 원천을 연결하면 우선 채널이 표시됩니다.'],['상세페이지 개선','광고·상품·랜딩 연결과 구매 단계가 아직 미측정입니다. 방문 감소인지, 방문 후 구매 감소인지 확인한 뒤 실험을 정합니다.']]){const li=node('li');li.append(node('strong',title),node('p',body));actions.append(li);}top.append(actions);target.append(top);
  const selling=section('매출이 있는 판매채널','채널 순서는 최근 30일, 표시 수치는 위에서 선택한 기간 기준입니다. 미확인은 0원과 구분합니다.');
  selling.append(model.active.length?salesTable(model.active):node('p','매출 발생이 확인된 채널이 아직 없습니다. 아래 확인 필요 채널을 펼쳐 주세요.'));
  selling.append(node('p','구매/방문 비율은 표에 표시된 구매 단위÷방문 단위입니다. 상품결제와 주문은 다르며, 미측정·혼합 기준은 계산하지 않습니다.','strategy-muted'));
  target.append(selling);
  const advertising=section('광고비가 구매로 이어졌는지','구매 ROAS = 광고 기여 구매매출÷광고비. 실제 매출에 다시 더하지 않습니다. 최근 수치는 집계 지연으로 바뀔 수 있습니다.');
  if(model.ads.some(a=>a.mixed))advertising.append(node('p','광고 기여 기준이 섞인 매체는 구매·기여매출·ROAS·구매당 비용을 보류합니다. 광고비·클릭·노출은 수집분 합계를 유지합니다.'));
  advertising.append(table(['광고매체·계정','광고비','구매','구매당 비용','구매 ROAS','클릭률','수집 일수'],model.ads.map(a=>[a.label,won(a.metrics.spend.value),number(a.metrics.purchases.value),won(a.cpa),percent(a.roas),percent(a.ctr),`${a.coverage}/${a.expected}일`]),'광고매체별 비용과 구매 성과'));
  const adDetail=node('details');adDetail.append(node('summary','광고 노출·클릭·기여매출과 기준 보기'));
  adDetail.append(table(['매체','노출','클릭 · 종류','클릭당 비용','광고 기여매출','집계 기준'],model.ads.map(a=>[a.label,number(a.metrics.impressions.value),`${number(a.metrics.clicks.value)} · ${a.clickUnit||'미측정'}`,won(a.cpc),won(a.metrics.conversion_sales.value),a.bases.join(' / ')||'미확인']),'광고 상세 지표'));
  adDetail.append(node('p','클릭은 실제 방문과 다릅니다. 계정 일별 자료에는 캠페인·소재·랜딩 연결이 아직 없어 세부 광고 비교는 미측정입니다.'));advertising.append(adDetail);target.append(advertising);
  const funnel=section('상품·상세페이지에서 어디가 막히는지','연결 가능한 실제 측정값이 들어오면 상품과 유입원별로 확인합니다.');
  const steps=node('ol',undefined,'strategy-funnel');for(const title of ['실제 도착','상품 조회','장바구니 / 바로구매','결제 시작','구매']){const li=node('li');li.append(node('strong',title),node('span','연결 미측정'));steps.append(li);}funnel.append(steps);
  const checks=node('details');checks.append(node('summary','이번 주·주말 판단 기준'));checks.append(table(['관측','먼저 점검할 것'],[['클릭률↓ · 방문 후 구매율 유지','첫 장면·문구·검색어·타깃'],['클릭 유지 · 실제 도착↓','링크·로딩·측정 오류'],['실제 방문↑ · 구매율↓','유입 품질·페이지 첫 화면·가격·리뷰·배송'],['결제 시작 유지 · 구매↓','배송비·옵션·재고·결제 오류'],['구매당 비용·ROAS 안정','표본·마진·재고 확인 후 제한적 확대 검토']],'전략 점검 기준'));funnel.append(checks);target.append(funnel);
  const bottom=section('매출 0·미확인 채널과 운영 상태');
  for(const [title,rows] of [['최근 30일 전체 확인 · 매출 0',model.zero],['최근 30일 확인 필요',model.unknown]]){const d=node('details');d.append(node('summary',`${title} · ${rows.length}개`));d.append(rows.length?salesTable(rows):node('p','해당 채널이 없습니다.'));bottom.append(d);}
  const method=node('details');method.append(node('summary','집계 기준·원천 확인 상태'));
  method.append(node('p','‘자료’는 원보드에 저장된 날짜 수, ‘원천 대조’는 오전 검증 보고서가 있는 날짜 수입니다. 날짜가 있어도 서로 다른 매출 기준은 비교하지 않습니다. 빈 날은 0원으로 채우지 않습니다.'));
  if(model.overlapExclusions.length)method.append(node('p',`기존 합산에 포함되는 개별 채널 ${model.overlapExclusions.length}건은 소계 중복 합산에서 제외했습니다. 두 개별 원천이 모두 확인되면 기존 합산을 대체합니다.`));
  if(model.unclassified.length)method.append(node('p','미분류 원천: '+[...new Set(model.unclassified.map(p=>p.platform))].join(', ')));
  method.append(table(['채널','선택 기간 수집일','매출 기준'],model.sales.filter(r=>r.coverage).map(r=>[r.label,`${r.coverage}/${r.expected}일`,r.bases.join(' / ')]),'판매채널 집계 기준'));bottom.append(method);
  bottom.append(node('p','오전 수집·백업 상세는 아래 ‘오전 보고서와 백업’에서 확인합니다. 09:00 수집 시작 · 09:55 확인분 보고.','strategy-muted'));
  bottom.append(node('small',model.latest?'마지막 원천 수집: '+new Date(model.latest).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'원천 수집시각 미확인'));target.append(bottom);
}
export function installSalesStrategy({fetcher,root=document.getElementById('salesStrategy'),today=()=>kstToday()}={}) {
  if(!root)return {setUser(){}};
  let generation=0,allowed=false,mode='7d',cache=null;
  const body=root.querySelector('[data-strategy-body]'),status=root.querySelector('[role=status]');
  const buttons=[...root.querySelectorAll('[data-strategy-period]')];
  function draw(){const w=windowFor(mode,today());renderStrategy(body,buildStrategy(cache,w));buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.strategyPeriod===mode)));status.textContent='조회 완료 · 누락일과 집계 기준을 함께 확인하세요.';}
  async function load(){if(!allowed)return;const v=++generation,w=windowFor(mode,today());body.replaceChildren();status.textContent='매출·광고 자료를 불러오는 중…';root.setAttribute('aria-busy','true');
    try {const response=await fetcher(`/daily-sales/strategy?from=${w.historyFrom}&to=${w.historyTo}`);if(!response.ok)throw Error();const result=await response.json();if(v!==generation||!allowed)return;if(result.from!==w.historyFrom||result.to!==w.historyTo||!Array.isArray(result.legacy)||!Array.isArray(result.reports))throw Error();cache=result;draw();}
    catch {if(v===generation&&allowed){cache=null;body.replaceChildren();status.textContent='자료를 불러오지 못했습니다. 새로고침으로 다시 시도하거나 아래 기존 수집자료를 확인하세요.';}}
    finally {if(v===generation)root.removeAttribute('aria-busy');}}
  buttons.forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.strategyPeriod;if(cache)draw();else void load();}));
  root.querySelector('[data-strategy-refresh]')?.addEventListener('click',()=>{cache=null;void load();});
  return {setUser(user){generation++;allowed=['owner','ops','marketing'].includes(user?.role);root.hidden=!allowed;cache=null;body.replaceChildren();status.textContent='';root.removeAttribute('aria-busy');if(allowed)void load();}};
}
