// 개발용: 실행 중인 앱(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333)에 붙어 JS를 실행하고 결과를 출력한다.
// 사용: node scripts/smoke.mjs ["자바스크립트 식"]
const port = process.env.CDP_PORT || 9333;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /tauri\.localhost|localhost/.test(t.url)) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0;
const send = (method, params) => new Promise((resolve) => {
  const id = ++n;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); resolve(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
const expr = process.argv[2] || `(async () => ({
  url: location.href,
  ready: !!window.__codeaiReady,
  monaco: !!(window.monaco && window.monaco.editor),
  api: typeof window.codeai === 'object',
  project: document.getElementById('project-name')?.textContent,
  tree: document.querySelectorAll('#file-tree .tree-item').length,
  preview: document.getElementById('preview-frame')?.src,
  status: document.getElementById('server-status')?.textContent.trim(),
  setupOpen: !document.getElementById('modal-setup')?.hidden,
  settings: await window.codeai.settings.get()
}))()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
if (r.result?.exceptionDetails) console.log("EXCEPTION", JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
else console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
ws.close();
