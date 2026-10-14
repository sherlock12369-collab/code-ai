// 인터넷/API 키 없이 실행 가능한 테스트 (가짜 Claude API 사용): node test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFileBlocks } from './lib/fileBlocks.js';
import { safeRelativePath } from './lib/paths.js';
import { deploySite, DeployError } from './lib/deploy.js';
import { buildMessages } from './lib/prompt.js';
import { createApp, getConfig, startServer, resolveConfig, allowedModels } from './server.js';

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

await test('컨텍스트가 마지막 사용자 메시지에 포함되고 system은 따로', () => {
  const { system, messages: msgs } = buildMessages(
    [
      { role: 'user', content: '첫 질문' },
      { role: 'assistant', content: '답' },
      { role: 'user', content: '이거 빨간색으로' },
      { role: 'system', content: '무시되어야 함' },
    ],
    [{ path: 'index.html', content: '<h1>x</h1>' }],
    { selector: 'body > h1', html: '<h1>x</h1>', file: 'index.html' },
  );
  assert.match(system, /한국어/);
  assert.match(system, /```file:/);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, '첫 질문');
  assert.match(msgs[2].content, /```file:index\.html\n<h1>x<\/h1>/);
  assert.match(msgs[2].content, /body > h1/);
  assert.match(msgs[2].content, /이거 빨간색으로$/);
});

await test('Claude 형식: user로 시작/끝, 같은 역할은 합침', () => {
  const { messages: msgs } = buildMessages([
    { role: 'assistant', content: '인사' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'user', content: '' },
  ]);
  assert.deepEqual(msgs, [{ role: 'user', content: 'a\n\nb' }]);
});

console.log('HTTP');

const sse = async (r) => (await r.text()).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));

// 가짜 Claude API: /v1/messages (SSE 스트리밍)와 /v1/models/<id>를 흉내 낸다.
async function fakeClaude({ texts = ['네'], stopReason = 'end_turn', status = 200, errorType } = {}) {
  const http = await import('node:http');
  const state = { requests: [] };
  const srv = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    state.requests.push({ url: req.url, headers: req.headers, body: b ? JSON.parse(b) : null });
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: errorType || 'api_error', message: 'fake error' } }));
    }
    if (req.url.startsWith('/v1/models/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'model', id: req.url.split('?')[0].split('/').pop(), display_name: 'x', created_at: '2026-01-01T00:00:00Z' }));
    }
    const model = state.requests.at(-1).body.model;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', {
      message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 } },
    });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const t of texts) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${srv.address().port}`;
  state.close = () => {
    srv.closeAllConnections();
    srv.close();
  };
  return state;
}

async function withApp(opts, fn) {
  const s = createApp({ ...getConfig({}), port: 0, dataDir: tmp, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${s.address().port}`);
  } finally {
    s.closeAllConnections();
    s.close();
  }
}

const KEY = 'sk-ant-test-key';
const chat = (base, body, key = KEY) =>
  fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: key ? { 'x-api-key': key } : {},
    body: JSON.stringify(body),
  });

const cfg = { ...getConfig({}), port: 0, dataDir: tmp, apiBaseUrl: 'http://127.0.0.1:1' };
const server = createApp(cfg);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

await test('GET /api/health', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { ok: true, model: 'claude-opus-5-5', version: '1.1.0' });
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
  assert.equal(j.version, '1.1.0');
  assert.match(j.notes, /Claude/);
  assert.match(j.notes, /API 키/);
  assert.equal(j.downloads.win, 'https://github.com/sherlock12369-collab/code-ai/releases/latest/download/CodeAI-Setup-1.1.0.exe');
  assert.equal(j.downloads.mac, 'https://github.com/sherlock12369-collab/code-ai/releases/latest/download/CodeAI-1.1.0.dmg');
});

await test('OPTIONS 프리플라이트 (CORS, x-api-key 허용)', async () => {
  const r = await fetch(`${base}/api/chat`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers'), /X-Api-Key/i);
});

await test('POST /api/chat, API 키 없음 → 401 JSON', async () => {
  const r = await chat(base, { messages: [{ role: 'user', content: '안녕' }] }, null);
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /API 키/);
});

await test('POST /api/chat, Claude API 연결 불가 → 한국어 error 이벤트', async () => {
  const r = await chat(base, { messages: [{ role: 'user', content: '안녕' }] });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = await sse(r);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /연결할 수 없습니다/);
});

