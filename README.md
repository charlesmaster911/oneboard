# oneboard (프론트엔드)

인증된 운영 대시보드 — 워크스페이스 범위의 데이터 조회와 업무 관리

## 구조

```
oneboard/
├── index.html   # 단일 페이지 앱
├── app.js       # 데이터 패치 / 차트 / 테이블 렌더링
├── style.css    # 다크 테마 스타일
└── render.yaml  # Render 정적 배포 설정
```

## 데이터 및 인증 경계

모든 운영 데이터는 인증된 `oneboard-server` API를 통해서만 조회·변경합니다. 액세스 토큰은 현재 브라우저 세션에만 유지되며, 갱신 세션은 HttpOnly 쿠키로 관리됩니다. API가 사용 불가능하면 공개 데이터로 대체하지 않고 빈 상태와 부분 상태를 표시합니다.

## API 서버 연동

운영용 `GOOGLE_CLIENT_ID`와 `ONEBOARD_API_BASE`는 Render 환경변수로 주입합니다. 서버용 비밀값은 정적 사이트 환경에 설정하지 않습니다.

## 로컬 개발

```bash
npm ci
GOOGLE_CLIENT_ID=test-client-id ONEBOARD_API_BASE=http://localhost:4000/api npm run build
npx serve dist
```

## Render 배포

`render.yaml`의 `npm ci && npm run build` 과정은 허용된 앱 파일과 인증용 런타임 설정만 `dist/`에 생성합니다. 저장소의 테스트·매뉴얼·운영 보조 문서는 정적 배포 대상이 아닙니다.
