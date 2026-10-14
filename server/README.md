# Code AI 서버

Code AI 데스크톱 앱, VS Code 확장, 웹사이트가 함께 사용하는 AI 서버입니다.
AI는 **Claude API만** 사용합니다 (공식 SDK `@anthropic-ai/sdk`). 다른 AI 제공자나 로컬 모델은 쓰지 않습니다.
API 명세는 상위 폴더의 `SPEC.md`를 따릅니다.

## API 키 (사용자 본인 키)

서버에는 API 키를 두지 않습니다. 각 사용자가 자기 Claude API 키를 앱/확장에 입력하고,
클라이언트가 요청마다 `x-api-key` 헤더(또는 `Authorization: Bearer <키>`)로 보냅니다.
서버는 키를 저장하거나 로그에 남기지 않고 그 요청에만 사용합니다. 요금은 키 주인의 Anthropic 계정에 청구됩니다.

키 발급: https://console.anthropic.com/settings/keys

> 서버를 인터넷에 공개해 다른 사람이 쓰게 한다면, 키가 네트워크를 지나가므로 반드시 HTTPS(리버스 프록시 등) 뒤에 두세요.
> 데스크톱 앱의 내장 서버는 `127.0.0.1`에만 열리므로 키가 PC 밖으로 나가는 곳은 Anthropic API뿐입니다.

## 1. 준비

**Node.js 18 이상** 설치 (권장: 24)

## 2. 실행

```bash
cd server
npm install
npm start
```

`Code AI 서버 v1.1.1 실행 중: http://localhost:8787` 이 보이면 성공입니다.
확인: http://localhost:8787/api/health

테스트 (인터넷/API 키 없이 가짜 Claude API로 실행):
```bash
npm test
```

## 3. 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `MODEL` | `claude-opus-5-5` | 기본 모델 (`claude-`로 시작해야 하며, 아니면 무시) |
| `CLAUDE_API_BASE_URL` | (Anthropic 공식 주소) | 테스트/프록시용 API 주소 |
| `PUBLIC_URL` | (요청의 Host 헤더) | 배포 링크에 쓸 외부 주소. 예: `https://ai.example.com` |
| `DATA_DIR` | `server/data` | 배포된 사이트 저장 위치 (`<DATA_DIR>/sites/<id>/`) |
| `UPDATES_FILE` | `server/updates/latest.json` | 업데이트 정보 파일 위치 |
| `DOWNLOADS_DIR` | `server/downloads` | `/downloads/` 로 제공할 폴더 |

`PORT=0` 이면 빈 포트를 자동으로 고릅니다.

## 4. API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/chat` | SSE 스트리밍. `delta` → `file` → `done` (실패 시 `error`). **키 필요**. 선택 항목 `"model"` |
| POST | `/api/check-key` | 키 확인 (모델 정보만 조회, 요금 없음). `{ ok: true, model }` / `{ ok: false, error }` (잘못된 키는 401) |
| GET | `/api/models` | 선택 가능한 Claude 모델 |
| POST | `/api/deploy` | 파일 저장 후 `{ "url": ".../sites/<id>/" }` 반환 |
| GET | `/api/health` | `{ ok, model, version }` |
| GET | `/updates/latest.json` | 자동 업데이트 정보 (`updates/latest.json` 파일 내용) |
| GET | `/sites/<id>/...` | 배포된 사이트 |
| GET | `/downloads/...` | 설치 파일 (`server/downloads/` 폴더에 넣어 두면 제공) |

- 모든 경로에 CORS(`*`)가 허용되어 있습니다 (`X-Api-Key` 헤더 포함).
- 배포 시 `..`, 절대 경로 등 폴더 밖으로 나가는 경로는 400 오류로 거부됩니다.
- 배포 파일 내용이 `data:<타입>;base64,` 로 시작하면 바이너리(이미지 등)로 디코딩해 저장합니다.

### 채팅 동작

- Messages API를 스트리밍으로 호출합니다: `max_tokens` 64000, `output_config.effort: "high"`, 시스템 프롬프트는 `lib/prompt.js`.
- Opus/Sonnet은 안전 분류기가 거절하면 서버 측 대체(`fallbacks: "default"`, 베타 `server-side-fallback-2026-07-01`)로
  다른 Claude 모델이 이어서 답합니다. Haiku에는 이 기능이 없어 거절 시 `error` 이벤트를 보냅니다.
- 키 오류(401), 권한(403), 한도 초과(429), 크레딧 부족, 연결 실패는 한국어 `error` 이벤트로 바뀝니다.

### 모델 선택

`/api/chat` 요청 본문에 `"model"`을 넣으면 그 모델로 답합니다. 없으면(`null`, `""` 포함) `MODEL` 기본값을 씁니다.
허용되는 값은 아래 3개와 `MODEL` 환경 변수 값뿐이며, 그 밖의 값은 SSE를 시작하기 전에
`400 { "error": "지원하지 않는 모델입니다: ..." }` 으로 거부됩니다.

| id | label | 요금 (100만 토큰당 입력 / 출력) |
|---|---|---|
| `claude-opus-5-5` | 고품질 — Claude Opus 5.5 (추천) | $4 / $20 |
| `claude-sonnet-5-5` | 균형 — Claude Sonnet 5.5 | $2 / $10 |
| `claude-haiku-5-5` | 빠름·저렴 — Claude Haiku 5.5 | $0.10 / $0.50 |

### 다른 프로그램에 내장하기 (데스크톱 앱)

```js
import { startServer, createApp } from './server/server.js';

const { server, port, url } = await startServer({
  port: 0,                 // 0 = 빈 포트 자동 선택
  host: '127.0.0.1',
  dataDir: '<쓰기 가능한 폴더>',
  // model, apiBaseUrl, publicUrl, updatesFile, downloadsDir 도 지정 가능
});
// 종료: server.close()
```

`server/node_modules`(Anthropic SDK)가 함께 있어야 합니다. 데스크톱 앱 빌드는 이 폴더를 설치 파일에 포함합니다.

## 5. 새 버전 배포 (자동 업데이트)

1. 새 설치 파일을 `server/downloads/`에 넣습니다. (예: `CodeAI-Setup-1.1.1.exe`, `CodeAI-1.1.1.dmg`)
2. `server/updates/latest.json`의 `version`, `notes`, `downloads`를 수정합니다. 서버 재시작은 필요 없습니다.

## 폴더 구조

```
server/
  server.js            HTTP 서버 / 라우팅 / SSE / Claude API 호출
  lib/prompt.js        한국어 시스템 프롬프트, 컨텍스트 구성
  lib/fileBlocks.js    ```file:경로 블록 파싱
  lib/deploy.js        배포 저장 (경로 탈출 차단)
  lib/paths.js         안전한 상대 경로 검사
  updates/latest.json  자동 업데이트 정보
  downloads/           설치 파일 위치
  data/sites/          배포된 사이트 (자동 생성)
  test.mjs             테스트
```