await test('POST /api/chat, 가짜 Claude → delta, file, done + 요청 형식', async () => {
  const fake = await fakeClaude({ texts: ['수정했습니다.\n```file:', 'index.html\n<h1 style="color:red">', '안녕</h1>\n```\n'] });
  try {
    await withApp({ apiBaseUrl: fake.url }, async (u) => {
      const r = await chat(u, { messages: [{ role: 'user', content: '빨간색으로' }], files: [{ path: 'index.html', content: '<h1>안녕</h1>' }] });
      const events = await sse(r);
      const req = fake.requests.at(-1);
      assert.equal(req.url.split('?')[0], '/v1/messages');
      assert.equal(req.headers['x-api-key'], KEY);
      assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
      assert.equal(req.body.model, 'claude-opus-5-5');
      assert.equal(req.body.stream, true);
      assert.equal(req.body.fallbacks, 'default');
      assert.match(req.body.system, /한국어/);
      assert.equal(req.body.messages[0].role, 'user');
      assert.equal(events.filter((e) => e.type === 'delta').length, 3);
      assert.deepEqual(events.slice(-2), [
        { type: 'file', path: 'index.html', content: '<h1 style="color:red">안녕</h1>\n' },
        { type: 'done' },
      ]);
    });
  } finally {
    fake.close();
  }
});

