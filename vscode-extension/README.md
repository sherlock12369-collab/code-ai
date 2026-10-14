# Code AI — VS Code 확장

AI로 코드를 짜는 도구 Code AI의 VS Code 확장입니다. UI는 한국어이며 VS Code 테마(다크/라이트)를 따릅니다.

## 기능

- **채팅** — 활동 표시줄의 Code AI 아이콘에서 AI와 대화합니다. 열린 파일과 작업 공간의 관련 파일을 함께 보내고, AI가 만든 파일을 바로 작업 공간에 적용합니다.
- **실시간 미리보기** — `Code AI: 미리보기 열기`. HTML 페이지, Markdown 문서, 이미지, PDF를 편집기 옆에 보여 주고 파일이 바뀌면 자동으로 새로고침합니다. 화면 크기(모바일/태블릿) 전환도 됩니다.
- **클릭 수정** — 미리보기의 **선택 모드**에서 요소를 클릭하면 CSS 선택자와 HTML이 채팅에 첨부됩니다. "이거 빨간색으로"처럼 요청하세요.
- **변경 기록 / 되돌리기** — AI가 파일을 바꾸기 전 상태를 `.codeai/history/`에 저장합니다. 채팅 하단 목록이나 `Code AI: 변경 기록 보기 / 되돌리기`로 복구합니다.
- **원클릭 배포** — `Code AI: 배포`. 프로젝트 파일(node_modules, .git, .codeai 제외)을 서버로 보내고 공유 링크를 받습니다.
- **템플릿** — `Code AI: 템플릿으로 시작`. 쇼핑몰, 포트폴리오, 랜딩페이지, 보고서 중에서 골라 시작합니다.
- **Claude API 키** — `Code AI: Claude API 키 입력`으로 본인의 키(sk-ant-…)를 입력합니다. 키는 VS Code 보안 저장소에만 저장되고, 요금은 키 주인의 Anthropic 계정에 청구됩니다.
- **빠른 모델 선택** — `Code AI: 모델 선택` 또는 상태 표시줄의 모델 이름을 클릭. Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 중에서 고릅니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `codeai.serverUrl` | `http://localhost:8787` | Code AI 서버 주소 |
| `codeai.model` | `claude-opus-5-5` | Claude 모델: `claude-opus-5-5` 고품질(추천) / `claude-sonnet-5-5` 균형 / `claude-haiku-5-5` 빠름·저렴 |
| `codeai.maxContextFiles` | `20` | 요청에 함께 보낼 파일 최대 개수 |
| `codeai.autoOpenPreview` | `true` | AI가 HTML을 만들면 미리보기 자동 열기 |
| `codeai.previewOnType` | `true` | 저장 전에도 입력하면 미리보기 새로고침 |

## 개발

```bash
npm install
npm run copy-templates   # ../shared/templates → ./templates (없으면 건너뜀)
npm run compile
npx @vscode/vsce package --no-dependencies
```
