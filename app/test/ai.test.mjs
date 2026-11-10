// ai.js 테스트: Gemini가 바쁠 때 다시 시도·Flash-Lite 전환, 파일 블록, 오류 메시지
import test from 'node:test';
import assert from 'node:assert/strict';
await import('../ui/ai.js');
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

test('503이면 다시 시도해서 성공한다', async () => {
  const { fetch, calls } = mockFetch([busy, busy, () => sse([geminiText('됐어요')])]);
  const r = await E.chat({ ...base, fetch });
  assert.equal(calls.length, 3);
  assert.equal(r.text, '됐어요');
  assert.equal(r.model, 'gemini-3.8-flash');
});

test('계속 바쁘면 Flash-Lite로 바꾸고 알린다', async () => {
  const { fetch, calls } = mockFetch([busy, busy, busy, busy, () => sse([geminiText('라이트')])]);
  const notices = [];
  const r = await E.chat({ ...base, fetch, onNotice: (t) => notices.push(t) });
  assert.equal(calls.length, 5);
  assert.match(calls[4].url, /gemini-3\.5-flash-lite/);
  assert.equal(r.model, 'gemini-3.5-flash-lite');
  assert.match(notices.join(''), /Flash-Lite/);
});

test('둘 다 계속 바쁘면 알기 쉬운 오류', async () => {
  const { fetch } = mockFetch(Array(8).fill(busy));
  const r = await E.chat({ ...base, fetch });
  assert.match(r.error, /바쁩니다/);
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
