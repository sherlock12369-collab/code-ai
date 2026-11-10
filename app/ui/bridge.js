// window.codeai — 화면(app.js)이 쓰는 API.
// 1.x(Electron)의 preload.js와 같은 모양이라 app.js는 거의 그대로 쓴다.
// 파일·미리보기·기록은 Rust 명령(src-tauri/src/lib.rs), AI 호출은 ai.js가 맡는다.
(function () {
  'use strict';
  const T = window.__TAURI__;
  const AI = window.CodeAIEngine;
  const invoke = T.core.invoke;
  const listen = (event, cb) => T.event.listen(event, (e) => cb(e.payload));
  const httpFetch = T.http.fetch;
  const IN_APP = '앱에 내장';

  const openUrl = (url) => (/^https?:\/\//i.test(String(url)) ? T.opener.openUrl(String(url)) : Promise.resolve(false));

  // ───────── 설정 ─────────
  // 2.0에는 AI 서버가 없다. 예전 화면 코드가 기대하는 값(serverMode 등)을 채워 준다.
  const withCompat = (s) => ({ ...s, serverMode: 'embedded', customServerUrl: '', serverUrl: IN_APP, embedded: { running: true, url: IN_APP } });
  const getSettings = async () => withCompat(await invoke('settings_get'));

  function applyWindowTheme(theme) {
    try { T.window.getCurrentWindow().setTheme(theme === 'system' ? null : theme); } catch (_) { /* 지원 안 함 */ }
  }

  async function setSettings(partial) {
    partial = partial || {};
    const patch = {};
    if (typeof partial.deployServerUrl === 'string') patch.deployServerUrl = partial.deployServerUrl;
    if (partial.model === null || AI.isModelId(partial.model)) patch.model = partial.model;
    if (typeof partial.setupDone === 'boolean') patch.setupDone = partial.setupDone;
    if (['system', 'light', 'dark'].includes(partial.theme)) {
      patch.theme = partial.theme;
      applyWindowTheme(partial.theme);
    }
    return withCompat(await invoke('settings_set', { partial: patch }));
  }

  async function health() {
    const s = await getSettings();
    const key = await invoke('api_key_get');
    return { ok: true, hasApiKey: !!key, model: AI.modelFor(key, s.model), url: IN_APP, embedded: true, version: s.version };
  }

  async function listModels() {
    const s = await getSettings();
    const key = await invoke('api_key_get');
    const provider = key ? AI.providerOfKey(key) : 'gemini';
    const models = AI.MODELS.filter((m) => m.provider === provider).map((m) => ({ ...m }));
    const selected = s.model && AI.providerOfModel(s.model) === provider ? s.model : null;
    return { models, source: 'static', selected, defaultModel: AI.DEFAULT_MODELS[provider], provider };
  }

  async function setApiKey(key) {
    key = String(key || '').trim();
    const r = await AI.checkKey({ fetch: httpFetch, key });
    if (!r.ok) return { ok: false, error: r.error };
    const settings = withCompat(await invoke('api_key_store', { key }));
    return { ok: true, settings };
  }

  // ───────── 채팅 ─────────
  const chatListeners = new Set();
  const activeChats = new Map();
  const emitChat = (ev) => chatListeners.forEach((cb) => { try { cb(ev); } catch (err) { console.error(err); } });

  async function runChat(id, payload) {
    const controller = new AbortController();
    activeChats.set(id, controller);
    const emit = (ev) => emitChat({ id, ...ev });
    const applied = [];
    try {
      const key = await invoke('api_key_get');
      if (!key) {
        emit({ type: 'error', message: 'API 키가 없습니다. 설정에서 무료 Gemini 키(또는 Claude 키)를 입력해 주세요.', needsKey: true });
        return;
      }
      const settings = await invoke('settings_get');
      const project = await invoke('project_current');
      const priority = [payload.activeFile, payload.selection && payload.selection.file].filter(Boolean);
      const files = project ? await invoke('collect_files', { priority, deploy: false }) : [];

      const r = await AI.chat({
        fetch: httpFetch,
        key,
        model: settings.model,
        messages: payload.messages,
        files,
        selection: payload.selection,
        signal: controller.signal,
        onText: (text) => emit({ type: 'delta', text }),
        onNotice: (text) => emit({ type: 'delta', text })
      });
      if (r.error) {
        emit({ type: 'error', message: r.error, needsKey: r.needsKey || /API 키/.test(r.error) || undefined });
        return;
      }
      if (r.maxTokens) emit({ type: 'delta', text: '\n\n(답변이 너무 길어 중간에 끊겼습니다. 끝나지 않은 파일은 저장되지 않았습니다.)' });

      for (const f of r.files) {
        if (!project) {
          emit({ type: 'file', path: f.path, ok: false, message: '프로젝트가 열려 있지 않아 파일을 저장하지 못했습니다.' });
          continue;
        }
        try {
          const rel = await invoke('ai_write_file', { chatId: id, root: project.root, prompt: payload.prompt || '', path: f.path, content: f.content });
          applied.push(rel);
          emit({ type: 'file', path: rel, ok: true });
        } catch (err) {
          emit({ type: 'file', path: f.path, ok: false, message: String(err) });
        }
      }
      const snapshotId = await invoke('ai_finish', { chatId: id });
      emit({ type: 'done', applied, snapshotId });
    } catch (err) {
      if (err && err.name === 'AbortError') emit({ type: 'error', message: '요청을 중지했습니다.', aborted: true });
      else emit({ type: 'error', message: (err && err.message) || String(err) });
      invoke('ai_finish', { chatId: id }).catch(() => {});
    } finally {
      activeChats.delete(id);
    }
  }

  // ───────── 배포 ─────────
  async function deploy() {
    const project = await invoke('project_current');
    if (!project) throw new Error('프로젝트가 열려 있지 않습니다.');
    const files = await invoke('collect_files', { priority: ['index.html'], deploy: true });
    if (!files.length) throw new Error('배포할 파일이 없습니다.');
    const s = await invoke('settings_get');
    if (s.deployServerUrl) {
      try {
        const res = await httpFetch(`${s.deployServerUrl}/api/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: project.name, files }),
          signal: AbortSignal.timeout(90000)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) return { url: data.url, count: files.length };
        if (res.status < 500) throw Object.assign(new Error(`배포 실패 (HTTP ${res.status}) ${data.error || ''}`), { final: true });
      } catch (err) {
        if (err.final) throw err;
        console.warn('[deploy] 공용 배포 서버 실패, 내 PC에 배포', err);
      }
    }
    // 공용 서버에 닿지 않으면 내 PC에 배포 → 이 PC에서만 열리는 링크
    const url = await invoke('deploy_local', { name: project.name, files });
    return { url, count: files.length };
  }

  // ───────── 업데이트 (GitHub 최신 릴리스 확인 → 다운로드 링크) ─────────
  const RELEASES_API = 'https://api.github.com/repos/sherlock12369-collab/code-ai/releases/latest';
  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }
  async function checkUpdates() {
    try {
      const s = await invoke('settings_get');
      const res = await httpFetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { available: false };
      const rel = await res.json();
      // 아직 정식 출시 전인 2.0 알파는 1.x 릴리스를 "새 버전"으로 보지 않는다.
      if (compareVersions(rel.tag_name, s.version) <= 0) return { available: false };
      return { available: true, native: false, version: String(rel.tag_name).replace(/^v/, ''), notes: '', url: rel.html_url };
    } catch (_) {
      return { available: false };
    }
  }

  // ───────── 확대/축소 (메뉴) ─────────
  let zoom = 1;
  function setZoom(z) {
    zoom = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10));
    try { T.webview.getCurrentWebview().setZoom(zoom); } catch (_) { document.body.style.zoom = String(zoom); }
  }
  const ZOOM = { 'zoom-in': () => setZoom(zoom + 0.1), 'zoom-out': () => setZoom(zoom - 0.1), 'zoom-reset': () => setZoom(1) };

  window.codeai = {
    settings: { get: getSettings, set: setSettings },
    preview: { base: () => invoke('preview_base') },
    project: {
      current: () => invoke('project_current'),
      open: async () => {
        const dir = await T.dialog.open({ directory: true, title: '폴더 열기' });
        return dir ? invoke('project_set', { root: dir }) : null;
      },
      close: () => invoke('project_set', { root: null }),
      chooseDir: () => T.dialog.open({ directory: true, title: '프로젝트를 만들 위치 선택' }),
      defaultDir: () => invoke('project_default_dir'),
      create: (opts) => invoke('project_create', { opts: opts || {} })
    },
    templates: { list: () => invoke('templates_list') },
    fs: {
      tree: () => invoke('fs_tree'),
      read: (rel) => invoke('fs_read', { rel }),
      write: (rel, content) => invoke('fs_write', { rel, content: String(content) }),
      createFile: (rel) => invoke('fs_create_file', { rel }),
      createFolder: (rel) => invoke('fs_create_folder', { rel }),
      remove: async (rel) => {
        const ok = await T.dialog.ask(`'${rel}'을(를) 삭제할까요?\n삭제 전 상태는 변경 기록에 저장됩니다.`, {
          title: '삭제 확인', kind: 'warning', okLabel: '삭제', cancelLabel: '취소'
        });
        return ok ? invoke('fs_delete', { rel }) : false;
      },
      exists: (rel) => invoke('fs_exists', { rel }),
      onChanged: (cb) => listen('fs:changed', cb)
    },
    chat: {
      send: (id, payload) => { runChat(id, payload || {}); return Promise.resolve(true); },
      abort: (id) => { const c = activeChats.get(id); if (c) c.abort(); return Promise.resolve(!!c); },
      onEvent: (cb) => { chatListeners.add(cb); return () => chatListeners.delete(cb); }
    },
    history: {
      list: () => invoke('history_list'),
      restore: (id) => invoke('history_restore', { id })
    },
    deploy,
    server: {
      health,
      startEmbedded: async () => ({ running: true, healthy: true, url: IN_APP })
    },
    models: { list: listModels },
    apiKey: {
      set: setApiKey,
      clear: async () => withCompat(await invoke('api_key_store', { key: null })),
      openConsole: (provider) => openUrl(AI.KEY_CONSOLE_URLS[provider] || AI.KEY_CONSOLE_URLS.gemini)
    },
    onSettingsChanged: (cb) => listen('settings:changed', (s) => cb(withCompat(s))),
    updates: {
      check: checkUpdates,
      state: async () => ({ status: 'idle' }),
      install: async () => false,
      onState: () => () => {}
    },
    shell: {
      openExternal: openUrl,
      showItem: async (rel) => T.opener.revealItemInDir(await invoke('reveal_path', { rel: rel || null }))
    },
    clipboard: { write: (text) => T.clipboardManager.writeText(String(text)) },
    onMenu: (cb) => listen('menu', (name) => (ZOOM[name] ? ZOOM[name]() : cb(name))),
    onThemeUpdated: (cb) => {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', () => cb({ dark: mq.matches }));
    }
  };

  // 시작할 때 저장된 테마를 창에도 적용
  invoke('settings_get').then((s) => applyWindowTheme(s.theme)).catch(() => {});
})();
