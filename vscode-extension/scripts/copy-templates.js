// ../shared/templates 를 ./templates 로 복사합니다. 원본 폴더가 없으면 경고만 출력합니다.
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', '..', 'shared', 'templates');
const dest = path.resolve(__dirname, '..', 'templates');

if (!fs.existsSync(src)) {
  console.warn(`[copy-templates] 템플릿 폴더가 없습니다: ${src} (건너뜀)`);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const names = fs.readdirSync(dest, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
console.log(`[copy-templates] ${names.length}개 템플릿 복사됨: ${names.join(', ')}`);
