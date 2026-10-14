# Code AI 서버

Code AI 데스크톱 앱, VS Code 확장, 웹사이트가 함께 사용하는 AI 서버입니다.
모델은 **Ollama**로 자체 서버에서 실행하며, 외부 클라우드 API(Google, OpenAI 등)는 전혀 사용하지 않습니다.
API 명세는 상위 폴더의 `SPEC.md`를 따릅니다.

## 1. 준비

1. **Node.js 18 이상** 설치 (권장: 24)
2. **Ollama 설치**: https://ollama.com/download 에서 운영체제에 맞게 설치
3. **모델 받기**:
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
   Ollama가 실행 중인지 확인: `ollama list` 또는 http://localhost:11434 접속

## 2. 실행

```bash
cd server
npm install     # 외부 의존성은 없지만 관례상 실행
npm start
```

`Code AI 서버 v1.0.0 실행 중: http://localhost:8787` 이 보이면 성공입니다.
확인: http://localhost:8787/api/health

테스트 (Ollama 없이 실행 가능):
```bash
npm test
```

## 3. 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소 |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 서버 주소 |
| `MODEL` | `qwen2.5-coder:7b` | 사용할 모델 이름 |
| `PUBLIC_URL` | (요청의 Host 헤더) | 배포 링크에 쓸 외부 주소. 예: `https://ai.example.com` |
| `DATA_DIR` | `server/data` | 배포된 사이트 저장 위치 (`<DATA_DIR>/sites/<id>/`) |

예시 (PowerShell):
```powershell
$env:MODEL = "qwen2.5-coder:14b"; npm start
```
예시 (macOS/Linux):
```bash
MODEL=qwen2.5-coder:14b PORT=9000 npm start
```

## 4. API 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/chat` | SSE 스트리밍. `delta` → `file` → `done` (실패 시 `error`) |
| POST | `/api/deploy` | 파일 저장 후 `{ "url": ".../sites/<id>/" }` 반환 |
| GET | `/api/health` | `{ ok, model, version }` |
| GET | `/updates/latest.json` | 자동 업데이트 정보 (`updates/latest.json` 파일 내용) |
| GET | `/sites/<id>/...` | 배포된 사이트 |
| GET | `/downloads/...` | 설치 파일 (`server/downloads/` 폴더에 넣어 두면 제공) |

- 모든 경로에 CORS(`*`)가 허용되어 있습니다.
- 배포 시 `..`, 절대 경로 등 폴더 밖으로 나가는 경로는 400 오류로 거부됩니다.
- 배포 파일 내용이 `data:<타입>;base64,` 로 시작하면 바이너리(이미지 등)로 디코딩해 저장합니다.

## 5. 새 버전 배포 (자동 업데이트)

1. 새 설치 파일을 `server/downloads/`에 넣습니다. (예: `CodeAI-Setup-1.1.0.exe`, `CodeAI-1.1.0.dmg`)
2. `server/updates/latest.json`의 `version`, `notes`, `downloads`를 수정합니다. 서버 재시작은 필요 없습니다.

## 6. 자체 파인튜닝 모델로 교체하기

서버는 모델 이름만 사용하므로 **`MODEL` 환경 변수만 바꾸면** 다른 모델로 교체됩니다.

1. 파인튜닝한 모델을 GGUF 형식으로 준비합니다. (예: `code-ai-ko.Q4_K_M.gguf`)
2. 같은 폴더에 `Modelfile`을 만듭니다:
   ```
   FROM ./code-ai-ko.Q4_K_M.gguf

   PARAMETER temperature 0.2
   PARAMETER num_ctx 16384
   ```
   LoRA 어댑터만 학습했다면 기반 모델 위에 얹을 수 있습니다:
   ```
   FROM qwen2.5-coder:7b
   ADAPTER ./code-ai-ko-lora.gguf
   ```
3. Ollama에 등록합니다:
   ```bash
   ollama create code-ai-ko -f Modelfile
   ollama run code-ai-ko "안녕하세요"   # 동작 확인
   ```
4. 서버를 새 모델로 실행합니다:
   ```bash
   MODEL=code-ai-ko npm start
   ```

시스템 프롬프트(한국어 답변 + ```` ```file:경로 ```` 형식 출력 규칙)는 `lib/prompt.js`에 있으며 서버가 매 요청마다 보내므로,
Modelfile에 `SYSTEM`을 따로 넣을 필요는 없습니다. 파인튜닝 데이터도 이 출력 형식을 따르도록 만들면 파일 파싱이 안정적입니다.

## 폴더 구조

```
server/
  server.js            HTTP 서버 / 라우팅 / SSE
  lib/prompt.js        한국어 시스템 프롬프트, 컨텍스트 구성
  lib/fileBlocks.js    ```file:경로 블록 파싱
  lib/deploy.js        배포 저장 (경로 탈출 차단)
  lib/paths.js         안전한 상대 경로 검사
  updates/latest.json  자동 업데이트 정보
  downloads/           설치 파일 위치
  data/sites/          배포된 사이트 (자동 생성)
  test.mjs             테스트
```
