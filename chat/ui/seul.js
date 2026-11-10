// SEUL Chat — ChatGPT처럼 평소에 대화하는 앱 (Code AI와 따로 된 앱)
// 대화는 Rust(chats.rs)가 <앱 데이터>/chats 에 저장하고, AI 호출은 ai.js의 talk()를 쓴다.
(function () {
  'use strict';
  const T = window.__TAURI__;
  const AI = window.CodeAIEngine;
  const copyText = (t) => T.clipboardManager.writeText(String(t));
  const openUrl = (u) => T.opener.openUrl(String(u));
  const invoke = T.core.invoke;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MAX_IMAGES = 4;
  const MAX_SIDE = 1600; // 사진을 이 크기 안으로 줄여서 보낸다 (무료 한도·저장 공간 절약)
  const HISTORY_LIMIT = 40; // AI에게 보내는 최근 메시지 수

  // ───────── 로봇 (A 동글이) ─────────
  function robot({ size = 34, wave = false, thinking = false } = {}) {
    return `<svg class="robot${thinking ? ' thinking' : ''}" viewBox="0 0 200 200" width="${size}" height="${size}" aria-hidden="true">
      <line x1="100" y1="40" x2="100" y2="20" stroke="var(--seul-dark)" stroke-width="6" stroke-linecap="round"/>
      <circle class="antenna" cx="100" cy="16" r="11" fill="var(--seul-spark)"/>
      <rect x="28" y="40" width="144" height="122" rx="58" fill="var(--seul)"/>
      ${wave ? '<g class="wave"><rect x="166" y="78" width="18" height="36" rx="9" fill="var(--seul-dark)"/><circle cx="175" cy="72" r="11" fill="var(--seul-dark)"/></g>' : '<rect x="164" y="84" width="18" height="34" rx="9" fill="var(--seul-dark)"/>'}
      <rect x="18" y="84" width="18" height="34" rx="9" fill="var(--seul-dark)"/>
      <rect x="46" y="60" width="108" height="80" rx="38" fill="var(--seul-face)"/>
      <ellipse class="blink" cx="78" cy="96" rx="10" ry="13" fill="var(--seul-eye)"/>
      <ellipse class="blink" cx="122" cy="96" rx="10" ry="13" fill="var(--seul-eye)"/>
      <circle cx="81" cy="91" r="3.5" fill="#fff"/><circle cx="125" cy="91" r="3.5" fill="#fff"/>
      <ellipse cx="62" cy="117" rx="9" ry="5.5" fill="var(--seul-blush)"/>
      <ellipse cx="138" cy="117" rx="9" ry="5.5" fill="var(--seul-blush)"/>
      <path d="M89 118 Q100 129 111 118" fill="none" stroke="var(--seul-eye)" stroke-width="5" stroke-linecap="round"/>
    </svg>`;
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
  };

  const SUGGESTIONS = {
    friend: ['오늘 기분이 별로야, 얘기 좀 들어줄래?', '주말에 뭐 하고 놀지 추천해 줘', '재밌는 퀴즈 하나 내 줘', '요즘 유행하는 거 뭐 있어?'],
    teacher: ['광합성을 쉽게 설명해 주세요', '분수 나눗셈은 왜 뒤집어서 곱하나요?', '임진왜란을 5줄로 정리해 주세요', '코딩은 뭐부터 배우면 좋을까요?'],
    english: ["Let's talk about my day!", '“배고파 죽겠어”를 영어로 어떻게 해?', 'Can you quiz me on easy words?', 'I go to school yesterday. 맞아?'],
    assistant: ['이번 주 공부 계획을 짜 주세요', '이 글을 세 줄로 요약해 주세요', '발표 준비할 것 목록을 만들어 주세요', '좋은 습관 만드는 방법을 정리해 주세요']
  };

  // ───────── 상태 ─────────
  const state = {
    view: 'code',
    list: [],
    query: '',
    chat: null, // 지금 대화 { id, title, persona, created, updated, messages }
    persona: 'friend',
    attached: [], // [{ mime, data }]
    controller: null,
    streamingIdx: -1,
    settings: {}
  };

  const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newChat = () => ({ id: newId(), title: '새 대화', persona: state.persona, created: Date.now(), updated: Date.now(), messages: [] });

  // ───────── 대화 목록 ─────────
  function timeLabel(ms) {
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  }

  async function refreshList() {
    try {
      state.list = state.query ? await invoke('chats_search', { query: state.query }) : await invoke('chats_list');
    } catch (err) {
      console.error(err);
      state.list = [];
    }
    renderList();
  }

  function highlight(text, q) {
    const s = esc(text);
    if (!q) return s;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return s;
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function renderList() {
    const host = $('#seul-list');
    if (!state.list.length) {
      host.innerHTML = `<div class="seul-list-empty">${state.query ? `“${esc(state.query)}”이(가) 들어간 대화가 없어요.` : '아직 대화가 없어요.<br>아래에 말을 걸어 보세요!'}</div>`;
      return;
    }
    host.innerHTML = `<div class="seul-list-label">${state.query ? '검색 결과' : '최근 대화'}</div>` + state.list.map((c) => {
      const p = AI.personaOf(c.persona);
      const sub = state.query && c.snippet ? highlight(c.snippet, state.query) : esc(c.preview || '') || timeLabel(c.updated);
      return `<div class="seul-item${state.chat && state.chat.id === c.id ? ' active' : ''}" role="button" tabindex="0" data-id="${esc(c.id)}">
        <span class="p-emoji" title="${esc(p.name)}">${p.emoji}</span>
        <span><div class="t">${highlight(c.title || '새 대화', state.query)}</div><div class="s">${sub}</div></span>
        <button class="del" data-del="${esc(c.id)}" title="대화 삭제">${ICON.trash}</button>
      </div>`;
    }).join('');
    host.querySelectorAll('.seul-item').forEach((el) => {
      const open = () => openChat(el.dataset.id);
      el.onclick = (e) => { if (!e.target.closest('.del')) open(); };
      el.onkeydown = (e) => { if (e.key === 'Enter') open(); };
    });
    host.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => removeChat(b.dataset.del); });
  }

  let searchTimer = null;
  $('#seul-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value.trim(); refreshList(); }, 200);
  });

  async function openChat(id) {
    if (state.controller) stop();
    try {
      state.chat = await invoke('chat_load', { id });
      state.persona = state.chat.persona || 'friend';
    } catch (err) {
      toast('대화를 열지 못했어요: ' + err);
      return;
    }
    closeSide();
    renderAll();
  }

  async function removeChat(id) {
    const ok = await T.dialog.ask('이 대화를 지울까요? 지우면 되돌릴 수 없어요.', { title: '대화 삭제', kind: 'warning', okLabel: '삭제', cancelLabel: '취소' });
    if (!ok) return;
    await invoke('chat_delete', { id });
    if (state.chat && state.chat.id === id) startNew();
    refreshList();
  }

  function startNew() {
    if (state.controller) stop();
    state.chat = newChat();
    state.attached = [];
    closeSide();
    renderAll();
  }
  $('#seul-new').onclick = () => { startNew(); $('#seul-text').focus(); };

  // 폰 세로 화면: 목록 서랍
  const closeSide = () => $('#seul').classList.remove('side-open');
  $('#seul-menu').onclick = () => $('#seul').classList.toggle('side-open');
  $('#seul').addEventListener('click', (e) => {
    if ($('#seul').classList.contains('side-open') && !e.target.closest('.seul-side') && !e.target.closest('#seul-menu')) closeSide();
  });

  // ───────── 성격 ─────────
  function renderPersonas() {
    $('#seul-personas').innerHTML = AI.PERSONAS.map((p) =>
      `<button class="persona${p.id === state.persona ? ' active' : ''}" role="radio" aria-checked="${p.id === state.persona}" data-p="${p.id}" title="${esc(p.desc)}">${p.emoji} ${esc(p.name)}</button>`).join('');
    document.querySelectorAll('#seul-personas .persona').forEach((b) => {
      b.onclick = () => {
        state.persona = b.dataset.p;
        if (state.chat) {
          state.chat.persona = state.persona;
          if (state.chat.messages.length) save();
        }
        renderPersonas();
        if (!state.chat || !state.chat.messages.length) renderLog();
        invoke('settings_set', { partial: { persona: state.persona } }).catch(() => {});
      };
    });
  }

  // ───────── 대화 그리기 ─────────
  function md(text) {
    try {
      return window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { gfm: true, breaks: true }));
    } catch (_) {
      return esc(text).replace(/\n/g, '<br>');
    }
  }

  function msgHtml(m, idx) {
    if (m.role === 'user') {
      const imgs = (m.images || []).map((img, i) => `<img src="data:${esc(img.mime)};base64,${img.data}" alt="첨부한 사진 ${i + 1}" data-zoom>`).join('');
      return `<div class="s-msg user" data-idx="${idx}"><div class="s-body">
        ${imgs ? `<div class="s-images">${imgs}</div>` : ''}
        ${m.content ? `<div class="s-bubble">${esc(m.content)}</div>` : ''}
      </div></div>`;
    }
    const streaming = idx === state.streamingIdx;
    const body = m.error
      ? esc(m.content)
      : (m.content ? md(m.content) : '') + (streaming && !m.content ? '<span class="s-dots"><i></i><i></i><i></i></span>' : '');
    const actions = streaming ? '' : `<div class="s-actions">
      ${m.error ? '' : `<button class="s-act" data-copy="${idx}">${ICON.copy}복사</button>`}
      ${idx === state.chat.messages.length - 1 ? `<button class="s-act" data-retry>${ICON.retry}다시 답하기</button>` : ''}
      ${m.error ? (m.needsKey ? '<button class="s-act" data-key>API 키 입력</button>' : '') : `<button class="s-act handoff" data-handoff="${idx}" title="이 대화 내용으로 Code AI에서 진짜로 만들어요">${ICON.code}Code AI로 만들기</button>`}
    </div>`;
    return `<div class="s-msg ai${m.error ? ' error' : ''}" data-idx="${idx}">
      <div class="s-avatar">${robot({ thinking: streaming })}</div>
      <div class="s-body"><div class="s-bubble">${body}</div>${actions}</div>
    </div>`;
  }

  function renderLog() {
    const col = $('#seul-col');
    const msgs = state.chat ? state.chat.messages : [];
    if (!msgs.length) {
      const p = AI.personaOf(state.persona);
      const hello = {
        friend: '안녕! 나는 슬이야. 무슨 얘기든 편하게 해 줘 😊',
        teacher: '안녕하세요! 궁금한 건 무엇이든 쉽게 설명해 드릴게요.',
        english: "Hi! I'm Seul. Let's practice English together!",
        assistant: '안녕하세요. 정리하거나 계획할 일이 있으면 말씀해 주세요.'
      }[p.id];
      col.innerHTML = `<div class="seul-hello">${robot({ size: 132, wave: true })}
        <h2>${esc(hello)}</h2>
        <p>${esc(p.emoji + ' ' + p.name)} 모드 · 위에서 성격을 바꿀 수 있어요</p>
        <div class="seul-sugg">${(SUGGESTIONS[p.id] || []).map((s) => `<button>${esc(s)}</button>`).join('')}</div>
      </div>`;
      col.querySelectorAll('.seul-sugg button').forEach((b) => { b.onclick = () => { $('#seul-text').value = b.textContent; send(); }; });
      return;
    }
    col.innerHTML = msgs.map(msgHtml).join('');
    bindMsgActions(col);
    scrollDown(true);
  }

  function updateMsg(idx) {
    const old = $(`#seul-col .s-msg[data-idx="${idx}"]`);
    if (!old) return renderLog();
    const wrap = document.createElement('div');
    wrap.innerHTML = msgHtml(state.chat.messages[idx], idx);
    const el = wrap.firstElementChild;
    old.replaceWith(el);
    bindMsgActions(el);
    scrollDown();
  }

  function scrollDown(force) {
    const log = $('#seul-log');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
    if (force || near) log.scrollTop = log.scrollHeight;
  }

  function bindMsgActions(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = async () => {
        await copyText(state.chat.messages[+b.dataset.copy].content);
        toast('복사했어요.');
      };
    });
    root.querySelectorAll('[data-retry]').forEach((b) => { b.onclick = retry; });
    root.querySelectorAll('[data-key]').forEach((b) => { b.onclick = () => openSettings(); });
    root.querySelectorAll('[data-handoff]').forEach((b) => { b.onclick = () => handoff(+b.dataset.handoff); });
    root.querySelectorAll('img[data-zoom]').forEach((img) => {
      img.onclick = () => {
        const box = document.createElement('div');
        box.className = 'seul-lightbox';
        box.innerHTML = `<img src="${img.src}" alt="">`;
        box.onclick = () => box.remove();
        document.body.appendChild(box);
      };
    });
    // 답변 속 링크는 기본 브라우저로 연다.
    root.querySelectorAll('.s-bubble a[href]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) openUrl(a.href); };
    });
  }

  function renderTitle() {
    $('#seul-title').textContent = state.chat && state.chat.messages.length ? state.chat.title : '새 대화';
  }

  function renderAll() {
    renderPersonas();
    renderTitle();
    renderAttached();
    renderLog();
    renderList();
    setBusy(!!state.controller);
  }

  // ───────── 사진 ─────────
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; // 투명 PNG가 검게 나오지 않게
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어요.')); };
      img.src = url;
    });
  }

  async function addFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    for (const f of images) {
      if (state.attached.length >= MAX_IMAGES) {
        toast(`사진은 한 번에 ${MAX_IMAGES}장까지 넣을 수 있어요.`);
        break;
      }
      try {
        state.attached.push(await readImage(f));
      } catch (err) {
        toast(err.message);
      }
    }
    renderAttached();
  }

  function renderAttached() {
    const host = $('#seul-attached');
    host.innerHTML = state.attached.map((img, i) =>
      `<div class="seul-thumb"><img src="data:${img.mime};base64,${img.data}" alt="넣은 사진 ${i + 1}"><button data-rm="${i}" title="빼기">×</button></div>`).join('');
    host.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { state.attached.splice(+b.dataset.rm, 1); renderAttached(); }; });
    updateSendBtn();
  }

  $('#seul-attach').onclick = () => $('#seul-file').click();
  $('#seul-file').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('#seul-text').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      addFiles(files);
    }
  });
  const box = $('#seul-box');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); addFiles(e.dataTransfer.files); });

  // ───────── 보내기 ─────────
  const input = $('#seul-text');
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(200, Math.max(38, input.scrollHeight)) + 'px';
    updateSendBtn();
  }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.controller) send();
    }
  });

  function updateSendBtn() {
    const btn = $('#seul-send');
    if (state.controller) {
      btn.disabled = false;
      btn.innerHTML = ICON.stop;
      btn.title = '그만';
    } else {
      btn.innerHTML = ICON.send;
      btn.title = '보내기 (Enter)';
      btn.disabled = !input.value.trim() && !state.attached.length;
    }
  }
  $('#seul-send').onclick = () => (state.controller ? stop() : send());

  function setBusy(busy) {
    updateSendBtn();
    $('#seul-attach').disabled = busy;
  }

  let saveTimer = null;
  function save(now) {
    if (!state.chat || !state.chat.messages.length) return;
    clearTimeout(saveTimer);
    const run = () => invoke('chat_save', { chat: state.chat }).then(refreshList).catch((err) => toast('대화를 저장하지 못했어요: ' + err));
    if (now) run();
    else saveTimer = setTimeout(run, 400);
  }

  async function send() {
    const text = input.value.trim();
    if (!text && !state.attached.length) return;
    if (!state.chat) state.chat = newChat();
    const msg = { role: 'user', content: text, time: Date.now() };
    if (state.attached.length) msg.images = state.attached;
    if (!state.chat.messages.length) state.chat.title = AI.titleFrom(text);
    state.chat.persona = state.persona;
    state.chat.messages.push(msg);
    state.attached = [];
    input.value = '';
    autoGrow();
    renderAttached();
    renderTitle();
    await answer();
  }

  async function retry() {
    if (state.controller || !state.chat) return;
    const msgs = state.chat.messages;
    if (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    await answer();
  }

  async function answer() {
    const chat = state.chat;
    const reply = { role: 'assistant', content: '', time: Date.now() };
    chat.messages.push(reply);
    const idx = chat.messages.length - 1;
    state.streamingIdx = idx;
    state.controller = new AbortController();
    setBusy(true);
    renderLog();
    save(true);

    let pending = false;
    const repaint = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; if (state.chat === chat) updateMsg(idx); });
    };

    try {
      const key = await invoke('api_key_get');
      if (!key) {
        Object.assign(reply, { content: 'API 키가 없어요. 설정에서 무료 Gemini 키를 넣어 주세요.', error: true, needsKey: true });
        return;
      }
      const settings = await invoke('settings_get');
      const r = await AI.talk({
        fetch: T.http.fetch,
        key,
        model: settings.model,
        persona: chat.persona,
        messages: chat.messages.slice(0, idx).slice(-HISTORY_LIMIT),
        signal: state.controller.signal,
        onText: (t) => { reply.content += t; repaint(); },
        onNotice: (t) => { reply.content += `*${t.trim()}*\n\n`; repaint(); }
      });
      if (r.error) {
        if (reply.content) reply.content += `\n\n⚠️ ${r.error}`;
        else Object.assign(reply, { content: r.error, error: true, needsKey: !!r.needsKey });
      } else if (r.maxTokens) {
        reply.content += '\n\n*(답변이 너무 길어 중간에 끊겼어요)*';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (!reply.content) reply.content = '*(멈췄어요)*';
      } else {
        Object.assign(reply, { content: '오류: ' + ((err && err.message) || err), error: true });
      }
    } finally {
      state.controller = null;
      state.streamingIdx = -1;
      chat.updated = Date.now();
      setBusy(false);
      if (state.chat === chat) updateMsg(idx);
      state.chat = chat === state.chat ? chat : state.chat;
      invoke('chat_save', { chat }).then(refreshList).catch((err) => toast('대화를 저장하지 못했어요: ' + err));
    }
  }

  function stop() {
    if (state.controller) state.controller.abort();
  }

  // ───────── Code AI로 넘기기 ─────────
  // 대화에서 사용자가 원한 것을 모아 Code AI 채팅 칸에 넣는다.
  function handoff(idx) {
    const msgs = state.chat.messages.slice(0, idx + 1);
    const asks = msgs.filter((m) => m.role === 'user' && m.content).slice(-3).map((m) => m.content);
    const last = msgs[idx];
    const plan = last && last.role === 'assistant' && !last.error ? last.content.slice(0, 1500) : '';
    const text = [
      '[SEUL Chat에서 넘어온 요청]',
      asks.length ? asks.map((a) => '- ' + a).join('\n') : '',
      plan ? '\n[슬이 정리한 내용]\n' + plan : '',
      '\n위 내용대로 만들어 줘.'
    ].filter(Boolean).join('\n');
    // Code AI 앱을 codeai:// 링크로 연다. 안 열리면(설치 안 됨) 복사해 둔 글을 붙여 넣으면 된다.
    copyText(text).catch(() => {});
    openUrl('codeai://new?text=' + encodeURIComponent(text.slice(0, 1800)))
      .then(() => toast('Code AI를 여는 중이에요. 안 열리면 Code AI 채팅에 붙여넣기(Ctrl+V) 하세요.', '', 4500))
      .catch(() => toast('Code AI를 열지 못했어요. 내용을 복사해 뒀으니 Code AI 채팅에 붙여넣기 하세요.', '', 5000));
  }

  // ───────── 테마 ─────────
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = state.settings.theme || 'system';
    const dark = t === 'dark' || (t === 'system' && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { T.window.getCurrentWindow().setTheme(t === 'system' ? null : t); } catch (_) { /* 무시 */ }
  }
  darkQuery.addEventListener('change', applyTheme);
  async function setSetting(partial) {
    state.settings = await invoke('settings_set', { partial });
    applyTheme();
  }
  $('#btn-theme').onclick = () => setSetting({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });

  // ───────── 설정 / 키 ─────────
  const KEY_URL = AI.KEY_CONSOLE_URLS.gemini;
  const openModal = (id) => { $(id).hidden = false; };
  const closeModal = (id) => { $(id).hidden = true; };
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => closeModal('#' + b.closest('.modal').id); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])').forEach((m) => { if (m.id !== 'modal-welcome') m.hidden = true; });
  });

  async function saveKey(value, resultEl) {
    const key = String(value || '').trim();
    resultEl.className = '';
    resultEl.textContent = '키를 확인하는 중…';
    const r = await AI.checkKey({ fetch: T.http.fetch, key });
    if (!r.ok) {
      resultEl.className = 'err';
      resultEl.textContent = r.error;
      return false;
    }
    try {
      state.settings = await invoke('api_key_store', { key });
    } catch (err) {
      resultEl.className = 'err';
      resultEl.textContent = String(err);
      return false;
    }
    if (state.settings.model && AI.providerOfModel(state.settings.model) !== AI.providerOfKey(key)) await setSetting({ model: null });
    resultEl.className = 'good';
    resultEl.textContent = '저장했어요! 이제 대화할 수 있어요.';
    return true;
  }

  function renderSettings() {
    const s = state.settings;
    document.querySelectorAll('#set-theme button').forEach((b) => {
      b.classList.toggle('active', b.dataset.value === (s.theme || 'system'));
      b.onclick = async () => { await setSetting({ theme: b.dataset.value }); renderSettings(); };
    });
    $('#key-status').textContent = s.hasApiKey
      ? `저장된 키: ${s.apiKeyHint} (${s.keyProvider === 'claude' ? 'Claude' : 'Gemini 무료'})`
      : '아직 키가 없어요.';
    const provider = s.keyProvider || 'gemini';
    const current = s.model && AI.providerOfModel(s.model) === provider ? s.model : AI.DEFAULT_MODELS[provider];
    $('#set-models').innerHTML = AI.MODELS.filter((m) => m.provider === provider).map((m) =>
      `<label class="model"><input type="radio" name="model" value="${m.id}" ${m.id === current ? 'checked' : ''}><span>${esc(m.label)}</span><span class="price">${esc(m.price)}</span></label>`).join('');
    document.querySelectorAll('#set-models input').forEach((r) => { r.onchange = () => setSetting({ model: r.value }); });
    $('#set-version').textContent = 'SEUL Chat ' + (s.version || '');
  }

  function openSettings() {
    $('#key-input').value = '';
    $('#key-result').textContent = '';
    renderSettings();
    openModal('#modal-settings');
  }
  $('#btn-settings').onclick = openSettings;
  $('#key-save').onclick = async () => {
    if (await saveKey($('#key-input').value, $('#key-result'))) {
      $('#key-input').value = '';
      renderSettings();
    }
  };
  $('#key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-save').click(); });
  $('#key-get').onclick = (e) => { e.preventDefault(); openUrl(KEY_URL); };
  $('#key-clear').onclick = async (e) => {
    e.preventDefault();
    const ok = await T.dialog.ask('저장된 API 키를 지울까요? Code AI에서도 같이 지워져요.', { title: '키 지우기', kind: 'warning', okLabel: '지우기', cancelLabel: '취소' });
    if (!ok) return;
    state.settings = await invoke('api_key_store', { key: null });
    renderSettings();
  };

  // 처음 실행: 키가 없으면 환영 창
  function openWelcome() {
    $('#welcome-robot').innerHTML = robot({ size: 96, wave: true });
    openModal('#modal-welcome');
    setTimeout(() => $('#welcome-key').focus(), 50);
  }
  $('#welcome-get').onclick = (e) => { e.preventDefault(); openUrl(KEY_URL); };
  $('#welcome-save').onclick = async () => {
    $('#welcome-save').disabled = true;
    const ok = await saveKey($('#welcome-key').value, $('#welcome-result'));
    $('#welcome-save').disabled = false;
    if (ok) setTimeout(() => { closeModal('#modal-welcome'); input.focus(); }, 700);
  };
  $('#welcome-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#welcome-save').click(); });
  $('#welcome-later').onclick = () => closeModal('#modal-welcome');

  // ───────── 공통 ─────────
  function toast(msg, type = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ───────── 시작 ─────────
  async function init() {
    $('#brand').innerHTML = robot({ size: 26 }) + '<span>SEUL Chat</span>';
    state.settings = await invoke('settings_get');
    if (state.settings.persona) state.persona = state.settings.persona;
    applyTheme();
    state.chat = newChat();
    renderAll();
    refreshList();
    input.focus();
    if (!state.settings.hasApiKey) openWelcome();
    window.__seulReady = true;
  }
  init();
})();
