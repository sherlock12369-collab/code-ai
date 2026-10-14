// ../server 를 한 파일로 묶은 server.bundle.mjs 를 ./server 로 복사합니다 (확장에 AI 서버 내장).
// 번들이 없으면 먼저 server 폴더에서 빌드합니다.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const serverDir = path.resolve(__dirname, '..', '..', 'server');
const bundle = path.join(serverDir, 'server.bundle.mjs');
const dest = path.resolve(__dirname, '..', 'server');

if (!fs.existsSync(bundle)) {
  console.log('[copy-server] 서버 번들을 만드는 중…');
  execSync('npm ci && npm run build', { cwd: serverDir, stdio: 'inherit', shell: true });
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'updates'), { recursive: true });
fs.copyFileSync(bundle, path.join(dest, 'server.bundle.mjs'));
fs.copyFileSync(path.join(serverDir, 'updates', 'latest.json'), path.join(dest, 'updates', 'latest.json'));
console.log('[copy-server] server.bundle.mjs 복사됨');
