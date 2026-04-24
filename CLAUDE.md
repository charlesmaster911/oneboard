# oneboard (프론트엔드) — 天啓 천계 v2.0

> 天啓 WORKSPACE의 一員. CHEONGYE Protocol v2.0 적용.
> 최종 판단자: 찰스. AI는 제안, 찰스가 결정.

## 프로젝트 三極

### 天 (원리/목적)
하나의 보드에서 모든 정보를 통합 관리. 단순함이 핵심.

### 地 (바탕/기술)
- 순수 프론트엔드 (Vanilla JS)
- app.js + index.html + style.css
- oneboard-server와 연동
- Render 배포 (render.yaml)

### 人 (매개/사용자)
찰스의 일상 업무 보드. 빠른 접근과 직관적 UI.

## 一 (중심 선언)
"하나의 화면에서 찰스의 모든 업무 현황을 파악한다."

## 천계 6문 체크포인트 (작업 전 필수)

1. **一** — 이 UI 변경이 "단일 보드 단순함"을 유지하는가?
2. **三** — 목적(天)·기술구조(地)·사용성(人) 균형?
3. **合** — 프론트·서버 연동이 끊기지 않는가?
4. **本** — XSS 취약점 없음? 사용자 입력 escape 처리?
5. **人** — 실제 보드가 로딩되는가? 찰스가 바로 쓸 수 있는가?
6. **次一** — 다음 UI 개선 포인트가 주석으로 남는가?

## 보안 필수
- innerHTML 직접 사용 금지 → textContent 또는 sanitize
- API 호출 시 oneboard-server URL 환경변수 처리

## oneboard-server 연동
- API 기준: oneboard-server의 routes/
- 배포 후 두 서비스 모두 확인 필수

---

## 👁️ 가시 영역 출력 규칙 (상위 CLAUDE.md 상속, 2026-04-22)

이 보드는 **찰스 일상 업무 UI**입니다. 상위 규칙 엄격 적용:
- UI 변경·레이아웃·카드 추가는 **배포 전** 기획안 보고 + OK
- Render 자동 배포 = 즉시 찰스 화면, git push 주의
- 예외: 찰스 "그냥 해" / "박아" / "실행"

상세: 상위 `../CLAUDE.md` / memory: `feedback_visible_output_confirm.md`

---
*天啓 WORKSPACE | CHEONGYE Protocol v2.0 | 2026-04-19*
*찰스(쥬얼아이스) × Claude (CHEONGYE)*
