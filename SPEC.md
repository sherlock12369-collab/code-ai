# Code AI — 제품 명세 (v1.0.0)

AI로 코드를 짜는 도구. Antigravity / Claude Code와 비슷한 방식.
UI 언어: 한국어. 모든 파트는 다크/라이트(흑/백) 테마 전환 지원.

## 폴더 구조

```
code_ai/
  website/           다운로드 사이트 (정적 HTML/CSS/JS)
  desktop/           독립 데스크톱 앱 (Electron) — Windows / macOS
  vscode-extension/  VS Code 확장 버전
  server/            AI 서버 (Node.js) — 외부 API(Google, OpenAI 등) 사용 금지
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

2.0 예정(이번엔 구현하지 않음): 오프라인 모드(사용자 PC에서 모델 실행).

## AI 서버 API (모든 클라이언트 공통 계약)

기본 주소: `http://localhost:8787` (클라이언트 설정에서 변경 가능)

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

외부 API 금지. 오픈소스 코드 모델(기본: `qwen2.5-coder:7b`)을 자체 서버에서 Ollama로 실행.
서버는 `OLLAMA_URL`(기본 `http://localhost:11434`)과 `MODEL` 환경변수 사용.
추후 파인튜닝한 자체 모델로 교체 가능하도록 모델 이름만 바꾸면 되게 한다.

## 디자인

- 다크/라이트 전환 토글, 기본은 시스템 설정 따름, 선택은 저장.
- 흑백 기조의 깔끔한 디자인, 강조색 하나 (`#7c5cff`).
- 다운로드 사이트, 앱, 확장 모두 같은 톤.

## 버전

- 1.0.0으로 출시. 자동 업데이트로 1.1 배포. 2.0은 나중에.
