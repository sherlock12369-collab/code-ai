/* Code AI 채팅 뷰 스크립트 */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const chips = $('chips');
  const statusEl = $('status');
  const statusText = $('statusText');
  const activeFileEl = $('activeFile');
  const historyList = $('historyList');
  const historyCount = $('historyCount');

  let selection = null;
  let busy = false;
  let current = null; // { el, body, text }
  let renderQueued = false;

  const draft = (vscode.getState() || {}).draft;
  if (draft) input.value = draft;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  /** 간단한 마크다운: 코드 블록(```file:경로 포함), 인라인 코드, 굵게 */
  function renderMarkdown(text, streaming) {
    let html = '';
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      html += inline(text.slice(last, m.index));
      const info = m[1].trim();
      const code = m[2];
      const closed = m[3] === '```';
      if (/^file:/i.test(info)) {
        const path = info.slice(5).trim();
        html +=
          '<details class="filecode"><summary><span class="badge">파일</span> ' + esc(path) +
          (closed ? '' : ' <span class="muted">작성 중…</span>') +
          '</summary><pre><code>' + esc(code) + '</code></pre></details>';
      } else {
        html += '<pre><code>' + esc(code) + '</code></pre>';
      }
      last = re.lastIndex;
      if (!closed) break;
      if (m[0].length === 0) re.lastIndex++;
    }
    html += inline(text.slice(last));
    if (streaming) html += '<span class="cursor"></span>';
    return html;
  }

  function hideWelcome() {
    const w = $('welcome');
    if (w) w.remove();
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function addMessage(role, html, extraClass) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? '나' : role === 'assistant' ? 'Code AI' : '알림';
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = html;
    el.appendChild(who);
    el.appendChild(body);
    log.appendChild(el);
    scrollDown();
    return { el, body };
  }

  function selectionHtml(sel) {
    return '<div class="selref"><span class="badge">선택</span> <code>' + esc(sel.selector) + '</code>' +
      (sel.file ? ' <span class="muted">· ' + esc(sel.file) + '</span>' : '') + '</div>';
  }

  function renderChips() {
    chips.innerHTML = '';
    if (!selection) return;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = selection.html;
    chip.innerHTML = '<span class="badge">선택</span><code>' + esc(selection.selector) + '</code>' +
      (selection.file ? '<span class="muted">' + esc(selection.file) + '</span>' : '');
    const x = document.createElement('button');
    x.className = 'x';
    x.title = '첨부 해제';
    x.textContent = '×';
    x.addEventListener('click', () => {
      selection = null;
      renderChips();
      vscode.postMessage({ type: 'clearSelection' });
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    stopBtn.hidden = !b;
  }

  function send() {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    vscode.setState({ draft: '' });
    vscode.postMessage({ type: 'send', text });
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (current) {
        current.body.innerHTML = renderMarkdown(current.text, true);
        scrollDown();
      }
    });
  }

  function notice(kind, text, url) {
    let html = inline(text);
    if (url) {
      html += '<div class="linkbox"><a href="#" data-open="' + esc(url) + '">' + esc(url) + '</a>' +
        '<div class="row"><button data-copy="' + esc(url) + '">링크 복사</button>' +
        '<button class="primary" data-open="' + esc(url) + '">열기</button></div></div>';
    }
    addMessage('system', html, kind);
  }

  // 이벤트 위임: 링크/버튼
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-copy],[data-file],[data-cmd],.example,[data-restore],[data-delete]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.open) vscode.postMessage({ type: 'openUrl', url: t.dataset.open });
    else if (t.dataset.copy) vscode.postMessage({ type: 'copy', text: t.dataset.copy });
    else if (t.dataset.file) vscode.postMessage({ type: 'openFile', path: t.dataset.file });
    else if (t.dataset.cmd) vscode.postMessage({ type: 'command', command: t.dataset.cmd });
    else if (t.dataset.restore) vscode.postMessage({ type: 'restore', id: t.dataset.restore });
    else if (t.dataset.delete) vscode.postMessage({ type: 'deleteHistory', id: t.dataset.delete });
    else if (t.classList.contains('example')) {
      input.value = t.textContent;
      input.focus();
    }
  });

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => vscode.setState({ draft: input.value }));

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    switch (m.type) {
      case 'restore':
        if (m.messages && m.messages.length) {
          log.innerHTML = '';
          for (const msg of m.messages) {
            addMessage(msg.role, msg.role === 'user' ? inline(msg.content) : renderMarkdown(msg.content, false));
          }
        }
        selection = m.selection || null;
        renderChips();
        break;
      case 'reset':
        log.innerHTML = '';
        current = null;
        selection = null;
        renderChips();
        setBusy(false);
        addMessage('system', '새 대화를 시작했습니다.');
        break;
      case 'server':
        statusEl.classList.toggle('ok', !!m.ok);
        statusEl.classList.toggle('bad', !m.ok);
        statusText.textContent = m.text;
        break;
      case 'activeFile':
        activeFileEl.textContent = m.file ? '현재 파일: ' + m.file : '';
        break;
      case 'selection':
        selection = m.selection;
        renderChips();
        input.focus();
        break;
      case 'user':
        addMessage('user', (m.selection ? selectionHtml(m.selection) : '') + inline(m.text));
        selection = null;
        renderChips();
        break;
      case 'assistantStart': {
        setBusy(true);
        const r = addMessage('assistant', '<span class="cursor"></span>');
        current = { el: r.el, body: r.body, text: '' };
        break;
      }
      case 'context':
        if (current && m.files && m.files.length) {
          const ctx = document.createElement('div');
          ctx.className = 'context muted';
          ctx.textContent = '참고한 파일 ' + m.files.length + '개';
          ctx.title = m.files.join('\n');
          current.el.insertBefore(ctx, current.body);
        }
        break;
      case 'delta':
        if (current) {
          current.text += m.text;
          queueRender();
        }
        break;
      case 'assistantEnd':
        setBusy(false);
        if (current) {
          let html = current.text ? renderMarkdown(current.text, false) : '';
          if (m.aborted) html += '<div class="muted">중지됨</div>';
          if (m.applied && m.applied.length) {
            html += '<div class="applied"><div class="muted">변경된 파일</div>' +
              m.applied.map((p) => '<a href="#" class="file" data-file="' + esc(p) + '">' + esc(p) + '</a>').join('') +
              '<div class="muted small">변경 전 상태는 아래 <b>변경 기록</b>에서 되돌릴 수 있어요.</div></div>';
          }
          if (m.error) html += '<div class="error">' + inline(m.error) + '</div>';
          if (!html) html = '<span class="muted">(응답 없음)</span>';
          current.body.innerHTML = html;
          current = null;
          scrollDown();
        }
        break;
      case 'notice':
        notice(m.kind, m.text, m.url);
        break;
      case 'history': {
        historyCount.textContent = String(m.items.length);
        if (!m.items.length) {
          historyList.innerHTML = '<li class="muted">아직 기록이 없습니다.</li>';
          break;
        }
        historyList.innerHTML = m.items.map((h) =>
          '<li><div class="h-main"><div class="h-label" title="' + esc(h.label) + '">' + esc(h.label || '(설명 없음)') + '</div>' +
          '<div class="muted small">' + esc(h.time) + ' · ' + h.files.length + '개 파일</div>' +
          '<div class="muted small h-files" title="' + esc(h.files.join('\n')) + '">' + esc(h.files.join(', ')) + '</div></div>' +
          '<div class="h-actions"><button data-restore="' + esc(h.id) + '" title="이 변경 전으로 되돌리기">되돌리기</button>' +
          '<button class="ghost" data-delete="' + esc(h.id) + '" title="기록 삭제">삭제</button></div></li>'
        ).join('');
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
