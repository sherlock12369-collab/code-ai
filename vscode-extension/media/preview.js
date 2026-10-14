/* Code AI 미리보기 패널 스크립트 */
(function () {
  const vscode = acquireVsCodeApi();
  const stage = document.getElementById('stage');
  const fileEl = document.getElementById('file');
  const selectBtn = document.getElementById('select');
  const refreshBtn = document.getElementById('refresh');
  const externalBtn = document.getElementById('external');
  const deviceSel = document.getElementById('device');
  const hint = document.getElementById('hint');

  const saved = vscode.getState() || {};
  let state = { url: null, kind: null, file: null, selectMode: false, device: saved.device || 'full' };
  let frame = null;
  let frameReady = false;
  deviceSel.value = state.device;

  function bust(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '__t=' + Date.now();
  }

  function applyDevice() {
    const wrap = stage.querySelector('.device');
    if (!wrap) return;
    if (state.device === 'full') {
      wrap.style.width = '100%';
      wrap.classList.remove('framed');
    } else {
      wrap.style.width = state.device + 'px';
      wrap.classList.add('framed');
    }
  }

  function render() {
    stage.innerHTML = '';
    frame = null;
    frameReady = false;
    fileEl.textContent = state.file || '—';
    const supportsSelect = state.kind === 'html' || state.kind === 'markdown';
    selectBtn.disabled = !supportsSelect;
    if (!supportsSelect) setSelectMode(false);

    if (state.kind === 'image') {
      const box = document.createElement('div');
      box.className = 'image-stage';
      const img = document.createElement('img');
      img.src = bust(state.url);
      img.alt = state.file || '';
      img.addEventListener('error', () => {
        box.innerHTML = '<div class="empty">이미지를 불러올 수 없습니다.</div>';
      });
      box.appendChild(img);
      stage.appendChild(box);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'device';
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals');
    frame.src = bust(state.url);
    frame.addEventListener('load', () => {
      // 주입 스크립트가 없는 문서(PDF 등)도 새로고침이 동작하도록 표시
      setTimeout(() => { if (!frameReady) frame && frame.setAttribute('data-plain', '1'); }, 300);
    });
    wrap.appendChild(frame);
    stage.appendChild(wrap);
    applyDevice();
  }

  function postToFrame(msg) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    selectBtn.classList.toggle('active', state.selectMode);
    selectBtn.setAttribute('aria-pressed', String(state.selectMode));
    hint.hidden = !state.selectMode;
    postToFrame({ codeai: 'selectMode', on: state.selectMode });
  }

  function reload() {
    if (!state.url) return;
    if (state.kind === 'image') {
      const img = stage.querySelector('img');
      if (img) img.src = bust(state.url);
      return;
    }
    if (frame && frameReady) {
      frameReady = false;
      postToFrame({ codeai: 'reload' });
    } else if (frame) {
      frame.src = bust(state.url);
    } else {
      render();
    }
  }

  window.addEventListener('message', (e) => {
    const d = e.data || {};
    // 확장에서 온 메시지
    if (d.type === 'show') {
      const changed = d.url !== state.url;
      state.url = d.url;
      state.kind = d.kind;
      state.file = d.file;
      if (changed) render();
      return;
    }
    if (d.type === 'reload') {
      reload();
      return;
    }
    // 미리보기 iframe 에서 온 메시지
    if (d.codeai === 'ready') {
      frameReady = true;
      if (d.file) fileEl.textContent = d.file;
      postToFrame({ codeai: 'selectMode', on: state.selectMode });
      return;
    }
    if (d.codeai === 'selection') {
      vscode.postMessage({ type: 'selection', selector: d.selector, html: d.html, file: d.file });
      flash('채팅에 첨부했습니다: ' + d.selector);
    }
  });

  let flashTimer;
  function flash(text) {
    hint.hidden = false;
    hint.textContent = text;
    hint.classList.add('ok');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      hint.classList.remove('ok');
      hint.textContent = '수정할 요소를 클릭하세요. 선택한 요소가 채팅에 첨부됩니다. (Esc: 종료)';
      hint.hidden = !state.selectMode;
    }, 1800);
  }

  selectBtn.addEventListener('click', () => setSelectMode(!state.selectMode));
  refreshBtn.addEventListener('click', () => { if (frame) frame.src = bust(state.url); else reload(); });
  externalBtn.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: state.url }));
  fileEl.addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));
  deviceSel.addEventListener('change', () => {
    state.device = deviceSel.value;
    vscode.setState({ device: state.device });
    applyDevice();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectMode) setSelectMode(false);
  });
  vscode.postMessage({ type: 'ready' });
})();
