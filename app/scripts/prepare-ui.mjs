// 빌드 전에 화면(ui/)에 필요한 파일을 채운다. (git에는 올리지 않는 복사본)
// - Monaco 편집기: node_modules → ui/vendor/monaco
// - AI 연결 코드: ../shared/ai.js → ui/ai.js (SEUL Chat과 함께 쓴다)
import { cpSync, existsSync } from 'node:fs';
const here = (p) => new URL(`../${p}`, import.meta.url);

if (!existsSync(here('ui/vendor/monaco/vs/loader.js'))) {
  if (!existsSync(here('node_modules/monaco-editor/min/vs'))) throw new Error('monaco-editor가 없습니다. app 폴더에서 npm install 을 먼저 실행하세요.');
  cpSync(here('node_modules/monaco-editor/min/vs'), here('ui/vendor/monaco/vs'), { recursive: true });
  console.log('Monaco 복사 완료');
}
cpSync(here('../shared/ai.js'), here('ui/ai.js'));
