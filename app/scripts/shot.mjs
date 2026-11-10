// 개발용: 실행 중인 앱 화면을 PNG로 저장한다. 사용: node scripts/shot.mjs out.png
import { writeFileSync } from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t) => t.type === 'page' && !/^http:\/\/127\.0\.0\.1:(?!1430)/.test(t.url)) || targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
const m = await new Promise((r) => ws.addEventListener('message', (e) => { const j = JSON.parse(e.data); if (j.id === 1) r(j); }));
writeFileSync(process.argv[2] || 'shot.png', Buffer.from(m.result.data, 'base64'));
ws.close();
