# 팀업무·회의록 인터랙티브 복원 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 팀업무와 회의록을 읽기·검색·입력·수정·삭제할 수 있는 운영 화면으로 복원한다.

**Architecture:** 현재 인증된 `/team/tasks`와 `/team/minutes` API를 유지하고, 프런트에 순수 표시 유틸리티와 상태 기반 렌더러를 추가한다. 백엔드는 수동 수정 표시와 소프트 삭제 컬럼을 추가해 구글시트 가져오기와 OneBoard 입력이 충돌하지 않게 한다.

**Tech Stack:** 정적 HTML/CSS/JavaScript, Vitest + jsdom, Express, PostgreSQL, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-02-team-minutes-interactive-ui.md`

## Global Constraints

- Google 로그인과 기존 역할 경계는 유지한다.
- 사용자 입력은 `textContent`로만 렌더링한다.
- 외부 UI 라이브러리와 유료 서비스를 추가하지 않는다.
- 프런트와 백엔드의 기존 테스트를 수정해 실패를 숨기지 않는다.
- 실제 배포 주소에서 생성·새로고침·수정·삭제를 확인하기 전 완료로 보고하지 않는다.

---

### Task 1: 협업 화면 계약 테스트

**Files:**
- Create: `modules/collaboration.js`
- Create: `test/collaboration.test.js`
- Modify: `test/dom.test.js`
- Modify: `scripts/build-config.js`

**Interfaces:**
- Produces: `formatBoardDate(value)`, `summarizeTasks(tasks)`, `filterTasks(tasks, filters)`, `filterMinutes(minutes, query)`, `splitTextLines(value)`, `monthCalendarDates(year, month)`

- [ ] **Step 1: 순수 함수와 화면 구조의 실패 테스트 작성**

```js
expect(formatBoardDate('2026-09-02T00:00:00.000Z')).toContain('2026. 09. 02.');
expect(summarizeTasks([{ status: '예정' }, { status: '진행' }])).toEqual({ total: 2, planned: 1, progress: 1, done: 0 });
expect(filterTasks(tasks, { query: '광고', status: '진행', assignee: '전체' })).toHaveLength(1);
expect(page.querySelector('#memberTabs')).not.toBeNull();
expect(page.querySelector('#intCalGrid')).not.toBeNull();
expect(page.querySelector('#minutesViewer')).not.toBeNull();
expect(page.querySelector('#minutesModal')).not.toBeNull();
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- --run test/collaboration.test.js test/dom.test.js`

Expected: 새 모듈과 새 DOM 요소가 없어서 실패한다.

- [ ] **Step 3: 최소 순수 함수 구현과 빌드 허용 목록 추가**

```js
export function splitTextLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
```

- [ ] **Step 4: 대상 테스트 통과 확인**

Run: `npm test -- --run test/collaboration.test.js test/dom.test.js`

Expected: 모든 대상 테스트가 통과한다.

### Task 2: 기존형 팀 캘린더와 회의록 UI 복원

**Files:**
- Modify: `index.html`
- Modify: `style.css`
- Modify: `app.js`
- Test: `test/collaboration.test.js`
- Test: `test/dom.test.js`

**Interfaces:**
- Consumes: Task 1의 표시·필터 함수
- Produces: `renderMemberTabs`, `renderIntegratedCalendar`, `renderPriorityTasks`, `renderRecentMinutesPanel`, `renderCollaborationAlerts`, `renderMinutesList`, `renderMinutesDocument`, 업무·회의록 CRUD 이벤트 흐름

- [ ] **Step 1: 담당자 필터·월간 달력·상세 선택 테스트 추가**

```js
expect(filterTasks(tasks, { query: '', status: '전체', assignee: '전체' }).map(({ id }) => id)).toEqual(['new', 'old']);
expect(filterMinutes(minutes, '주간').map(({ id }) => id)).toEqual(['minute-1']);
expect(monthCalendarDates(2026, 8)).toHaveLength(42);
```

- [ ] **Step 2: 새 테스트가 현재 구현에서 실패하는지 확인**

Run: `npm test -- --run test/collaboration.test.js test/dom.test.js`

Expected: 날짜 정렬, 6주 달력, 새 인터랙티브 마크업 계약에서 실패한다.

- [ ] **Step 3: 담당자 탭·3단 통합 달력과 회의록 2단 상세·입력 모달 구현**

```js
async function createMinutes(payload) {
  const data = await apiFetch('/team/minutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return data.minutes;
}
```

- [ ] **Step 4: 키보드 닫기·빈 상태·오류 상태·모바일 CSS 구현**

```css
@media (max-width: 720px) {
  .minutes-layout { grid-template-columns: 1fr; height: auto; }
  .int3-grid { grid-template-columns: 1fr; }
  .calendar-scroll { overflow-x: auto; }
}
```

- [ ] **Step 5: 프런트 대상 테스트와 빌드 확인**

Run: `npm test && npm run build`

Expected: 테스트 실패 0건, 빌드 종료 코드 0.

### Task 3: 수동 수정과 삭제 보존

**Files:**
- Create: `../backend/db/migrations/008_team_manual_overrides.sql`
- Modify: `../backend/routes/team.js`
- Modify: `../backend/integrations/team_sheets.js`
- Modify: `../backend/test/team-sheets-sync.test.js`
- Modify: `../backend/test/operational-security.test.js`
- Modify: `../backend/test/migrations.test.js`

**Interfaces:**
- Produces: `manual_override BOOLEAN`, `deleted_at TIMESTAMPTZ`, 조회 응답의 `source_system`, `manual_override`
- Consumes: 기존 구글시트 source key upsert

- [ ] **Step 1: 동기화가 수동 수정과 소프트 삭제를 존중하는 실패 테스트 작성**

```js
assert.match(taskUpsert.text, /WHERE team_tasks\.manual_override = FALSE/);
assert.match(taskCleanup.text, /manual_override = FALSE/);
assert.match(taskUpdate.text, /manual_override = TRUE/);
assert.match(taskList.text, /deleted_at IS NULL/);
```

- [ ] **Step 2: 백엔드 대상 테스트 실패 확인**

Run: `node --test --test-concurrency=1 test/team-sheets-sync.test.js test/operational-security.test.js test/migrations.test.js`

Expected: 새 컬럼과 쿼리 조건이 없어 실패한다.

- [ ] **Step 3: 마이그레이션과 라우트 저장 규칙 구현**

```sql
ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS manual_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE meeting_minutes ADD COLUMN IF NOT EXISTS manual_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meeting_minutes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
```

- [ ] **Step 4: 시트 upsert와 정리 쿼리에 수동 수정 보호 조건 추가**

```sql
DO UPDATE SET task = EXCLUDED.task, updated_at = NOW()
WHERE team_tasks.manual_override = FALSE;
```

- [ ] **Step 5: 대상 및 전체 백엔드 테스트 확인**

Run: `npm test`

Expected: 테스트 실패 0건.

### Task 4: 배포 및 실제 사용자 흐름 검증

**Files:**
- Create: `.gstack/qa-reports/qa-report-oneboard-kef0-onrender-com-2026-09-02.md`
- Create: `.gstack/qa-reports/screenshots/team-desktop.png`
- Create: `.gstack/qa-reports/screenshots/minutes-desktop.png`
- Create: `.gstack/qa-reports/screenshots/mobile.png`

**Interfaces:**
- Consumes: 배포된 프런트와 백엔드
- Produces: 생성·재조회·수정·삭제 증거와 데스크톱·모바일 스크린샷

- [ ] **Step 1: 프런트·백엔드 전체 테스트와 git diff 확인**

Run: `npm test && npm run build` (frontend), `npm test` (backend)

Expected: 실패 0건이며 의도한 파일만 변경된다.

- [ ] **Step 2: 두 저장소 변경을 원격 main에 푸시**

Run: `git push origin HEAD:main`

Expected: 원격 main이 새 커밋으로 이동한다.

- [ ] **Step 3: Render 배포와 헬스 체크 확인**

Run: `curl -fsS https://oneboard-free-api.onrender.com/health`

Expected: HTTP 200.

- [ ] **Step 4: 실제 로그인 세션에서 업무 흐름 확인**

검증: 담당자 탭, 우선순위 패널, 월간 캘린더, 최근 회의록, 협업 알림, 테스트 업무 생성, 새로고침 후 유지, 수정, 삭제.

- [ ] **Step 5: 실제 로그인 세션에서 회의록 흐름 확인**

검증: 목록·상세 본문, 검색, 테스트 회의록 생성, 새로고침 후 유지, 수정, 삭제.

- [ ] **Step 6: 390px 모바일 화면과 콘솔 오류 확인**

검증: 패널 재배치, 캘린더 내부 스크롤, 주요 버튼 접근 가능, 새 콘솔 오류 0건.
