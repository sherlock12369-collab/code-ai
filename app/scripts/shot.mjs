// 개발용: 실행 중인 앱 화면을 PNG로 저장한다. 사용: node scripts/shot.mjs out.png
import { writeFileSync } from 'node:fs';
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9333}/json`)).json();
const match = process.env.CDP_MATCH; // 예: CDP_MATCH=localhost:5051 → 주소에 이 글이 든 탭
const page = (match && targets.find((t) => t.type === 'page' && t.url.includes(match))) || targets.find((t) => t.type === 'page' && /tauri.localhost|127.0.0.1:14/.test(t.url)) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
const m = await new Promise((r) => ws.addEventListener('message', (e) => { const j = JSON.parse(e.data); if (j.id === 1) r(j); }));
writeFileSync(process.argv[2] || 'shot.png', Buffer.from(m.result.data, 'base64'));
ws.close();
