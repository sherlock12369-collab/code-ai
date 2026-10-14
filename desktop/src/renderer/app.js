/* Code AI — 렌더러 (Monaco 편집기, 파일 트리, AI 채팅, 실시간 미리보기) */
'use strict';

(function () {
  const api = window.codeai;
  const $ = (sel) => document.querySelector(sel);

  // ───────────────────────── 상태 ─────────────────────────
  const state = {
    settings: null,
    project: null,          // { root, name }
    previewBase: '',
    tree: [],
    expanded: new Set(),
    openFiles: new Map(),   // path -> { model, dirty, viewState, savedVersion }
    activePath: null,
    previewPath: null,
    previewAuto: true,      // 편집 중인 파일을 자동으로 미리보기
    selectMode: false,
    selection: null,        // { selector, html, file }
    messages: [],           // [{ role, content, selection? , files? }]
    chatId: null,
    serverOk: null,
    update: null
  };

  let monaco = null;
  let editor = null;

  const LANG = {
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', markdown: 'markdown', py: 'python',
    java: 'java', c: 'c', h: 'cpp', cpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'shell',
    ps1: 'powershell', bat: 'bat', xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql', kt: 'kotlin', swift: 'swift',
    vue: 'html', svelte: 'html', ini: 'ini', toml: 'ini', txt: 'plaintext', csv: 'plaintext'
  };
  const PREVIEWABLE = /\.(html?|md|markdown|png|jpe?g|gif|svg|webp|avif|ico|pdf)$/i;
  const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|mp3|mp4|webm|wav|zip|exe|dll)$/i;

  const ext = (p) => (p.match(/\.([^./\\]+)$/) || [, ''])[1].toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { return null; }
    return value;
  }

  // ───────────────────────── 공통 UI ─────────────────────────
  function toast(msg, type = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function status(msg) {
    $('#status-left').textContent = msg;
  }

  function openModal(id) {
    $(id).hidden = false;
  }
  function closeModal(id) {
    $(id).hidden = true;
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'modal-prompt') m.hidden = true; });
    m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { m.hidden = true; }));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.modal')].find((m) => !m.hidden && m.id !== 'modal-prompt');
      if (open) open.hidden = true;
      hideContextMenu();
    }
  });

  // window.prompt 대체
  function askText(title, initial = '') {
    return new Promise((resolve) => {
      const input = $('#prompt-input');
      $('#prompt-title').textContent = title;
      input.value = initial;
      openModal('#modal-prompt');
      setTimeout(() => { input.focus(); input.select(); }, 0);
      const done = (val) => {
        closeModal('#modal-prompt');
        $('#prompt-ok').onclick = $('#prompt-cancel').onclick = input.onkeydown = null;
        resolve(val);
      };
      $('#prompt-ok').onclick = () => done(input.value.trim() || null);
      $('#prompt-cancel').onclick = () => done(null);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value.trim() || null);
        if (e.key === 'Escape') done(null);
      };
    });
  }

  function hideContextMenu() {
    $('#context-menu').hidden = true;
  }
  function showContextMenu(x, y, items) {
    const menu = $('#context-menu');
    menu.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.onclick = () => { hideContextMenu(); it.action(); };
      menu.appendChild(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#context-menu')) hideContextMenu(); });

  // ───────────────────────── 테마 ─────────────────────────
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function effectiveDark() {
    const t = state.settings ? state.settings.theme : 'system';
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return darkQuery.matches;
  }
  function applyTheme() {
    const dark = effectiveDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (monaco) monaco.editor.setTheme(dark ? 'codeai-dark' : 'codeai-light');
    if (state.previewPath && /\.(md|markdown)$/i.test(state.previewPath)) reloadPreview();
  }
  darkQuery.addEventListener('change', applyTheme);
  api.onThemeUpdated(applyTheme);

  async function toggleTheme() {
    const next = effectiveDark() ? 'light' : 'dark';
    state.settings = await api.settings.set({ theme: next });
    applyTheme();
  }

  // ───────────────────────── 패널 크기 조절 ─────────────────────────
  const workspace = $('#workspace');
  const widths = Object.assign({ tree: 240, chat: 380, preview: 520 }, store('codeai.widths') || {});
  function applyWidths() {
    workspace.style.setProperty('--w-tree', widths.tree + 'px');
    workspace.style.setProperty('--w-chat', widths.chat + 'px');
    workspace.style.setProperty('--w-preview', widths.preview + 'px');
  }
  applyWidths();
  document.querySelectorAll('.splitter').forEach((sp) => {
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = sp.dataset.target;
      const startX = e.clientX;
      const start = widths[target];
      const shield = $('#drag-shield');
      shield.hidden = false;
      sp.classList.add('dragging');
      const limits = { tree: [150, 480], chat: [260, 720], preview: [260, 1400] };
      const move = (ev) => {
        const dx = ev.clientX - startX;
        // tree 스플리터는 오른쪽으로 끌면 커지고, chat/preview 스플리터는 왼쪽으로 끌면 커진다.
        let w = target === 'tree' ? start + dx : start - dx;
        const [min, max] = limits[target];
        w = Math.max(min, Math.min(max, w, innerWidth - 500));
        widths[target] = w;
        applyWidths();
      };
      const up = () => {
        shield.hidden = true;
        sp.classList.remove('dragging');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        store('codeai.widths', widths);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  });

  // ───────────────────────── Monaco ─────────────────────────
  function loadMonaco() {
    return new Promise((resolve, reject) => {
      const base = new URL('../../node_modules/monaco-editor/min/', location.href).href;
      window.MonacoEnvironment = {
        getWorkerUrl() {
          return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
            `self.MonacoEnvironment={baseUrl:${JSON.stringify(base)}};importScripts(${JSON.stringify(base + 'vs/base/worker/workerMain.js')});`);
        }
      };
      window.require.config({ paths: { vs: base + 'vs' }, 'vs/nls': { availableLanguages: { '*': 'ko' } } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    });
  }

  function initEditor() {
    monaco.editor.defineTheme('codeai-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: {
        'editor.background': '#0b0b0d', 'editor.lineHighlightBackground': '#16161a', 'editorLineNumber.foreground': '#4a4a52',
        'editorLineNumber.activeForeground': '#c9c9ce', 'editor.selectionBackground': '#7c5cff55', 'editorCursor.foreground': '#7c5cff',
        'editorWidget.background': '#121215', 'editorGutter.background': '#0b0b0d', 'scrollbarSlider.background': '#2f2f3688'
      }
    });
    monaco.editor.defineTheme('codeai-light', {
      base: 'vs', inherit: true, rules: [],
      colors: {
        'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f7f7f8', 'editorLineNumber.foreground': '#b5b5bc',
        'editorLineNumber.activeForeground': '#3a3a40', 'editor.selectionBackground': '#7c5cff33', 'editorCursor.foreground': '#7c5cff'
      }
    });
    editor = monaco.editor.create($('#editor-host'), {
      model: null,
      theme: effectiveDark() ? 'codeai-dark' : 'codeai-light',
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", D2Coding, Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 21,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: 'on',
      renderWhitespace: 'selection',
      padding: { top: 10 }
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  }

  // ───────────────────────── 프로젝트 ─────────────────────────
  async function onProjectChanged(info) {
    // 이전 프로젝트 정리
    for (const f of state.openFiles.values()) f.model.dispose();
    state.openFiles.clear();
    state.activePath = null;
    state.previewPath = null;
    state.previewAuto = true;
    state.expanded.clear();
    clearSelection(true);
    state.project = info;

    $('#project-name').textContent = info ? info.name : '프로젝트 없음';
    document.title = info ? `${info.name} — Code AI` : 'Code AI';
    $('#welcome').hidden = !!info;
    state.messages = info ? (store('codeai.chat.' + info.root) || []) : [];
    renderChat();
    renderTabs();
    await refreshTree();
    if (info) {
      const first = pickDefaultPreview();
      if (first && !BINARY.test(first)) await openFile(first);
      else updateEditorVisibility();
    }
    updatePreviewSelect();
    reloadPreview();
  }

  async function openFolder() {
    const info = await api.project.open();
    if (info) await onProjectChanged(info);
  }

  // ───────────────────────── 파일 트리 ─────────────────────────
  function flatFiles(nodes = state.tree, out = []) {
    for (const n of nodes) {
      if (n.type === 'dir') flatFiles(n.children, out);
      else out.push(n.path);
    }
    return out;
  }

  let treeTimer = null;
  function refreshTreeSoon() {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(refreshTree, 120);
  }

  async function refreshTree() {
    state.tree = state.project ? await api.fs.tree() : [];
    renderTree();
    updatePreviewSelect();
  }

  const ICON = {
    chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function renderTree() {
    const host = $('#file-tree');
    host.innerHTML = '';
    if (!state.project) {
      host.innerHTML = '<div class="tree-empty">열린 프로젝트가 없습니다.</div>';
      return;
    }
    if (!state.tree.length) {
      host.innerHTML = '<div class="tree-empty">빈 폴더입니다. AI에게 만들어 달라고 요청해 보세요.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const el = document.createElement('div');
        el.className = 'tree-item';
        el.style.paddingLeft = 10 + depth * 14 + 'px';
        el.dataset.path = n.path;
        el.title = n.path;
        if (n.type === 'dir') {
          const open = state.expanded.has(n.path);
          if (open) el.classList.add('open');
          el.innerHTML = ICON.chev + ICON.folder + `<span class="name">${esc(n.name)}</span>`;
          el.onclick = () => {
            if (open) state.expanded.delete(n.path); else state.expanded.add(n.path);
            renderTree();
          };
          frag.appendChild(el);
          if (open) walk(n.children, depth + 1);
        } else {
          if (n.path === state.activePath) el.classList.add('active');
          el.innerHTML = '<span style="width:12px"></span>' + (/\.(png|jpe?g|gif|svg|webp|ico|avif)$/i.test(n.name) ? ICON.image : ICON.file) +
            `<span class="name">${esc(n.name)}</span>`;
          el.onclick = () => onTreeFileClick(n.path);
          frag.appendChild(el);
        }
        el.oncontextmenu = (e) => {
          e.preventDefault();
          const dir = n.type === 'dir' ? n.path : n.path.split('/').slice(0, -1).join('/');
          const items = [
            { label: '새 파일…', action: () => newFile(dir) },
            { label: '새 폴더…', action: () => newFolder(dir) }
          ];
          if (n.type === 'file' && PREVIEWABLE.test(n.path)) items.unshift({ label: '미리보기로 보기', action: () => setPreview(n.path, false) });
          items.push({ label: '탐색기에서 보기', action: () => api.shell.showItem(n.path) });
          items.push({ label: '삭제', danger: true, action: () => deletePath(n.path) });
          showContextMenu(e.clientX, e.clientY, items);
        };
      }
    };
    walk(state.tree, 0);
    host.appendChild(frag);
  }

  function onTreeFileClick(p) {
    if (BINARY.test(p)) {
      if (PREVIEWABLE.test(p)) setPreview(p, false);
      else toast('이 파일은 편집기에서 열 수 없습니다.');
      return;
    }
    openFile(p);
  }

  async function newFile(dir = '') {
    if (!state.project) return toast('먼저 프로젝트를 여세요.');
    const name = await askText('새 파일 이름', dir ? dir + '/' : '');
    if (!name) return;
    try {
      const rel = await api.fs.createFile(name);
      await refreshTree();
      await openFile(rel);
    } catch (err) { toast(cleanErr(err), 'error'); }
  }

  async function newFolder(dir = '') {
    if (!state.project) return toast('먼저 프로젝트를 여세요.');
    const name = await askText('새 폴더 이름', dir ? dir + '/' : '');
    if (!name) return;
    try {
      const rel = await api.fs.createFolder(name);
      state.expanded.add(rel);
      await refreshTree();
    } catch (err) { toast(cleanErr(err), 'error'); }
  }

  async function deletePath(p) {
    try {
      const ok = await api.fs.remove(p);
      if (!ok) return;
      for (const key of [...state.openFiles.keys()]) {
        if (key === p || key.startsWith(p + '/')) closeTab(key, true);
      }
      await refreshTree();
      toast('삭제했습니다. 변경 기록에서 되돌릴 수 있습니다.');
    } catch (err) { toast(cleanErr(err), 'error'); }
  }

  function cleanErr(err) {
    return String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  // ───────────────────────── 편집기 / 탭 ─────────────────────────
  async function openFile(p) {
    if (!editor) return;
    let f = state.openFiles.get(p);
    if (!f) {
      let content;
      try {
        content = await api.fs.read(p);
      } catch (err) {
        toast(cleanErr(err), 'error');
        return;
      }
      const uri = monaco.Uri.parse('file:///' + encodeURI(p));
      const existing = monaco.editor.getModel(uri);
      if (existing) existing.dispose();
      const model = monaco.editor.createModel(content, LANG[ext(p)] || 'plaintext', uri);
      f = { model, dirty: false, savedVersion: model.getAlternativeVersionId(), viewState: null };
      model.onDidChangeContent(() => {
        const dirty = model.getAlternativeVersionId() !== f.savedVersion;
        if (dirty !== f.dirty) { f.dirty = dirty; renderTabs(); }
      });
      state.openFiles.set(p, f);
    }
    activate(p);
  }

  function activate(p) {
    const prev = state.openFiles.get(state.activePath);
    if (prev && editor.getModel() === prev.model) prev.viewState = editor.saveViewState();
    state.activePath = p;
    const f = state.openFiles.get(p);
    editor.setModel(f ? f.model : null);
    if (f && f.viewState) editor.restoreViewState(f.viewState);
    if (f) editor.focus();
    renderTabs();
    document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
    const item = document.querySelector(`.tree-item[data-path="${CSS.escape(p || '')}"]`);
    if (item) item.classList.add('active');
    // 상위 폴더 펼치기
    if (p && p.includes('/')) {
      const parts = p.split('/');
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!state.expanded.has(d)) { state.expanded.add(d); changed = true; }
      }
      if (changed) renderTree();
    }
    if (p && state.previewAuto && PREVIEWABLE.test(p)) setPreview(p, true);
    updateEditorVisibility();
    $('#status-right').textContent = p ? `${p} · ${(LANG[ext(p)] || 'plaintext')}` : '';
  }

  function updateEditorVisibility() {
    $('#editor-empty').hidden = !state.project || !!state.activePath;
  }

  function renderTabs() {
    const host = $('#tabs');
    host.innerHTML = '';
    for (const [p, f] of state.openFiles) {
      const t = document.createElement('div');
      t.className = 'tab' + (p === state.activePath ? ' active' : '') + (f.dirty ? ' dirty' : '');
      t.title = p;
      t.innerHTML = `<span>${esc(p.split('/').pop())}</span><button class="tab-x" title="닫기">${ICON.x}</button>`;
      t.onclick = () => activate(p);
      t.onauxclick = (e) => { if (e.button === 1) closeTab(p); };
      t.querySelector('.tab-x').onclick = (e) => { e.stopPropagation(); closeTab(p); };
      host.appendChild(t);
    }
  }

  async function closeTab(p, force = false) {
    const f = state.openFiles.get(p);
    if (!f) return;
    if (f.dirty && !force && !confirm(`'${p}'의 변경 내용이 저장되지 않았습니다. 닫을까요?`)) return;
    f.model.dispose();
    state.openFiles.delete(p);
    if (state.activePath === p) {
      const next = [...state.openFiles.keys()].pop() || null;
      if (next) activate(next);
      else { state.activePath = null; editor.setModel(null); renderTabs(); updateEditorVisibility(); }
    } else renderTabs();
  }

  async function saveActive() {
    const p = state.activePath;
    const f = state.openFiles.get(p);
    if (!f) return;
    try {
      await api.fs.write(p, f.model.getValue());
      f.savedVersion = f.model.getAlternativeVersionId();
      f.dirty = false;
      renderTabs();
      status(`저장됨: ${p}`);
    } catch (err) {
      toast('저장 실패: ' + cleanErr(err), 'error');
    }
  }

  // 디스크에서 바뀐 파일을 편집기에 반영
  async function syncOpenFile(p) {
    const f = state.openFiles.get(p);
    if (!f) return;
    let content;
    try {
      content = await api.fs.read(p);
    } catch (_) {
      return; // 삭제됨
    }
    if (content === f.model.getValue()) return;
    if (f.dirty) {
      toast(`'${p}' 파일이 디스크에서 바뀌었습니다. 편집 중인 내용은 그대로 둡니다.`);
      return;
    }
    const isActive = state.activePath === p && editor.getModel() === f.model;
    const view = isActive ? editor.saveViewState() : null;
    f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: content }], () => null);
    f.savedVersion = f.model.getAlternativeVersionId();
    f.dirty = false;
    if (view) editor.restoreViewState(view);
    renderTabs();
  }

  // ───────────────────────── 미리보기 ─────────────────────────
  function pickDefaultPreview() {
    const files = flatFiles();
    const html = files.filter((p) => /\.html?$/i.test(p));
    const md = files.filter((p) => /\.(md|markdown)$/i.test(p));
    return files.find((p) => /^index\.html?$/i.test(p)) || html.sort((a, b) => a.split('/').length - b.split('/').length)[0] ||
      files.find((p) => /^readme\.md$/i.test(p)) || md[0] || files.find((p) => PREVIEWABLE.test(p)) || null;
  }

  function setPreview(p, auto) {
    if (!auto) state.previewAuto = /\.html?$/i.test(p) || /\.(md|markdown)$/i.test(p);
    if (state.previewPath === p) return;
    state.previewPath = p;
    updatePreviewSelect();
    reloadPreview();
  }

  function updatePreviewSelect() {
    const sel = $('#preview-select');
    const files = flatFiles().filter((p) => PREVIEWABLE.test(p));
    if (state.previewPath && !files.includes(state.previewPath)) {
      state.previewPath = null;
    }
    if (!state.previewPath && state.project) state.previewPath = pickDefaultPreview();
    sel.innerHTML = files.map((p) => `<option value="${esc(p)}"${p === state.previewPath ? ' selected' : ''}>${esc(p)}</option>`).join('');
    sel.disabled = !files.length;
  }
  $('#preview-select').addEventListener('change', (e) => setPreview(e.target.value, false));

  function previewUrl(p) {
    const theme = effectiveDark() ? 'dark' : 'light';
    return `${state.previewBase}/${p.split('/').map(encodeURIComponent).join('/')}?theme=${theme}&_=${Date.now()}`;
  }

  let lastPreviewKey = '';
  function reloadPreview() {
    const frame = $('#preview-frame');
    const empty = $('#preview-empty');
    if (!state.project || !state.previewPath || !state.previewBase) {
      empty.hidden = false;
      empty.innerHTML = state.project
        ? '미리볼 파일이 없습니다.<br><span class="muted">HTML, Markdown, 이미지, PDF 파일을 만들면 여기에 표시됩니다.</span>'
        : '프로젝트를 열면 결과물이 여기에 실시간으로 표시됩니다.';
      if (frame.getAttribute('src')) frame.removeAttribute('src');
      lastPreviewKey = '';
      return;
    }
    empty.hidden = true;
    const key = state.previewPath;
    // 같은 HTML 페이지면 스크롤 위치를 유지하려고 시도 (동일 출처가 아니므로 해시 없이 재로딩)
    frame.src = previewUrl(state.previewPath);
    lastPreviewKey = key;
    $('#btn-select-mode').disabled = !/\.(html?|md|markdown)$/i.test(state.previewPath);
  }

  let previewTimer = null;
  function reloadPreviewSoon() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(reloadPreview, 180);
  }

  function postToPreview(msg) {
    const w = $('#preview-frame').contentWindow;
    if (w) w.postMessage({ source: 'codeai-host', ...msg }, '*');
  }

  function setSelectMode(on) {
    state.selectMode = on;
    $('#btn-select-mode').classList.toggle('on', on);
    document.querySelector('.preview-body').classList.toggle('select-on', on);
    postToPreview({ type: 'select-mode', on });
    status(on ? '선택 모드: 미리보기에서 수정할 요소를 클릭하세요.' : '준비');
  }

  window.addEventListener('message', (e) => {
    const frame = $('#preview-frame');
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.source !== 'codeai-preview') return;
    if (d.type === 'ready') {
      if (state.selectMode) postToPreview({ type: 'select-mode', on: true });
    } else if (d.type === 'selected') {
      state.selection = { selector: String(d.selector || ''), html: String(d.html || ''), file: state.previewPath };
      renderSelectionChip();
      $('#chat-text').focus();
      status(`선택됨: ${state.selection.selector}`);
    }
  });

  function renderSelectionChip() {
    const chip = $('#selection-chip');
    if (!state.selection) { chip.hidden = true; return; }
    chip.hidden = false;
    $('#selection-chip-text').textContent = `선택: ${state.selection.selector} · ${state.selection.file}`;
    chip.title = state.selection.html.slice(0, 500);
  }

  function clearSelection(silent) {
    state.selection = null;
    renderSelectionChip();
    if (!silent) postToPreview({ type: 'clear-selection' });
  }
  $('#selection-chip-remove').onclick = () => clearSelection(false);

  // ───────────────────────── 채팅 ─────────────────────────
  function persistChat() {
    if (state.project) store('codeai.chat.' + state.project.root, state.messages.slice(-60));
  }

  // 답변 텍스트 렌더링: ```file:경로``` 블록은 접어서 표시, 일반 코드블록은 <pre>
  function renderAnswer(text, streaming) {
    let html = '';
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      html += inlineFmt(text.slice(last, m.index));
      const info = m[1].trim();
      const body = m[2];
      const closed = m[3] === '```';
      if (/^file:/i.test(info)) {
        const fp = info.slice(5).trim();
        html += `<details class="file-block"><summary>📄 ${esc(fp)}${closed ? '' : ' <span class="muted">작성 중…</span>'}</summary><pre><code>${esc(body)}</code></pre></details>`;
      } else {
        html += `<pre><code>${esc(body)}</code></pre>`;
      }
      last = re.lastIndex;
      if (!closed) break;
    }
    if (last < text.length) html += inlineFmt(text.slice(last));
    if (streaming) html += '<span class="typing"><i></i><i></i><i></i></span>';
    return html;
  }
  function inlineFmt(s) {
    return esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }

  function msgEl(m, idx) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role + (m.error ? ' error' : '');
    el.dataset.idx = idx;
    const who = m.role === 'user' ? '나' : m.error ? '오류' : 'Code AI';
    let inner = `<span class="who">${who}</span>`;
    if (m.role === 'user') {
      if (m.selection) inner += `<span class="sel-ref">🎯 ${esc(m.selection.selector)} · ${esc(m.selection.file || '')}</span>`;
      inner += `<div class="bubble">${esc(m.content)}</div>`;
    } else {
      inner += `<div class="bubble">${m.error ? esc(m.content) : renderAnswer(m.content || '', m.streaming)}</div>`;
      if (m.files && m.files.length) {
        inner += '<div class="file-events">' + m.files.map((f) =>
          `<button class="file-ev${f.ok ? '' : ' fail'}" data-path="${esc(f.path)}" title="${esc(f.ok ? '편집기에서 열기' : (f.message || '실패'))}">${f.ok ? ICON.check : ICON.x}${esc(f.path)}</button>`).join('') + '</div>';
      }
      if (m.snapshotId) {
        inner += `<div class="msg-actions"><button class="btn small" data-undo="${esc(m.snapshotId)}">이 변경 되돌리기</button></div>`;
      }
    }
    el.innerHTML = inner;
    el.querySelectorAll('.file-ev:not(.fail)').forEach((b) => { b.onclick = () => onTreeFileClick(b.dataset.path); });
    const undo = el.querySelector('[data-undo]');
    if (undo) undo.onclick = () => restoreSnapshot(undo.dataset.undo);
    return el;
  }

  function renderChat() {
    const log = $('#chat-log');
    log.innerHTML = '';
    if (!state.messages.length) {
      const sugg = state.project
        ? ['이 페이지를 더 세련되게 다듬어줘', '상단에 고정 내비게이션 바를 추가해줘', '모바일에서도 보기 좋게 반응형으로 만들어줘', '다크 모드 색상으로 바꿔줘']
        : [];
      log.innerHTML = `<div class="chat-empty"><h3>무엇을 만들어 볼까요?</h3>
        <div>${state.project ? '원하는 것을 한국어로 설명하면 AI가 파일을 만들고 고칩니다.<br>미리보기의 <b>선택 모드</b>로 요소를 콕 집어 요청할 수도 있어요.' : '먼저 새 프로젝트를 만들거나 폴더를 여세요.'}</div>
        <div class="suggestions">${sugg.map((s) => `<button class="suggestion">${esc(s)}</button>`).join('')}</div></div>`;
      log.querySelectorAll('.suggestion').forEach((b) => { b.onclick = () => { $('#chat-text').value = b.textContent; $('#chat-text').focus(); }; });
      return;
    }
    state.messages.forEach((m, i) => log.appendChild(msgEl(m, i)));
    log.scrollTop = log.scrollHeight;
  }

  function updateMsg(idx) {
    const log = $('#chat-log');
    const old = log.querySelector(`.msg[data-idx="${idx}"]`);
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const el = msgEl(state.messages[idx], idx);
    if (old) old.replaceWith(el); else log.appendChild(el);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function setStreaming(on) {
    $('#btn-send').classList.toggle('streaming', on);
    $('#btn-send').title = on ? '중지' : '보내기';
  }

  async function sendChat() {
    if (state.chatId) {
      api.chat.abort(state.chatId);
      return;
    }
    const input = $('#chat-text');
    const text = input.value.trim();
    if (!text) return;
    if (!state.project) {
      toast('먼저 새 프로젝트를 만들거나 폴더를 여세요.');
      return;
    }
    // 저장하지 않은 편집 내용이 있으면 먼저 저장 (AI가 최신 내용을 보도록)
    for (const [p, f] of state.openFiles) {
      if (f.dirty) {
        await api.fs.write(p, f.model.getValue());
        f.savedVersion = f.model.getAlternativeVersionId();
        f.dirty = false;
      }
    }
    renderTabs();

    const selection = state.selection;
    const userMsg = { role: 'user', content: text };
    if (selection) userMsg.selection = { selector: selection.selector, file: selection.file };
    state.messages.push(userMsg);
    const history = state.messages
      .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.length > 6000 ? m.content.slice(0, 6000) + '\n…(생략)' : m.content }));
    const reply = { role: 'assistant', content: '', streaming: true, files: [] };
    state.messages.push(reply);
    const idx = state.messages.length - 1;
    if (state.messages.length === 2) renderChat(); else { updateMsg(idx - 1); updateMsg(idx); }
    input.value = '';
    autoGrow();
    clearSelection(false);
    if (state.selectMode) setSelectMode(false);

    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6);
    state.chatId = id;
    state.chatIdx = idx;
    setStreaming(true);
    status('AI가 응답하는 중…');
    await api.chat.send(id, {
      messages: history,
      selection: selection || undefined,
      activeFile: state.activePath,
      prompt: text
    });
  }

  let renderPending = false;
  api.chat.onEvent(async (ev) => {
    if (ev.id !== state.chatId) return;
    const idx = state.chatIdx;
    const m = state.messages[idx];
    if (!m) return;
    if (ev.type === 'delta') {
      m.content += ev.text;
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => { renderPending = false; updateMsg(idx); });
      }
    } else if (ev.type === 'file') {
      m.files.push({ path: ev.path, ok: ev.ok, message: ev.message });
      updateMsg(idx);
      if (ev.ok) {
        await syncOpenFile(ev.path);
        if (!state.previewPath && PREVIEWABLE.test(ev.path)) setPreview(ev.path, true);
      } else {
        toast(`파일 적용 실패: ${ev.path} — ${ev.message || ''}`, 'error', 4000);
      }
    } else if (ev.type === 'error') {
      m.streaming = false;
      if (!m.content) {
        m.content = ev.message;
        m.error = !ev.aborted;
      } else {
        m.content += `\n\n⚠️ ${ev.message}`;
      }
      if (ev.unreachable) setServerState({ ok: false, message: ev.message });
      finishChat(idx, ev.aborted ? '중지됨' : '오류');
    } else if (ev.type === 'done') {
      m.streaming = false;
      if (ev.snapshotId) m.snapshotId = ev.snapshotId;
      if (!m.content && !m.files.length) m.content = '(빈 응답)';
      finishChat(idx, ev.applied && ev.applied.length ? `완료 · 파일 ${ev.applied.length}개 적용` : '완료');
      if (ev.applied && ev.applied.length) {
        await refreshTree();
        reloadPreviewSoon();
      }
    }
  });

  function finishChat(idx, msg) {
    state.chatId = null;
    setStreaming(false);
    updateMsg(idx);
    persistChat();
    status(msg);
  }

  function autoGrow() {
    const t = $('#chat-text');
    t.style.height = 'auto';
    t.style.height = Math.min(200, Math.max(40, t.scrollHeight)) + 'px';
  }
  $('#chat-text').addEventListener('input', autoGrow);
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });
  $('#btn-send').onclick = sendChat;
  $('#btn-clear-chat').onclick = () => {
    if (state.chatId) return;
    if (state.messages.length && !confirm('대화 내용을 지울까요? (파일과 변경 기록은 유지됩니다)')) return;
    state.messages = [];
    persistChat();
    renderChat();
  };

  // ───────────────────────── 변경 기록 ─────────────────────────
  async function showHistory() {
    if (!state.project) return toast('먼저 프로젝트를 여세요.');
    openModal('#modal-history');
    const host = $('#history-list');
    host.innerHTML = '<div class="history-empty"><span class="spinner"></span></div>';
    const items = await api.history.list();
    if (!items.length) {
      host.innerHTML = '<div class="history-empty">아직 변경 기록이 없습니다.<br>AI가 파일을 수정하면 자동으로 저장됩니다.</div>';
      return;
    }
    host.innerHTML = '';
    const fmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' });
    const kinds = { ai: 'AI 수정', restore: '되돌리기', delete: '삭제' };
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.innerHTML = `<div class="history-main">
          <div class="history-time"><span class="history-kind ${esc(it.kind || 'ai')}">${kinds[it.kind] || 'AI 수정'}</span>${esc(fmt.format(new Date(it.time)))}</div>
          <div class="history-prompt">${esc(it.prompt || '(프롬프트 없음)')}</div>
          <div class="history-files">${it.files.map((f) => esc(f.path) + (f.existed ? '' : ' (새 파일)')).join(', ')}</div>
        </div>
        <button class="btn small">되돌리기</button>`;
      el.querySelector('button').onclick = () => restoreSnapshot(it.id);
      host.appendChild(el);
    }
  }

  async function restoreSnapshot(id) {
    if (!confirm('이 변경 이전 상태로 파일을 되돌릴까요?\n(현재 상태도 변경 기록에 저장되므로 다시 되돌릴 수 있습니다)')) return;
    try {
      const r = await api.history.restore(id);
      for (const p of r.changed) await syncOpenFile(p);
      await refreshTree();
      for (const p of r.changed) if (!flatFiles().includes(p) && state.openFiles.has(p)) closeTab(p, true);
      reloadPreviewSoon();
      toast(`되돌렸습니다 (파일 ${r.changed.length}개)`);
      if (!$('#modal-history').hidden) showHistory();
    } catch (err) {
      toast('되돌리기 실패: ' + cleanErr(err), 'error');
    }
  }

  // ───────────────────────── 배포 ─────────────────────────
  async function deploy() {
    if (!state.project) return toast('먼저 프로젝트를 여세요.');
    openModal('#modal-deploy');
    $('#deploy-progress').hidden = false;
    $('#deploy-result').hidden = true;
    $('#deploy-error').hidden = true;
    $('#btn-deploy').disabled = true;
    try {
      const r = await api.deploy();
      $('#deploy-url').value = r.url;
      $('#deploy-meta').textContent = `파일 ${r.count}개 업로드됨`;
      $('#deploy-result').hidden = false;
    } catch (err) {
      $('#deploy-error').textContent = '배포 실패: ' + cleanErr(err);
      $('#deploy-error').hidden = false;
    } finally {
      $('#deploy-progress').hidden = true;
      $('#btn-deploy').disabled = false;
    }
  }
  $('#deploy-copy').onclick = async () => {
    await api.clipboard.write($('#deploy-url').value);
    toast('링크를 복사했습니다.');
  };
  $('#deploy-open').onclick = () => api.shell.openExternal($('#deploy-url').value);

  // ───────────────────────── 새 프로젝트 ─────────────────────────
  let npTemplate = null;
  async function showNewProject() {
    $('#np-error').hidden = true;
    if (!$('#np-dir').value) $('#np-dir').value = await api.project.defaultDir();
    const list = await api.templates.list();
    const icons = { landing: '🚀', portfolio: '🎨', shop: '🛍️', report: '📄' };
    const cards = [{ id: null, name: '빈 프로젝트', description: '빈 HTML 페이지 하나로 시작합니다.' }, ...list];
    const host = $('#np-templates');
    host.innerHTML = '';
    for (const t of cards) {
      const b = document.createElement('button');
      b.className = 'template-card' + (t.id === npTemplate ? ' selected' : '');
      b.dataset.id = t.id || 'blank';
      b.innerHTML = `<div class="template-thumb">${t.id ? icons[t.id] || '📁' : '＋'}</div>
        <div class="template-info"><b>${esc(t.name)}</b><small>${esc(t.description)}</small></div>`;
      b.onclick = () => {
        npTemplate = t.id;
        host.querySelectorAll('.template-card').forEach((c) => c.classList.toggle('selected', c === b));
        const nm = $('#np-name');
        if (!nm.dataset.touched) nm.value = t.id ? `my-${t.id}` : 'my-site';
      };
      host.appendChild(b);
    }
    if (!list.length) {
      const p = document.createElement('small');
      p.className = 'muted';
      p.textContent = '템플릿 폴더를 찾지 못했습니다.';
      host.appendChild(p);
    }
    openModal('#modal-new');
    $('#np-name').focus();
    $('#np-name').select();
  }
  $('#np-name').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#np-choose').onclick = async () => {
    const d = await api.project.chooseDir();
    if (d) $('#np-dir').value = d;
  };
  $('#np-create').onclick = async () => {
    $('#np-error').hidden = true;
    $('#np-create').disabled = true;
    try {
      const info = await api.project.create({ parentDir: $('#np-dir').value, name: $('#np-name').value, template: npTemplate });
      closeModal('#modal-new');
      delete $('#np-name').dataset.touched;
      await onProjectChanged(info);
      toast(`'${info.name}' 프로젝트를 만들었습니다.`);
    } catch (err) {
      $('#np-error').textContent = cleanErr(err);
      $('#np-error').hidden = false;
    } finally {
      $('#np-create').disabled = false;
    }
  };

  // ───────────────────────── 설정 ─────────────────────────
  let setTheme = 'system';
  function showSettings() {
    $('#set-server').value = state.settings.serverUrl;
    $('#set-version').textContent = state.settings.version;
    $('#set-test-result').textContent = '';
    setTheme = state.settings.theme;
    document.querySelectorAll('#set-theme button').forEach((b) => b.classList.toggle('active', b.dataset.value === setTheme));
    openModal('#modal-settings');
  }
  document.querySelectorAll('#set-theme button').forEach((b) => {
    b.onclick = () => {
      setTheme = b.dataset.value;
      document.querySelectorAll('#set-theme button').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  $('#set-test').onclick = async () => {
    const prevUrl = state.settings.serverUrl;
    $('#set-test-result').textContent = '확인 중…';
    state.settings = await api.settings.set({ serverUrl: $('#set-server').value });
    const h = await api.server.health();
    $('#set-test-result').textContent = h.ok ? `연결됨 ✓  모델: ${h.model || '-'} · 서버 버전 ${h.version || '-'}` : h.message;
    $('#set-test-result').style.color = h.ok ? 'var(--ok)' : 'var(--danger)';
    state.settings = await api.settings.set({ serverUrl: prevUrl });
  };
  $('#set-save').onclick = async () => {
    state.settings = await api.settings.set({ serverUrl: $('#set-server').value, theme: setTheme });
    closeModal('#modal-settings');
    applyTheme();
    checkServer();
    checkUpdates();
  };

  // ───────────────────────── 서버 상태 / 업데이트 ─────────────────────────
  let bannerDismissed = false;
  function setServerState(h) {
    state.serverOk = h.ok;
    const el = $('#server-status');
    el.className = 'server-status ' + (h.ok ? 'ok' : 'bad');
    $('#server-status-text').textContent = h.ok ? 'AI 연결됨' : 'AI 서버 연결 안 됨';
    el.title = h.ok ? `AI 서버 연결됨 · ${h.url || ''} · 모델: ${h.model || '-'}` : h.message || 'AI 서버에 연결할 수 없습니다.';
    if (h.ok) {
      $('#server-banner').hidden = true;
      bannerDismissed = false;
    } else if (!bannerDismissed) {
      $('#server-banner-text').textContent = h.message || 'AI 서버에 연결할 수 없습니다.';
      $('#server-banner').hidden = false;
    }
  }

  async function checkServer() {
    const h = await api.server.health();
    setServerState(h);
    return h;
  }
  $('#server-status').onclick = checkServer;
  $('#btn-server-retry').onclick = async () => {
    const h = await checkServer();
    toast(h.ok ? 'AI 서버에 연결되었습니다.' : '여전히 연결할 수 없습니다.', h.ok ? '' : 'error');
  };
  $('#btn-server-settings').onclick = showSettings;
  $('#btn-server-close').onclick = () => { bannerDismissed = true; $('#server-banner').hidden = true; };

  async function checkUpdates(manual) {
    const u = await api.updates.check();
    if (u && u.available) {
      state.update = u;
      $('#update-text').textContent = `새 버전 ${u.version} 업데이트가 있습니다` + (u.notes ? ` — ${u.notes}` : '');
      $('#update-banner').hidden = false;
      $('#btn-update-download').disabled = !u.url;
    } else if (manual) {
      toast(`최신 버전입니다 (${state.settings.version}).`);
    }
  }
  $('#btn-update-download').onclick = () => { if (state.update && state.update.url) api.shell.openExternal(state.update.url); };
  $('#btn-update-close').onclick = () => { $('#update-banner').hidden = true; };

  // ───────────────────────── 버튼 / 메뉴 연결 ─────────────────────────
  $('#btn-new-project').onclick = showNewProject;
  $('#welcome-new').onclick = showNewProject;
  $('#btn-open-folder').onclick = openFolder;
  $('#welcome-open').onclick = openFolder;
  $('#btn-history').onclick = showHistory;
  $('#btn-deploy').onclick = deploy;
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-settings').onclick = showSettings;
  $('#btn-new-file').onclick = () => newFile('');
  $('#btn-new-folder').onclick = () => newFolder('');
  $('#btn-refresh-tree').onclick = refreshTree;
  $('#btn-refresh-preview').onclick = reloadPreview;
  $('#btn-select-mode').onclick = () => setSelectMode(!state.selectMode);
  $('#btn-open-browser').onclick = () => { if (state.previewPath) api.shell.openExternal(previewUrl(state.previewPath)); };

  api.onMenu((name) => {
    const actions = {
      'new-project': showNewProject,
      'open-folder': openFolder,
      'new-file': () => newFile(''),
      save: saveActive,
      settings: showSettings,
      'toggle-theme': toggleTheme,
      'refresh-preview': reloadPreview,
      history: showHistory,
      'check-updates': () => checkUpdates(true)
    };
    if (actions[name]) actions[name]();
  });

  // 에디터 밖에서 Ctrl+S
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey) {
      e.preventDefault();
    }
  });

  // 파일 변경 감시 → 트리/편집기/미리보기 갱신
  api.fs.onChanged(async ({ paths }) => {
    refreshTreeSoon();
    for (const p of paths) if (state.openFiles.has(p)) await syncOpenFile(p);
    reloadPreviewSoon();
  });

  window.addEventListener('beforeunload', (e) => {
    if ([...state.openFiles.values()].some((f) => f.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ───────────────────────── 시작 ─────────────────────────
  async function init() {
    state.settings = await api.settings.get();
    applyTheme();
    state.previewBase = await api.preview.base();
    try {
      monaco = await loadMonaco();
      initEditor();
    } catch (err) {
      console.error('Monaco 로드 실패', err);
      toast('편집기를 불러오지 못했습니다.', 'error');
    }
    await onProjectChanged(await api.project.current());
    window.__codeaiReady = true;
    checkServer();
    checkUpdates();
    setInterval(checkServer, 30000);
  }

  init();
})();
