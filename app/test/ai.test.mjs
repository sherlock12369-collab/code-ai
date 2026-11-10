// shared/ai.js 테스트: Gemini가 바쁠 때 Flash-Lite 전환·다시 시도, 파일 블록, 오류 메시지, SEUL Chat 사진·성격
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../../shared/ai.js');
const E = globalThis.CodeAIEngine;
const KEY = 'AQ.' + 'x'.repeat(30);

const sse = (objs) => new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join(''), { status: 200 });
const geminiText = (t, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text: t }] }, finishReason }] });
const busy = () => new Response(JSON.stringify({ error: { message: 'The model is overloaded.' } }), { status: 503 });

function mockFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('예상보다 많이 호출됨');
    return r();
  };
  return { fetch, calls };
}

const base = { key: KEY, messages: [{ role: 'user', content: '만들어 줘' }], retryDelays: [1, 1, 1] };

test('바로 성공하면 파일을 돌려준다', async () => {
  const { fetch, calls } = mockFetch([() => sse([geminiText('좋아요\n```file:index.html\n<h1>hi</h1>\n```\n')])]);
  let streamed = '';
  const r = await E.chat({ ...base, fetch, onText: (t) => { streamed += t; } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.8-flash:streamGenerateContent/);
  assert.deepEqual(r.files, [{ path: 'index.html', content: '<h1>hi</h1>\n' }]);
  assert.match(streamed, /좋아요/);
});

test.beforeEach(() => E._resetBusy());

test('Flash가 바쁘면(503) 다시 시도하지 않고 바로 Flash-Lite로 바꾸고 알린다', async () => {
  const { fetch, calls } = mockFetch([busy, () => sse([geminiText('라이트')])]);
  const notices = [];
  const r = await E.chat({ ...base, fetch, onNotice: (t) => notices.push(t) });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /gemini-3\.8-flash/);
  assert.match(calls[1].url, /gemini-3\.5-flash-lite/);
  assert.equal(r.model, 'gemini-3.5-flash-lite');
  assert.match(notices.join(''), /Flash-Lite/);
});

test('한 번 바빴으면 다음 질문은 처음부터 Flash-Lite로 (기다리지 않고, 다시 알리지도 않음)', async () => {
  const first = mockFetch([busy, () => sse([geminiText('1')])]);
  await E.chat({ ...base, fetch: first.fetch });
  const second = mockFetch([() => sse([geminiText('2')])]);
  const notices = [];
  const r = await E.chat({ ...base, fetch: second.fetch, onNotice: (t) => notices.push(t) });
  assert.equal(second.calls.length, 1);
  assert.match(second.calls[0].url, /gemini-3\.5-flash-lite/);
  assert.equal(r.text, '2');
  assert.equal(notices.length, 0); // 매번 알리지 않는다
});

test('Flash-Lite를 고른 경우 바쁘면 다시 시도해서 성공한다', async () => {
  const { fetch, calls } = mockFetch([busy, busy, () => sse([geminiText('됐어요')])]);
  const r = await E.chat({ ...base, model: 'gemini-3.5-flash-lite', fetch });
  assert.equal(calls.length, 3);
  assert.equal(r.text, '됐어요');
});

test('둘 다 계속 바쁘면 알기 쉬운 오류', async () => {
  const { fetch, calls } = mockFetch(Array(8).fill(busy));
  const r = await E.chat({ ...base, fetch });
  assert.equal(calls.length, 1 + 4); // Flash 1번 + Flash-Lite 4번(처음 + 다시 시도 3번)
  assert.match(r.error, /바쁩니다/);
});

test('Claude가 과부하(529)면 다시 시도한다', async () => {
  const overloaded = () => new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
  const ok = () => sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '안녕' } }]);
  const { fetch, calls } = mockFetch([overloaded, ok]);
  const r = await E.chat({ ...base, key: 'sk-ant-' + 'a'.repeat(20), fetch });
  assert.equal(calls.length, 2);
  assert.equal(r.text, '안녕');
});

test('키가 틀리면 다시 시도하지 않는다', async () => {
  const { fetch, calls } = mockFetch([() => new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 })]);
  const r = await E.chat({ ...base, fetch });
  assert.equal(calls.length, 1);
  assert.match(r.error, /키가 올바르지 않습니다/);
});

test('한도 초과(429)는 다시 시도하지 않는다', async () => {
  const { fetch, calls } = mockFetch([() => new Response('{}', { status: 429 })]);
  const r = await E.chat({ ...base, fetch });
  assert.equal(calls.length, 1);
  assert.match(r.error, /무료 사용 한도/);
});

test('Claude 키는 Claude API로, 대체 모델 안내를 처리한다', async () => {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '앞' } },
    { type: 'content_block_start', content_block: { type: 'fallback' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '뒤' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
  ];
  const { fetch, calls } = mockFetch([() => sse(events)]);
  const r = await E.chat({ ...base, key: 'sk-ant-' + 'a'.repeat(20), fetch });
  assert.match(calls[0].url, /api\.anthropic\.com\/v1\/messages/);
  assert.equal(JSON.parse(calls[0].init.body).model, 'claude-opus-5-5');
  assert.equal(r.text, '뒤');
});

test('위험한 경로의 파일 블록은 버린다', () => {
  assert.deepEqual(E.parseFileBlocks('```file:../x.txt\na\n```\n```file:C:/y\nb\n```'), []);
});

test('SEUL Chat: 사진을 Gemini 형식으로 보내고 성격을 시스템 프롬프트에 넣는다', async () => {
  const { fetch, calls } = mockFetch([() => sse([geminiText('귀여운 고양이네!')])]);
  const r = await E.talk({
    fetch, key: KEY, persona: 'english', retryDelays: [1],
    messages: [{ role: 'user', content: '이거 뭐야?', images: [{ mime: 'image/jpeg', data: 'QUJD' }] }]
  });
  assert.equal(r.text, '귀여운 고양이네!');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'image/jpeg', data: 'QUJD' } });
  assert.match(body.systemInstruction.parts[0].text, /영어 회화 선생님/);
});

test('SEUL Chat: 사진을 Claude 형식으로 보낸다', async () => {
  const { fetch, calls } = mockFetch([() => sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }])]);
  await E.talk({ fetch, key: 'sk-ant-' + 'a'.repeat(20), messages: [{ role: 'user', content: '봐줘', images: [{ mime: 'image/png', data: 'QQ==' }] }] });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[1].text, '봐줘');
});

test('SEUL Chat: 마지막이 사용자 말이 아니면 보내지 않는다', async () => {
  const r = await E.talk({ fetch: async () => { throw new Error('부르면 안 됨'); }, key: KEY, messages: [{ role: 'assistant', content: 'hi' }] });
  assert.match(r.error, /비어/);
});
