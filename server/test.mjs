// Ollama 없이 실행 가능한 테스트: node test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFileBlocks } from './lib/fileBlocks.js';
import { safeRelativePath } from './lib/paths.js';
import { deploySite, DeployError } from './lib/deploy.js';
import { buildMessages } from './lib/prompt.js';
import { createApp, getConfig } from './server.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

console.log('파일 블록 파싱');

await test('단일 파일 블록', () => {
  const text = '설명입니다.\n```file:index.html\n<h1>안녕</h1>\n```\n끝.';
  assert.deepEqual(parseFileBlocks(text), [{ path: 'index.html', content: '<h1>안녕</h1>\n' }]);
});

await test('여러 파일 + 하위 폴더 + CRLF', () => {
  const text = '```file:index.html\r\n<p>a</p>\r\n```\r\n그리고\r\n```file:css/style.css\r\nbody{}\r\n```';
  assert.deepEqual(parseFileBlocks(text), [
    { path: 'index.html', content: '<p>a</p>\n' },
    { path: 'css/style.css', content: 'body{}\n' },
  ]);
});

await test('일반 코드 블록은 파일로 취급하지 않음', () => {
  assert.deepEqual(parseFileBlocks('```js\nconsole.log(1)\n```'), []);
});

await test('Markdown 파일 안의 중첩 코드 펜스', () => {
  const md = '# 제목\n\n```js\nlet a = 1;\n```\n\n끝';
  const text = '```file:README.md\n' + md + '\n```\n';
  assert.deepEqual(parseFileBlocks(text), [{ path: 'README.md', content: md + '\n' }]);
});

await test('같은 경로가 반복되면 마지막 내용 사용', () => {
  const text = '```file:a.txt\n1\n```\n```file:a.txt\n2\n```';
  assert.deepEqual(parseFileBlocks(text), [{ path: 'a.txt', content: '2\n' }]);
});

await test('닫히지 않은 블록은 무시', () => {
  assert.deepEqual(parseFileBlocks('```file:a.txt\n잘린 내용'), []);
});

await test('위험한 경로의 파일 블록은 무시', () => {
  const text = '```file:../evil.js\nx\n```\n```file:/etc/passwd\nx\n```\n```file:./ok.js\ny\n```';
  assert.deepEqual(parseFileBlocks(text), [{ path: 'ok.js', content: 'y\n' }]);
});

await test('빈 파일', () => {
  assert.deepEqual(parseFileBlocks('```file:empty.txt\n```'), [{ path: 'empty.txt', content: '' }]);
});

console.log('경로 검사');

await test('safeRelativePath', () => {
  assert.equal(safeRelativePath('index.html'), 'index.html');
  assert.equal(safeRelativePath('./a/b.css'), 'a/b.css');
  assert.equal(safeRelativePath('a\\b.js'), 'a/b.js');
  for (const bad of ['../x', 'a/../../x', '/abs', 'C:\\win', 'C:/win', '\\\\server\\share', '..\\x', 'a\0b', '', '.', 'a/..', 5, null]) {
    assert.equal(safeRelativePath(bad), null, `거부되어야 함: ${JSON.stringify(bad)}`);
  }
});

console.log('배포');

const tmp = await mkdtemp(path.join(tmpdir(), 'codeai-test-'));
const sitesDir = path.join(tmp, 'sites');

