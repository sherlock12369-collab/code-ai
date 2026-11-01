// Google Gemini API (무료 키 사용 가능). SDK 없이 REST로 호출한다.
// 키는 aistudio.google.com 에서 카드 없이 발급받을 수 있다 (AIza…로 시작).

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
const OFFICIAL_BASE = 'https://generativelanguage.googleapis.com';

export const isGeminiKey = (key) => typeof key === 'string' && /^AIza/.test(key);
export const isGeminiModel = (id) => typeof id === 'string' && /^gemini-[a-z0-9.-]+$/.test(id);

export class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headers(apiKey) {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
}

async function errorFrom(res) {
  let msg = '';
  try {
    const j = await res.json();
    msg = j?.error?.message || '';
  } catch { /* 본문 없음 */ }
  return new GeminiError(res.status, msg || `HTTP ${res.status}`);
}

// 오류 → 사용자에게 보여 줄 한국어 메시지
export function geminiErrorMessage(err) {
  if (!(err instanceof GeminiError)) return 'Gemini API에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
  const m = err.message || '';
  if (/api key not valid|api_key_invalid|invalid api key/i.test(m) || err.status === 401) {
    return 'Gemini API 키가 올바르지 않습니다. 설정에서 키를 다시 확인하세요.';
  }
  if (err.status === 403) return '이 Gemini 키로는 해당 모델을 쓸 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
  if (err.status === 404) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
  if (err.status === 429) {
    return 'Gemini 무료 사용 한도를 넘었습니다. 1분쯤 뒤에 다시 하거나, 오늘 한도를 다 썼다면 내일 다시 해 보세요. (설정에서 "Flash-Lite"를 고르면 더 많이 쓸 수 있어요)';
  }
  if (err.status >= 500) return 'Gemini 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도하세요.';
  return `Gemini API 오류: ${m}`;
}

// 키 확인: 모델 정보 조회만 하므로 무료 한도를 쓰지 않는다.
export async function checkGeminiKey(baseUrl, apiKey, model) {
  const res = await fetch(`${baseUrl || OFFICIAL_BASE}/v1beta/models/${model}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw await errorFrom(res);
}

// Claude 형식 { system, messages } → Gemini 요청 본문
export function geminiBody(system, messages) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: 65536 },
  };
}

// 스트리밍 호출. onText(text)를 조각마다 부르고, 끝나면 { finishReason, blockReason }을 돌려준다.
export async function streamGemini({ baseUrl, apiKey, model, system, messages, signal, onText }) {
  const res = await fetch(`${baseUrl || OFFICIAL_BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(geminiBody(system, messages)),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);

  let finishReason = null;
  let blockReason = null;
  let buf = '';
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error) throw new GeminiError(j.error.code || 500, j.error.message || '');
    if (j.promptFeedback?.blockReason) blockReason = j.promptFeedback.blockReason;
    const c = j.candidates?.[0];
    if (!c) return;
    for (const p of c.content?.parts || []) {
      if (typeof p.text === 'string' && p.text && !p.thought) onText(p.text);
    }
    if (c.finishReason) finishReason = c.finishReason;
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      handleLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) handleLine(buf.trim());
  return { finishReason, blockReason };
}
