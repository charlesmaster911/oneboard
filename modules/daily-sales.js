const LABELS = {cafe24:'카페24',youtube:'유튜브 쇼핑',smartstore:'스마트스토어',coupang_mmg:'쿠팡 MMG',coupang_cnf:'쿠팡 C&F',kakao_talk:'톡스토어',kakao_gift:'선물하기',wadiz_store:'와디즈 스토어',wadiz_funding:'와디즈 펀딩',newtem:'뉴템',ohouse:'오늘의집',oasis:'오아시스',toss:'토스',cjonstyle:'CJ온스타일',auction:'옥션',gmarket:'G마켓',elevenst:'11번가',lotteon:'롯데온',ssg:'SSG',other_manual:'직거래·기타',naver_sa:'네이버 검색광고',naver_da:'네이버 GFA',meta:'META'};
const ADS = ['naver_sa','naver_da','coupang_mmg','coupang_cnf','meta','youtube'];
const BACKUPS = {integrated:['통합 리포트 원본','11byYTuUleS-kq3idS4e0Mgt368FssfnrHchyalHPuRI'],sales:['업체별 매출 원본','1bQXabJqvT6ytJgHZ-CzjGDbGxD2--ZDSJUsZBK3XTbk']};
const won = value => typeof value==='number' && Number.isFinite(value)?new Intl.NumberFormat('ko-KR').format(value)+'원':'미확인';
function el(tag,text,cls) { const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(cls)node.className=cls; return node; }
function appendBackups(target,report) {
  const backups=el('div',undefined,'daily-report-backups');backups.append(el('strong','자동 갱신 대상 · 원본 두 시트'));
  for(const [key,[label,id]] of Object.entries(BACKUPS)) {
    const p=el('p'),a=el('a',label);a.href=`https://docs.google.com/spreadsheets/d/${id}/edit`;a.target='_blank';a.rel='noopener noreferrer';
    const state=report?.backups?.[key]?.status;
    p.append(a,document.createTextNode(' · '+({verified:'저장·재조회 확인',failed:'백업 실패, 재시도 필요'}[state]||'백업 대기')));backups.append(p);
  }
  target.append(backups);
}
export function renderDailyReport(target,report) {
  target.replaceChildren();
  if (!report) { target.append(el('p','이 날짜의 오전 보고서가 아직 저장되지 않았습니다. 미실행·수집 중 여부를 확인해 주세요.')); appendBackups(target,null); return; }
  const s=report.summary, records=new Map(report.records.map(r=>[r.channel,r]));
  target.append(el('p',`${report.report_date} · ${s.sales_complete&&s.ads_complete?'완료':'부분완료'} · 매출 ${s.verified_sales_channels}/${s.required_sales_channels}개 채널 확인`,'daily-report-status'));
  const cards=el('div',undefined,'daily-report-kpis');
  for(const [label,value] of [[s.sales_complete?'확인된 전체 매출':'확인분 매출 소계',won(s.confirmed_subtotal)],['확인분 광고비',won(s.confirmed_ad_spend)],['미확인 매출 채널',s.missing_sales.length+'개']]) {
    const card=el('div'); card.append(el('span',label),el('strong',value)); cards.append(card);
  }
  target.append(cards,el('p','광고 전환매출은 실매출 합계에 포함하지 않습니다. 미확인 채널은 0원으로 처리하지 않습니다.','daily-report-note'));
  if(s.missing_sales.length) target.append(el('p','확인 필요: '+s.missing_sales.map(ch=>LABELS[ch]).join(' · '),'daily-report-warning'));
  target.append(el('p','광고: '+(s.ads_complete?'전체 지표 확인':'일부 지표 대기 · '+[...s.missing_ads,...(s.youtube_ad_spend_pending?['youtube']:[])].map(ch=>LABELS[ch]).join(' · '))));
  const wrap=el('div',undefined,'daily-report-table'); wrap.tabIndex=0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','채널별 확인 금액과 상태');
  const table=el('table'), head=el('thead'), hrow=el('tr');
  for(const label of ['채널','실매출','상태·집계 기준']) { const th=el('th',label); th.scope='col';hrow.append(th); } head.append(hrow);table.append(head);
  const body=el('tbody');
  for(const [ch,label] of Object.entries(LABELS).filter(([ch])=>!['naver_sa','naver_da','meta'].includes(ch))) {
    const r=records.get(ch), confirmed=r?.status==='verified' && r.metrics.revenue!==undefined;
    const row=el('tr'), title=el('th',label); title.scope='row';
    const cell=el('td'), detail=el('details'); detail.append(el('summary',confirmed?'확인 완료':r?.status==='auth_required'?'인증 필요':'미확인'),el('p',confirmed?r.basis:r?.reason||'매출 지표 대기'));
    if(confirmed)detail.append(el('small',`확인 ${new Date(r.collected_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · ${r.account}`));
    cell.append(detail);row.append(title,el('td',confirmed?won(r.metrics.revenue):'미확인'),cell);body.append(row);
  }
  table.append(body);wrap.append(table);target.append(wrap);
  const ads=el('details');ads.append(el('summary','광고비·전환매출 상세'));
  for(const ch of ADS) { const r=records.get(ch); ads.append(el('p',`${LABELS[ch]} · 광고비 ${won(r?.status==='verified'?r.metrics.spend:undefined)} · 전환매출 ${won(r?.status==='verified'?r.metrics.conversion_sales:undefined)}`)); }
  target.append(ads);
  appendBackups(target,report);
  target.append(el('small',(report.preview?'검토 자료 기준 시각: ':'원보드 저장 확인: ')+new Date(report.updated_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})));
}
export function installDailySales({fetcher,root=document.getElementById('dailySalesReport')}={}) {
  if(!root)return {setUser(){}};
  let revision=0,allowed=false;
  const input=root.querySelector('input'), target=root.querySelector('[data-report-body]'),status=root.querySelector('[role=status]');
  input.value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(Date.now()-86400000));
  async function load() {
    if(!allowed)return;
    const version=++revision,date=input.value;
    target.replaceChildren();status.textContent='보고서 조회 중…';
    try {
      const response=await fetcher('/daily-sales/report/'+encodeURIComponent(date));
      if(!response.ok)throw new Error('READ_FAILED');
      const data=await response.json(); if(version!==revision||!allowed)return;
      if(data.report && data.report.report_date!==date)throw new Error('DATE_MISMATCH');
      renderDailyReport(target,data.report);status.textContent=data.report?'조회 완료':'보고서 없음';
    }catch {if(version===revision&&allowed){target.replaceChildren();status.textContent='오전 보고서를 불러오지 못했습니다. 기존 수집자료와 구분해 확인해 주세요.';}}
  }
  root.querySelector('form').addEventListener('submit',e=>{e.preventDefault();void load();});
  return {setUser(user){revision++;allowed=['owner','ops','marketing'].includes(user?.role);root.hidden=!allowed;target.replaceChildren();status.textContent='';if(allowed)void load();}};
}
