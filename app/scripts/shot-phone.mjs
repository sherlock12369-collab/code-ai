// 개발용: 폰 세로 크기(390x844)로 흉내 내서 화면을 PNG로 저장한다. 사용: CDP_PORT=9334 node scripts/shot-phone.mjs out.png ["실행할 JS"]
import { writeFileSync } from 'node:fs';
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9333}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0;
const send = (method, params) => new Promise((resolve) => {
  const id = ++n;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); resolve(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
if (process.argv[3]) await send('Runtime.evaluate', { expression: process.argv[3], awaitPromise: true });
await new Promise((r) => setTimeout(r, 500));
const m = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(process.argv[2] || 'phone.png', Buffer.from(m.result.data, 'base64'));
await send('Emulation.clearDeviceMetricsOverride', {});
ws.close();