await test('POST /api/chat, Authorization: Bearer 키도 허용', async () => {
  const fake = await fakeClaude();
  try {
    await withApp({ apiBaseUrl: fake.url }, async (u) => {
      const r = await fetch(`${u}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'a' }] }),
      });
      assert.deepEqual((await sse(r)).at(-1), { type: 'done' });
      assert.equal(fake.requests.at(-1).headers['x-api-key'], KEY);
    });
  } finally {
    fake.close();
  }
});

await test('POST /api/chat, 잘못된 키(401) → 한국어 error', async () => {
  const fake = await fakeClaude({ status: 401, errorType: 'authentication_error' });
  try {
    await withApp({ apiBaseUrl: fake.url }, async (u) => {
      const events = await sse(await chat(u, { messages: [{ role: 'user', content: 'a' }] }));
      assert.equal(events.length, 1);
      assert.match(events[0].message, /키가 올바르지 않습니다/);
    });
  } finally {
    fake.close();
  }
});

await test('POST /api/chat, 거절(refusal) → error, 파일 저장 안 함', async () => {
  const fake = await fakeClaude({ texts: ['```file:a.txt\nx\n```\n'], stopReason: 'refusal' });
  try {
    await withApp({ apiBaseUrl: fake.url }, async (u) => {
      const events = await sse(await chat(u, { messages: [{ role: 'user', content: 'a' }] }));
      assert.equal(events.at(-1).type, 'error');
      assert.ok(!events.some((e) => e.type === 'file'));
    });
  } finally {
    fake.close();
  }
});

console.log('모델 선택');

await test('allowedModels: Claude 3개 + MODEL 값', () => {
  assert.deepEqual(allowedModels({ model: 'claude-opus-5-5' }), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(allowedModels({ model: 'claude-opus-5' }).slice(-1), ['claude-opus-5']);
});

await test('MODEL 환경 변수가 Claude 모델이 아니면 무시', () => {
  assert.equal(getConfig({ MODEL: 'qwen2.5-coder:7b' }).model, 'claude-opus-5-5');
  assert.equal(getConfig({ MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
  assert.equal(resolveConfig({ model: 'gpt-4' }, {}).model, 'claude-opus-5-5');
});

await test('POST /api/chat 허용되지 않은 모델 → 400 JSON (SSE 시작 전)', async () => {
  for (const model of ['qwen2.5-coder:7b', 'gpt-4o', 123, ['claude-opus-5-5']]) {
    const r = await chat(base, { model, messages: [{ role: 'user', content: '안녕' }] });
    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.match((await r.json()).error, /지원하지 않는 모델/);
  }
});

await test('POST /api/chat model 지정/생략, Haiku는 fallbacks 없음', async () => {
  const fake = await fakeClaude();
  try {
    await withApp({ apiBaseUrl: fake.url, model: 'claude-sonnet-5-5' }, async (u) => {
      for (const [sent, expected] of [
        ['claude-haiku-5-5', 'claude-haiku-5-5'],
        ['claude-opus-5-5', 'claude-opus-5-5'],
        [undefined, 'claude-sonnet-5-5'],
        [null, 'claude-sonnet-5-5'],
        ['', 'claude-sonnet-5-5'],
      ]) {
        const r = await chat(u, { model: sent, messages: [{ role: 'user', content: 'a' }] });
        assert.equal(r.status, 200);
        assert.deepEqual((await sse(r)).at(-1), { type: 'done' });
        const body = fake.requests.at(-1).body;
        assert.equal(body.model, expected, `보낸 값: ${sent}`);
        assert.equal(body.fallbacks, expected === 'claude-haiku-5-5' ? undefined : 'default');
      }
    });
  } finally {
    fake.close();
  }
});

await test('GET /api/models', async () => {
  const j = await (await fetch(`${base}/api/models`)).json();
  assert.equal(j.provider, 'claude');
  assert.equal(j.default, 'claude-opus-5-5');
  assert.deepEqual(j.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.ok(j.models.every((m) => m.label && m.price));
});

console.log('API 키 확인');

await test('POST /api/check-key: 키 없음 401 / 올바름 ok / 틀림 401', async () => {
  let r = await fetch(`${base}/api/check-key`, { method: 'POST' });
  assert.equal(r.status, 401);
  const good = await fakeClaude();
  try {
    await withApp({ apiBaseUrl: good.url }, async (u) => {
      r = await fetch(`${u}/api/check-key`, { method: 'POST', headers: { 'x-api-key': KEY } });
      assert.deepEqual(await r.json(), { ok: true, model: 'claude-opus-5-5' });
      assert.equal(good.requests.at(-1).url.split('?')[0], '/v1/models/claude-opus-5-5');
    });
  } finally {
    good.close();
  }
  const bad = await fakeClaude({ status: 401, errorType: 'authentication_error' });
  try {
    await withApp({ apiBaseUrl: bad.url }, async (u) => {
      r = await fetch(`${u}/api/check-key`, { method: 'POST', headers: { 'x-api-key': 'sk-ant-wrong' } });
      assert.equal(r.status, 401);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.match(j.error, /올바르지 않습니다/);
    });
  } finally {
    bad.close();
  }
});

console.log('내장 실행 (데스크톱 앱용)');

await test('createApp에 일부 옵션만 넘겨도 동작', async () => {
  const s5 = createApp({ dataDir: tmp });
  await new Promise((r) => s5.listen(0, '127.0.0.1', r));
  try {
    const j = await (await fetch(`http://127.0.0.1:${s5.address().port}/api/health`)).json();
    assert.equal(j.ok, true);
    assert.equal(j.version, '1.1.0');
  } finally {
    s5.closeAllConnections();
    s5.close();
  }
});

await test('resolveConfig: 옵션이 환경 변수보다 우선, undefined 무시', () => {
  const c = resolveConfig({ port: 0, model: undefined, dataDir: tmp }, { PORT: '9999', MODEL: 'claude-haiku-5-5', DATA_DIR: '/nope' });
  assert.equal(c.port, 0);
  assert.equal(c.model, 'claude-haiku-5-5');
  assert.equal(c.dataDir, path.resolve(tmp));
  assert.equal(getConfig({ PORT: '0' }).port, 0);
  assert.equal(getConfig({}).port, 8787);
});

await test('startServer({ port: 0, dataDir }) → 빈 포트로 실행, 배포는 dataDir에 저장', async () => {
  const dataDir = path.join(tmp, 'embedded');
  const { server: s6, port, url, config } = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  try {
    assert.ok(port > 0);
    assert.equal(config.port, port);
    assert.equal(url, `http://127.0.0.1:${port}`);
    const r = await fetch(`${url}/api/deploy`, {
      method: 'POST',
      body: JSON.stringify({ name: 'emb', files: [{ path: 'index.html', content: 'x' }] }),
    });
    assert.equal(r.status, 200);
    const sites = await readdir(path.join(dataDir, 'sites'));
    assert.equal(sites.length, 1);
    assert.match(sites[0], /^emb-/);
  } finally {
    s6.closeAllConnections();
    s6.close();
  }
});

await test('startServer 포트 충돌 → reject (EADDRINUSE)', async () => {
  const used = server.address().port;
  await assert.rejects(startServer({ port: used, host: '127.0.0.1', dataDir: tmp }), (e) => e.code === 'EADDRINUSE');
});

server.closeAllConnections();
server.close();
await rm(tmp, { recursive: true, force: true });

console.log(`\n${passed}개 통과, ${failed}개 실패`);
process.exitCode = failed ? 1 : 0;
