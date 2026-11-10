// 빌드 전에 Monaco 편집기 파일을 ui/vendor/monaco 로 복사한다. (이미 있으면 건너뛴다)
import { cpSync, existsSync } from 'node:fs';
const src = new URL('../node_modules/monaco-editor/min/vs', import.meta.url);
const dest = new URL('../ui/vendor/monaco/vs', import.meta.url);
if (!existsSync(new URL('loader.js', dest + '/'))) {
  if (!existsSync(src)) throw new Error('monaco-editor가 없습니다. app 폴더에서 npm install 을 먼저 실행하세요.');
  cpSync(src, dest, { recursive: true });
  console.log('Monaco 복사 완료');
}
