# Code AI — 제품 명세 (v1.0.0)

AI로 코드를 짜는 도구. Antigravity / Claude Code와 비슷한 방식.
UI 언어: 한국어. 모든 파트는 다크/라이트(흑/백) 테마 전환 지원.

## 폴더 구조

```
code_ai/
  website/           다운로드 사이트 (정적 HTML/CSS/JS)
  desktop/           독립 데스크톱 앱 (Electron) — Windows / macOS
  vscode-extension/  VS Code 확장 버전
  server/            AI 서버 (Node.js) — Claude API만 사용 (사용자 본인의 API 키)
  shared/templates/  템플릿 (데스크톱 앱과 확장이 함께 사용)
```

## 1.0 기능

1. **실시간 미리보기 패널 (핵심 기능)**: 사용자가 만드는 결과물을 편집기 옆에 실시간 표시.
   - HTML 사이트 → 실제 페이지 렌더링
   - Markdown 문서 → 렌더링된 문서
   - 이미지(png/jpg/svg/gif), PDF → 그대로 표시
   - 파일이 바뀌면 자동 새로고침
2. **원클릭 배포**: 버튼 하나로 프로젝트를 배포하고 공유 링크 받기 (AI 서버의 `/api/deploy` 사용).
3. **변경 기록 / 되돌리기**: AI가 파일을 수정할 때마다 스냅샷 저장, 목록에서 이전 버전으로 복구.
4. **미리보기 클릭 수정**: 미리보기에서 요소를 클릭 → 선택된 요소(CSS 선택자 + outerHTML)를 채팅에 첨부 → "이거 빨간색으로" 같은 요청으로 AI가 수정.
5. **템플릿**: 쇼핑몰, 포트폴리오, 랜딩페이지, 보고서(문서) 등에서 골라 시작.
6. **한국어 최적화**: 시스템 프롬프트와 UI 모두 한국어.

2.0 예정(이번엔 구현하지 않음): 폰 버전(PWA).

## AI 서버 API (모든 클라이언트 공통 계약)

기본 주소: `http://localhost:8787` (클라이언트 설정에서 변경 가능)

인증: `/api/chat`, `/api/check-key` 요청에는 사용자의 Claude API 키를 `x-api-key` 헤더(또는 `Authorization: Bearer`)로 보낸다. 서버는 키를 저장하거나 기록하지 않고, 그 요청에만 사용한다. 키가 없으면 `401 { "error": "..." }`.

### `POST /api/chat`  — 스트리밍 (Server-Sent Events)
요청:
```json
{
  "messages": [{ "role": "user" | "assistant", "content": "..." }],
  "files": [{ "path": "index.html", "content": "..." }],
  "selection": { "selector": "body > h1", "html": "<h1>..</h1>", "file": "index.html" }
}
```
`files`, `selection`은 선택 항목.
응답 이벤트 (`data: <json>\n\n`):
- `{ "type": "delta", "text": "..." }` — 답변 텍스트 조각
- `{ "type": "file", "path": "index.html", "content": "..." }` — 파일 전체 내용으로 생성/수정 (답변 완료 후 파싱해서 전송)
- `{ "type": "done" }`
- `{ "type": "error", "message": "..." }`

모델은 파일을 아래 형식으로 출력하도록 시스템 프롬프트에서 지시하고, 서버가 파싱해서 `file` 이벤트로 보낸다:
````
```file:index.html
...전체 내용...
```
````

### `POST /api/deploy`
요청: `{ "name": "my-site", "files": [{ "path", "content" }] }`
응답: `{ "url": "http://localhost:8787/sites/<id>/" }` — 서버가 파일을 저장하고 정적으로 서비스.

### `GET /api/health`
응답: `{ "ok": true, "model": "<모델 이름>", "version": "1.0.0" }`

### `GET /updates/latest.json` — 자동 업데이트 확인
응답: `{ "version": "1.0.0", "notes": "...", "downloads": { "win": "<url>", "mac": "<url>" } }`
데스크톱 앱은 시작 시 이것을 확인하고, 현재 버전보다 높으면 "새 버전(1.1) 업데이트" 알림을 띄운다.

## 모델

AI는 **Claude API만** 사용한다 (다른 AI 제공자·로컬 모델 사용 안 함). 서버는 공식 Anthropic SDK(`@anthropic-ai/sdk`)로 Messages API를 스트리밍 호출한다.
- 서버에는 API 키를 두지 않는다. 사용자가 앱(설정/설정 도우미) 또는 VS Code 확장(`Code AI: Claude API 키 입력`)에서 본인의 키를 입력하고, 요금은 키 주인의 Anthropic 계정에 청구된다.
- 데스크톱 앱은 키를 Electron `safeStorage`로 암호화해 사용자 데이터 폴더에 저장하고, 렌더러에는 끝 4자리만 보여 준다. VS Code 확장은 SecretStorage에 저장한다.
- 기본 모델 `claude-opus-5-5` (`MODEL` 환경 변수로 변경 가능, `claude-`로 시작해야 함). effort `high`, `max_tokens` 64000.
- Opus/Sonnet은 안전 분류기 거절 시 서버 측 대체(`fallbacks: "default"`, 베타 `server-side-fallback-2026-07-01`)로 다른 Claude 모델이 이어서 답한다. Haiku는 대체 없음.

## 디자인

- 다크/라이트 전환 토글, 기본은 시스템 설정 따름, 선택은 저장.
- 흑백 기조의 깔끔한 디자인, 강조색 하나 (`#7c5cff`).
- 다운로드 사이트, 앱, 확장 모두 같은 톤.

## 버전

- 1.0.0으로 출시. 자동 업데이트로 1.1 배포. 2.0은 나중에.

## 1.1 기능 (v1.1.0)

1. **Claude API로 전환 (사용자 본인 키)**: Ollama/로컬 모델을 없애고 Claude API만 쓴다. 별도 프로그램 설치나 모델 다운로드가 필요 없다.
   - AI 서버(`server/`)는 앱에 내장되어 앱이 직접 실행한다 (기본 서버 주소는 내장 서버).
   - `POST /api/check-key`: 헤더의 키로 모델 정보를 조회해(요금 없음) 키가 맞는지 확인. `{ "ok": true, "model" }` 또는 `{ "ok": false, "error" }` (잘못된 키는 401).
2. **처음 실행 설정 도우미 (데스크톱 앱)**: 내장 서버 시작 → API 키 입력·확인 → 모델 선택.
3. **모델 선택**: `/api/chat` 요청에 선택 항목 `"model"`을 추가한다 (없으면 서버 기본값).
   - `claude-opus-5-5` — 고품질 (추천, 기본값)
   - `claude-sonnet-5-5` — 균형
   - `claude-haiku-5-5` — 빠름·저렴
   서버는 이 3개(및 `MODEL` 환경변수 값)만 허용한다. `GET /api/models`는 `{ "models": [{ "id", "label", "price" }], "default", "provider": "claude" }`를 돌려준다.
4. **진짜 자동 업데이트**: Windows는 electron-updater + GitHub Releases(`sherlock12369-collab/code-ai`)로 앱 안에서 받고 재시작 시 설치. macOS는 서명이 없어 자동 설치가 불가능하므로 새 버전 알림 + 다운로드 링크.

2.0 예정: 폰 버전(PWA, 채팅 + 미리보기 + 배포 중심, 인터넷에서 접속 가능한 AI 서버 필요).
