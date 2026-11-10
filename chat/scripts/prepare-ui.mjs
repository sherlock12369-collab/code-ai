// 빌드 전에 화면(ui/)에 필요한 파일을 채운다. (git에는 올리지 않는 복사본)
// - AI 연결 코드: ../shared/ai.js (Code AI와 함께 쓴다)
// - Markdown 그리기(marked) + 안전하게 거르기(DOMPurify)
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const here = (p) => new URL(`../${p}`, import.meta.url);
const need = (p) => { if (!existsSync(here(p))) throw new Error(`${p}가 없습니다. chat 폴더에서 npm install 을 먼저 실행하세요.`); return here(p); };
mkdirSync(here('ui/vendor'), { recursive: true });
cpSync(here('../shared/ai.js'), here('ui/ai.js'));
cpSync(need('node_modules/marked/lib/marked.umd.js'), here('ui/vendor/marked.umd.js'));
cpSync(need('node_modules/dompurify/dist/purify.min.js'), here('ui/vendor/purify.min.js'));
