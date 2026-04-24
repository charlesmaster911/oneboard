# oneboard (프론트엔드)

쥬얼아이스 마케팅 대시보드 — 이커머스 통합 데이터 시각화

## 구조

```
oneboard/
├── index.html   # 단일 페이지 앱
├── app.js       # 데이터 패치 / 차트 / 테이블 렌더링
├── style.css    # 다크 테마 스타일
└── render.yaml  # Render 정적 배포 설정
```

## 데이터 소스 우선순위

1. **oneboard-server API** (JWT 토큰 있을 때) — 실제 플랫폼 데이터
2. **Google Sheets CSV** (공개 시트) — 수동 업데이트 데이터
3. **Mock 데이터** (fallback) — 오프라인/개발 환경

## API 서버 연동

`app.js` 상단의 `API_BASE` 를 배포 환경에 맞게 설정:

```js
// index.html에서 window.API_BASE 오버라이드 가능
const API_BASE = window.API_BASE || 'https://oneboard-server.onrender.com/api';
```

로그인 후 `localStorage.setItem('oneboard_token', JWT_TOKEN)` 으로 토큰 저장 시 자동 연동.

## 로컬 개발

```bash
# Live Server (VS Code 확장) 또는
npx serve .
# http://localhost:3000 에서 확인
```

## Render 배포

render.yaml 기반 정적 사이트로 자동 배포됨.
별도 빌드 없이 파일 그대로 서빙.