await test('정상 배포', async () => {
  const id = await deploySite(sitesDir, {
    name: 'My Site!',
    files: [
      { path: 'index.html', content: '<h1>hi</h1>' },
      { path: 'css/style.css', content: 'body{}' },
    ],
  });
  assert.match(id, /^my-site-[0-9a-f]{8}$/);
  assert.equal(await readFile(path.join(sitesDir, id, 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.equal(await readFile(path.join(sitesDir, id, 'css', 'style.css'), 'utf8'), 'body{}');
});

await test('한글 이름은 site-<id>', async () => {
  const id = await deploySite(sitesDir, { name: '내 사이트', files: [{ path: 'a.txt', content: 'a' }] });
  assert.match(id, /^site-[0-9a-f]{8}$/);
});

for (const bad of ['../escape.html', '..\\escape.html', 'a/../../escape.html', '/etc/passwd', 'C:\\Windows\\x.txt']) {
  await test(`경로 탈출 거부: ${bad}`, async () => {
    const before = (await readdir(sitesDir)).length;
    await assert.rejects(
      deploySite(sitesDir, { name: 'x', files: [{ path: 'ok.html', content: 'ok' }, { path: bad, content: 'pwned' }] }),
      (err) => err instanceof DeployError && err.status === 400,
    );
    // 실패한 배포는 남지 않아야 하고, 상위 폴더에 파일이 생기면 안 됨
    assert.equal((await readdir(sitesDir)).length, before);
    await assert.rejects(readFile(path.join(tmp, 'escape.html')));
    await assert.rejects(readFile(path.join(sitesDir, 'escape.html')));
  });
}

await test('파일 없음 / 잘못된 내용 거부', async () => {
  await assert.rejects(deploySite(sitesDir, { files: [] }), DeployError);
  await assert.rejects(deploySite(sitesDir, {}), DeployError);
  await assert.rejects(deploySite(sitesDir, { files: [{ path: 'a.txt', content: 1 }] }), DeployError);
});

console.log('프롬프트');

await test('컨텍스트가 마지막 사용자 메시지에 포함됨', () => {
  const msgs = buildMessages(
    [
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '답' },
      { role: 'user', content: '이거 빨간색으로' },
      { role: 'system', content: '무시되어야 함' },
    ],
    [{ path: 'index.html', content: '<h1>x</h1>' }],
    { selector: 'body > h1', html: '<h1>x</h1>', file: 'index.html' },
  );
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /한국어/);
  assert.match(msgs[0].content, /```file:/);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content, '첫 질문');
  assert.match(msgs[3].content, /```file:index\.html\n<h1>x<\/h1>/);
  assert.match(msgs[3].content, /body > h1/);
  assert.match(msgs[3].content, /이거 빨간색으로$/);
});

console.log('HTTP (Ollama 없음)');

const cfg = { ...getConfig({}), port: 0, dataDir: tmp, ollamaUrl: 'http://127.0.0.1:1' };
const server = createApp(cfg);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await test('GET /api/health', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { ok: true, model: 'qwen2.5-coder:7b', version: '1.0.0' });
});

await test('POST /api/deploy → /sites/<id>/ 서비스', async () => {
  const r = await fetch(`${base}/api/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', files: [{ path: 'index.html', content: '<h1>배포</h1>' }] }),
  });
  assert.equal(r.status, 200);
  const { url } = await r.json();
  assert.match(url, /\/sites\/demo-[0-9a-f]{8}\/$/);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(await page.text(), '<h1>배포</h1>');
});

await test('POST /api/deploy 경로 탈출 → 400', async () => {
  const r = await fetch(`${base}/api/deploy`, {
    method: 'POST',
    body: JSON.stringify({ name: 'x', files: [{ path: '../../x.html', content: 'x' }] }),
  });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

await test('GET /updates/latest.json', async () => {
  const j = await (await fetch(`${base}/updates/latest.json`)).json();
  assert.equal(j.version, '1.0.0');
  assert.ok(j.notes && j.downloads.win.endsWith('CodeAI-Setup-1.0.0.exe') && j.downloads.mac.endsWith('CodeAI-1.0.0.dmg'));
});

await test('OPTIONS 프리플라이트 (CORS)', async () => {
  const r = await fetch(`${base}/api/chat`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

await test('POST /api/chat, Ollama 꺼짐 → 한국어 error 이벤트', async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: '안녕' }] }),
  });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  const events = text.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
  assert.deepEqual(events, [{ type: 'error', message: 'AI 모델 서버에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.' }]);
});

await test('POST /api/chat, 가짜 Ollama → delta, file, done', async () => {
  // Ollama 스트리밍 응답(NDJSON)을 흉내 내는 가짜 서버
  const http = await import('node:http');
  let received;
  const fake = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    received = JSON.parse(b);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const pieces = ['수정했습니다.\n```file:', 'index.html\n<h1 style="color:red">', '안녕</h1>\n```\n'];
    for (const p of pieces) res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const s2 = createApp({ ...cfg, ollamaUrl: `http://127.0.0.1:${fake.address().port}`, model: 'test-model' });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: '빨간색으로' }], files: [{ path: 'index.html', content: '<h1>안녕</h1>' }] }),
    });
    const events = (await r.text()).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
    assert.equal(received.model, 'test-model');
    assert.equal(received.stream, true);
    assert.equal(received.messages[0].role, 'system');
    assert.deepEqual(events.filter((e) => e.type === 'delta').length, 3);
    assert.deepEqual(events.slice(-2), [
      { type: 'file', path: 'index.html', content: '<h1 style="color:red">안녕</h1>\n' },
      { type: 'done' },
    ]);
  } finally {
    s2.closeAllConnections();
    s2.close();
    fake.closeAllConnections();
    fake.close();
  }
});

server.closeAllConnections();
server.close();
await rm(tmp, { recursive: true, force: true });

console.log(`\n${passed}개 통과, ${failed}개 실패`);
process.exitCode = failed ? 1 : 0;
