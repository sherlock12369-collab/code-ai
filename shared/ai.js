// Code AI — AI 연결 (Gemini 무료 키 / Claude 키)
// 1.x에서는 내장 Node 서버(server/)가 하던 일을 앱 화면 안에서 직접 한다.
// 앱에서는 Tauri http 플러그인의 fetch를, 테스트에서는 Node의 fetch를 넘겨서 쓴다.
(function (root) {
  'use strict';

  const SYSTEM_PROMPT = `당신은 "Code AI"의 코딩 도우미입니다. 사용자가 웹사이트, 문서, 프로그램을 만들고 고치도록 돕습니다.

규칙:
1. 항상 한국어로 친절하고 간결하게 답하세요. (코드, 파일 이름, 기술 용어는 원래대로 써도 됩니다.)
2. 파일을 새로 만들거나 수정할 때는 반드시 파일 "전체 내용"을 아래 형식의 블록으로 출력하세요. 일부만 보여주거나 "... 기존 코드 ..." 처럼 생략하지 마세요.
\`\`\`file:경로/파일이름.확장자
(파일 전체 내용)
\`\`\`
   예: \`\`\`file:index.html
3. 파일 경로는 프로젝트 루트 기준 상대 경로로 쓰세요. (절대 경로나 ".." 금지)
4. 수정하지 않는 파일은 다시 출력하지 마세요.
5. 파일 블록 앞에는 무엇을 왜 바꾸는지 짧게 설명하세요.
6. 사용자가 미리보기에서 요소를 선택해 첨부한 경우, 그 요소를 중심으로 요청을 처리하고 해당 파일 전체를 다시 출력하세요.
7. 웹 페이지는 별도 빌드 없이 브라우저에서 바로 열리는 HTML/CSS/JS로 만드세요.
8. 사용자가 요청한 내용(색상, 개수, 문구 등)을 정확히 지키세요. 요청하지 않은 메뉴, 머리글, 꼬리글 같은 내용을 임의로 덧붙이지 마세요.`;

  // ───────── 모델 ─────────
  const MODELS = [
    { id: 'gemini-3.8-flash', provider: 'gemini', label: '무료 — Gemini 3.8 Flash (추천)', price: '무료', recommended: true },
    { id: 'gemini-3.5-flash-lite', provider: 'gemini', label: '무료·많이 — Gemini 3.5 Flash-Lite', price: '무료' },
    { id: 'claude-opus-5-5', provider: 'claude', label: '고품질 — Claude Opus 5.5 (추천)', price: '$4 / $20', recommended: true },
    { id: 'claude-sonnet-5-5', provider: 'claude', label: '균형 — Claude Sonnet 5.5', price: '$2 / $10' },
    { id: 'claude-haiku-5-5', provider: 'claude', label: '빠름·저렴 — Claude Haiku 5.5', price: '$0.10 / $0.50' }
  ];
  const DEFAULT_MODELS = { gemini: 'gemini-3.8-flash', claude: 'claude-opus-5-5' };
  const GEMINI_BUSY_FALLBACK = 'gemini-3.5-flash-lite';
  const NO_FALLBACK = new Set(['claude-haiku-5-5']); // Claude 서버 측 대체가 없는 모델
  const KEY_CONSOLE_URLS = {
    gemini: 'https://aistudio.google.com/apikey',
    claude: 'https://console.anthropic.com/settings/keys'
  };
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
  const CLAUDE_BASE = 'https://api.anthropic.com';

  const providerOfKey = (key) => (/^sk-ant-/.test(key || '') ? 'claude' : 'gemini');
  const providerOfModel = (id) => (/^gemini-/.test(id || '') ? 'gemini' : 'claude');
  const isModelId = (id) => typeof id === 'string' && /^(claude|gemini)-[a-z0-9.-]+$/.test(id);

  /** 저장된 키로 쓸 모델: 고른 모델이 키와 같은 회사면 그것, 아니면 그 회사 기본 모델 */
  function modelFor(key, chosen) {
    const p = providerOfKey(key);
    return chosen && providerOfModel(chosen) === p ? chosen : DEFAULT_MODELS[p];
  }

  /** 키 모양 검사 (넉넉하게). 문제가 있으면 오류 문장, 없으면 null */
  function keyShapeError(key) {
    if (!key) return 'API 키를 입력해 주세요.';
    const bad = /\s/.test(key) || (/^sk-ant-/.test(key) ? !/^sk-ant-[\w-]{10,}$/.test(key) : !/^[\w.-]{20,}$/.test(key));
    return bad ? 'API 키 형식이 아닙니다. 키 전체(무료 Gemini 키 AQ.… 또는 AIza…, Claude 키 sk-ant-…)를 빈칸 없이 붙여 넣어 주세요.' : null;
  }

  // ───────── 경로 / 파일 블록 ─────────
  function safeRelativePath(input) {
    if (typeof input !== 'string' || !input || input.length > 512 || input.includes('\0')) return null;
    const p = input.trim().replace(/\\/g, '/');
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
    const parts = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') return null;
      if (/[<>:"|?*\x00-\x1f]/.test(seg)) return null;
      parts.push(seg);
    }
    return parts.length ? parts.join('/') : null;
  }

  // 모델 답변에서 ```file:<path> ... ``` 블록을 찾는다. 중첩 펜스를 고려하고, 닫히지 않은 블록과 위험한 경로는 버린다.
  function parseFileBlocks(text) {
    if (typeof text !== 'string' || !text) return [];
    const result = new Map();
    let cur = null;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      if (!cur) {
        const m = /^\s*```+\s*file:\s*(.+?)\s*$/.exec(line);
        if (m) cur = { path: m[1], lines: [], depth: 0 };
        continue;
      }
      const t = line.trim();
      if (/^```+$/.test(t)) {
        if (cur.depth > 0) {
          cur.depth--;
          cur.lines.push(line);
        } else {
          const safe = safeRelativePath(cur.path);
          if (safe) {
            result.delete(safe);
            result.set(safe, cur.lines.join('\n') + (cur.lines.length ? '\n' : ''));
          }
          cur = null;
        }
        continue;
      }
      if (/^```+\S/.test(t)) cur.depth++;
      cur.lines.push(line);
    }
    return [...result].map(([path, content]) => ({ path, content }));
  }

  // ───────── 프롬프트 ─────────
  const MAX_FILE_CHARS = 60000;
  const MAX_TOTAL_CHARS = 200000;

  function buildContext(files, selection) {
    const parts = [];
    if (Array.isArray(files) && files.length) {
      let total = 0;
      const fileParts = [];
      for (const f of files) {
        if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
        let content = f.content;
        if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + '\n...(이하 생략)';
        if (total + content.length > MAX_TOTAL_CHARS) {
          fileParts.push(`(파일이 너무 많아 ${f.path} 이후는 생략되었습니다)`);
          break;
        }
        total += content.length;
        fileParts.push('```file:' + f.path + '\n' + content + (content.endsWith('\n') ? '' : '\n') + '```');
      }
      parts.push('[현재 프로젝트 파일]\n' + fileParts.join('\n\n'));
    }
    if (selection && typeof selection === 'object' && (selection.selector || selection.html)) {
      const lines = ['[사용자가 미리보기에서 선택한 요소]'];
      if (selection.file) lines.push(`파일: ${selection.file}`);
      if (selection.selector) lines.push(`CSS 선택자: ${selection.selector}`);
      if (selection.html) lines.push('HTML:\n```html\n' + String(selection.html).slice(0, 20000) + '\n```');
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  // { system, messages }. user/assistant가 번갈아 나오고 user로 시작·끝나게 정리하고, 컨텍스트는 마지막 질문 앞에 붙인다.
  function buildMessages(messages, files, selection, system = SYSTEM_PROMPT) {
    const history = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
      const last = history[history.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else history.push({ role: m.role, content: m.content });
    }
    while (history.length && history[0].role !== 'user') history.shift();
    while (history.length && history[history.length - 1].role !== 'user') history.pop();
    const context = buildContext(files, selection);
    if (context) {
      if (history.length) {
        const i = history.length - 1;
        history[i] = { role: 'user', content: `${context}\n\n[요청]\n${history[i].content}` };
      } else {
        history.push({ role: 'user', content: context });
      }
    }
    return { system, messages: history };
  }

  // ───────── 오류 ─────────
  class AIError extends Error {
    constructor(provider, status, message) {
      super(message || `HTTP ${status}`);
      this.provider = provider;
      this.status = status;
    }
  }

  async function errorFrom(provider, res) {
    let msg = '';
    try {
      const j = await res.json();
      msg = (j && j.error && (j.error.message || j.error.type)) || '';
    } catch (_) { /* 본문 없음 */ }
    return new AIError(provider, res.status, msg);
  }

  const isBusy = (err) => err instanceof AIError && (err.status >= 500 || err.status === 529);

  function geminiErrorMessage(err) {
    if (!(err instanceof AIError)) return 'Gemini API에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
    const m = err.message || '';
    if (/api key not valid|api_key_invalid|invalid api key/i.test(m) || err.status === 401) return 'Gemini API 키가 올바르지 않습니다. 설정에서 키를 다시 확인하세요.';
    if (err.status === 403) return '이 Gemini 키로는 해당 모델을 쓸 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
    if (err.status === 404) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
    if (err.status === 429) return 'Gemini 무료 사용 한도를 넘었습니다. 1분쯤 뒤에 다시 하거나, 오늘 한도를 다 썼다면 내일 다시 해 보세요. (설정에서 "Flash-Lite"를 고르면 더 많이 쓸 수 있어요)';
    if (err.status >= 500) return 'Gemini 서버가 지금 많이 바쁩니다. 여러 번 다시 해 봤지만 안 됐어요. 잠시 후 다시 시도하세요.';
    return `Gemini API 오류: ${m}`;
  }

  function claudeErrorMessage(err) {
    if (!(err instanceof AIError)) return 'Claude API에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
    const m = err.message || '';
    if (err.status === 401) return 'Claude API 키가 올바르지 않습니다. 설정에서 키를 다시 확인하세요.';
    if (err.status === 403) return '이 API 키로는 해당 모델을 사용할 권한이 없습니다.';
    if (err.status === 404) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
    if (err.status === 429) return '요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
    if (err.status === 400 && /credit balance/i.test(m)) return 'Claude API 크레딧이 부족합니다. console.anthropic.com 에서 결제 정보를 확인하세요.';
    if (err.status === 400) return `요청이 올바르지 않습니다: ${m}`;
    if (err.status >= 500) return 'Claude API 서버가 지금 많이 바쁩니다. 여러 번 다시 해 봤지만 안 됐어요. 잠시 후 다시 시도하세요.';
    return `Claude API 오류: ${m}`;
  }

  const errorMessage = (provider, err) => (provider === 'gemini' ? geminiErrorMessage(err) : claudeErrorMessage(err));

  // ───────── SSE 읽기 ─────────
  // 응답 본문을 줄 단위로 읽어 "data:" 줄마다 onData(json)를 부른다.
  async function readSSE(res, onData) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const line = (l) => {
      if (!l.startsWith('data:')) return;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch (_) { return; }
      onData(j);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        line(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) line(buf.trim());
  }

  // ───────── 메시지 모양 바꾸기 ─────────
  // 공통 모양: { role: 'user'|'assistant', content: '글', images?: [{ mime: 'image/jpeg', data: '<base64>' }] }
  const geminiContents = (messages) => messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      ...(m.images || []).map((img) => ({ inline_data: { mime_type: img.mime, data: img.data } })),
      ...(m.content ? [{ text: m.content }] : [])
    ]
  }));
  const claudeMessages = (messages) => messages.map((m) => (m.images && m.images.length
    ? {
      role: m.role,
      content: [
        ...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
        ...(m.content ? [{ type: 'text', text: m.content }] : [])
      ]
    }
    : { role: m.role, content: m.content }));

  // ───────── Gemini ─────────
  async function streamGeminiOnce({ fetch, key, model, system, messages, signal, onText }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: geminiContents(messages),
      generationConfig: { maxOutputTokens: 65536 }
    };
    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw await errorFrom('gemini', res);
    let finishReason = null;
    let blockReason = null;
    await readSSE(res, (j) => {
      if (j.error) throw new AIError('gemini', j.error.code || 500, j.error.message || '');
      if (j.promptFeedback && j.promptFeedback.blockReason) blockReason = j.promptFeedback.blockReason;
      const c = j.candidates && j.candidates[0];
      if (!c) return;
      for (const p of (c.content && c.content.parts) || []) {
        if (typeof p.text === 'string' && p.text && !p.thought) onText(p.text);
      }
      if (c.finishReason) finishReason = c.finishReason;
    });
    return {
      refused: !!blockReason,
      refusedIfEmpty: /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finishReason || ''),
      maxTokens: finishReason === 'MAX_TOKENS'
    };
  }

  // ───────── Claude ─────────
  async function streamClaudeOnce({ fetch, key, model, system, messages, signal, onText, onRestart }) {
    const body = { model, max_tokens: 64000, system, messages: claudeMessages(messages), stream: true, output_config: { effort: 'high' } };
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    // 안전 분류기가 거절하면 Claude 쪽에서 다른 모델이 이어서 답한다.
    if (!NO_FALLBACK.has(model)) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    const res = await fetch(`${CLAUDE_BASE}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw await errorFrom('claude', res);
    let stopReason = null;
    await readSSE(res, (ev) => {
      if (ev.type === 'error') throw new AIError('claude', ev.error && ev.error.type === 'overloaded_error' ? 529 : 500, ev.error && ev.error.message);
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'fallback') onRestart();
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
      if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
    });
    return { refused: stopReason === 'refusal', refusedIfEmpty: false, maxTokens: stopReason === 'max_tokens' };
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });

  /**
   * 채팅 한 번. 답변 텍스트를 onText로 흘려 보내고, 끝나면 { text, files, maxTokens }를 돌려준다.
   * 서버가 바쁘면(5xx) 답이 나오기 전까지 1·2·4초 뒤 다시 해 보고, Gemini는 그래도 안 되면 Flash-Lite로 바꾼다.
   * 실패하면 { error, needsKey? }를 돌려준다. (예외를 던지지 않는다. 취소만 AbortError)
   */
  async function chat({ fetch, key, model, messages, files, selection, signal, onText, onNotice, retryDelays, firstTextTimeout, system }) {
    const built = buildMessages(messages, files, selection, system);
    if (!built.messages.length) return { error: '메시지가 비어 있습니다.' };
    const r = await stream({ fetch, key, model, system: built.system, messages: built.messages, signal, onText, onNotice, retryDelays, firstTextTimeout });
    return r.error ? r : { ...r, files: parseFileBlocks(r.text) };
  }

  const BUSY_SKIP_MS = 10 * 60 * 1000;
  // 대신할 모델이 있을 때, 이 시간 안에 첫 글자가 안 오면 바쁜 것으로 보고 바꾼다.
  // (바쁜 Gemini Flash는 503을 주기까지 20초 넘게 붙잡고 있기도 한다)
  const FIRST_TEXT_TIMEOUT_MS = 10 * 1000;
  // 모델 id → 이 시각까지 건너뜀. 새로고침·재시작해도 남도록 localStorage에도 적는다.
  const BUSY_STORE = 'seulai.busyUntil';
  const busyUntil = new Map();
  try {
    const saved = JSON.parse(root.localStorage.getItem(BUSY_STORE) || '{}');
    for (const [k, v] of Object.entries(saved)) if (v > Date.now()) busyUntil.set(k, v);
  } catch (_) { /* 저장소 없음 (테스트 등) */ }
  function markBusy(m) {
    busyUntil.set(m, Date.now() + BUSY_SKIP_MS);
    try { root.localStorage.setItem(BUSY_STORE, JSON.stringify(Object.fromEntries(busyUntil))); } catch (_) { /* 무시 */ }
  }

  // 다시 시도 + Flash-Lite 전환을 포함한 스트리밍 한 번. Code AI와 SEUL Chat이 함께 쓴다.
  async function stream({ fetch, key, model, system, messages, signal, onText, onNotice, retryDelays = [1000, 2000, 4000], firstTextTimeout = FIRST_TEXT_TIMEOUT_MS }) {
    const provider = providerOfKey(key);
    model = modelFor(key, model);
    const built = { system, messages };
    let full = '';
    const emit = (t) => { full += t; onText && onText(t); };
    const restart = () => {
      full = '';
      onNotice && onNotice('\n\n(다른 Claude 모델로 이어서 답합니다)\n\n');
    };
    const once = provider === 'gemini' ? streamGeminiOnce : streamClaudeOnce;

    // Gemini: 고른 모델이 바쁘면(5xx) 다시 시도하지 않고 바로 Flash-Lite로 바꾼다. (바쁠 때 한 번에 ~4초씩 걸려서)
    // 한 번 바빴던 모델은 BUSY_SKIP_MS 동안 건너뛴다. 마지막 모델(또는 Claude)만 retryDelays대로 다시 시도한다.
    const models = [model];
    if (provider === 'gemini' && model !== GEMINI_BUSY_FALLBACK) {
      models.push(GEMINI_BUSY_FALLBACK);
      if ((busyUntil.get(model) || 0) > Date.now()) models.shift();
    }
    const BUSY_NOTICE = '(Gemini가 바빠서 Flash-Lite로 답합니다)\n\n';
    // 이미 바쁜 걸 알고 처음부터 Flash-Lite로 갈 때는 매번 알리지 않는다 (처음 바꿀 때만 알림).

    let lastErr = null;
    for (let mi = 0; mi < models.length; mi++) {
      const m = models[mi];
      const isLast = mi === models.length - 1;
      if (mi > 0) onNotice && onNotice(BUSY_NOTICE);
      const delays = isLast ? retryDelays : [];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        // 대신할 모델이 남아 있으면 첫 글자를 기다리는 시간에 제한을 둔다.
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        if (signal) {
          if (signal.aborted) ctrl.abort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        let timedOut = false;
        let timer = isLast ? null : setTimeout(() => { timedOut = true; ctrl.abort(); }, firstTextTimeout);
        const emitOnce = (t) => {
          if (timer) { clearTimeout(timer); timer = null; }
          emit(t);
        };
        try {
          const r = await once({ fetch, key, model: m, system: built.system, messages: built.messages, signal: ctrl.signal, onText: emitOnce, onRestart: restart });
          if (r.refused || (r.refusedIfEmpty && !full)) {
            const who = provider === 'gemini' ? 'Gemini' : 'Claude';
            return { error: `${who}가 이 요청에는 답할 수 없다고 했습니다. 요청을 바꿔서 다시 시도해 보세요.` };
          }
          if (!full.trim()) return { error: '답을 받지 못했어요. "다시 답하기"를 눌러 보세요.', empty: true };
          return { text: full, maxTokens: r.maxTokens, model: m };
        } catch (err) {
          if (err && err.name === 'AbortError' && !timedOut) throw err;
          if (timedOut) err = new AIError(provider, 504, '첫 응답이 너무 늦음');
          lastErr = err;
          // 답이 이미 나오기 시작했거나, 바쁜 게 아닌 오류면 다시 하지 않는다.
          if (full || !isBusy(err)) {
            const message = errorMessage(provider, err);
            return { error: full ? '응답을 받는 중 연결이 끊어졌습니다: ' + message : message, needsKey: err instanceof AIError && err.status === 401 };
          }
          if (!isLast) {
            markBusy(m);
            break;
          }
          if (attempt < delays.length) await sleep(delays[attempt], signal);
        } finally {
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }
    }
    return { error: errorMessage(provider, lastErr) };
  }

  // ───────── SEUL Chat ─────────
  const SEUL_BASE = `당신은 SEUL AI의 대화 친구 "슬"입니다. 귀여운 파란 로봇 캐릭터예요.
- 사용자가 쓴 언어로 답하세요. 한국어로 물으면 한국어로 답합니다.
- 짧고 읽기 쉽게 답하세요. 필요할 때만 목록이나 표를 쓰세요. (Markdown 사용 가능)
- 모르는 것은 모른다고 말하고, 지어내지 마세요.
- 사진이 첨부되면 사진을 보고 답하세요.
- 사용자가 웹사이트, 게임, 앱처럼 "만들기"를 원하면, 화면 아래의 "Code AI로 만들기" 버튼으로 실제로 만들 수 있다고 알려 주세요.`;

  const PERSONAS = [
    { id: 'friend', name: '친구', emoji: '😊', desc: '편하게 반말로 수다 떠는 친구',
      prompt: '성격: 다정하고 장난기 있는 친구. 반말로 편하게 말하고, 공감을 잘 해 줍니다. 이모지는 가끔만 씁니다.' },
    { id: 'teacher', name: '선생님', emoji: '📚', desc: '차근차근 쉽게 설명해 주는 선생님',
      prompt: '성격: 친절한 선생님. 존댓말을 쓰고, 어려운 내용은 쉬운 예시를 들어 단계별로 설명합니다. 마지막에 이해했는지 확인하는 짧은 질문을 하나 할 수 있습니다.' },
    { id: 'english', name: '영어 회화', emoji: '🗣️', desc: '영어로 대화하며 틀린 곳을 고쳐 주는 선생님',
      prompt: '역할: 영어 회화 선생님. 기본적으로 쉬운 영어로 대화를 이어 갑니다. 사용자의 영어에 틀린 곳이 있으면 답변 끝에 "✏️ 고친 문장:" 으로 자연스러운 표현을 알려 주고, 짧게 한국어로 이유를 설명합니다. 사용자가 한국어로 쓰면 그 말을 영어로 어떻게 하는지 알려 주고 영어로 대화를 이어 갑니다.' },
    { id: 'assistant', name: '똑똑한 비서', emoji: '🗂️', desc: '핵심만 정리해 주는 비서',
      prompt: '성격: 유능한 비서. 존댓말을 쓰고, 결론부터 말한 다음 필요한 만큼만 근거를 덧붙입니다. 할 일이나 계획은 목록으로 정리합니다.' }
  ];
  const personaOf = (id) => PERSONAS.find((p) => p.id === id) || PERSONAS[0];

  /** SEUL Chat 대화 한 번. messages는 [{ role, content, images? }]. 결과: { text } 또는 { error } */
  async function talk({ fetch, key, model, persona, messages, signal, onText, onNotice, retryDelays, firstTextTimeout }) {
    const history = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (m.content || (m.images && m.images.length)));
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') return { error: '메시지가 비어 있습니다.' };
    const system = `${SEUL_BASE}\n${personaOf(persona).prompt}`;
    return stream({ fetch, key, model, system, messages: history, signal, onText, onNotice, retryDelays, firstTextTimeout });
  }

  /** 첫 질문으로 대화 제목 만들기 (AI를 부르지 않고 앞부분을 자른다) */
  function titleFrom(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t ? (t.length > 28 ? t.slice(0, 28) + '…' : t) : '사진 대화';
  }

  /** 키 확인 — 모델 정보 조회만 해서 요금·무료 한도를 쓰지 않는다. */
  async function checkKey({ fetch, key }) {
    const shape = keyShapeError(key);
    if (shape) return { ok: false, error: shape };
    const provider = providerOfKey(key);
    try {
      const res = provider === 'gemini'
        ? await fetch(`${GEMINI_BASE}/v1beta/models/${DEFAULT_MODELS.gemini}`, { headers: { 'x-goog-api-key': key } })
        : await fetch(`${CLAUDE_BASE}/v1/models/${DEFAULT_MODELS.claude}`, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
        });
      if (!res.ok) throw await errorFrom(provider, res);
      return { ok: true, provider };
    } catch (err) {
      return { ok: false, error: errorMessage(provider, err) };
    }
  }

  const api = {
    SYSTEM_PROMPT, MODELS, DEFAULT_MODELS, KEY_CONSOLE_URLS,
    providerOfKey, providerOfModel, isModelId, modelFor, keyShapeError,
    safeRelativePath, parseFileBlocks, buildContext, buildMessages,
    AIError, chat, stream, checkKey,
    PERSONAS, personaOf, talk, titleFrom,
    _resetBusy: () => busyUntil.clear()
  };
  root.CodeAIEngine = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
