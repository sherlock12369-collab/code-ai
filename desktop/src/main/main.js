'use strict';
// Code AI 데스크톱 — 메인 프로세스

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { PreviewServer } = require('./server');
const history = require('./history');

const IS_SMOKE = process.argv.includes('--smoke-test');
const DEFAULT_SERVER = 'http://localhost:8787';

// ───────────────────────── 설정 ─────────────────────────
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { serverUrl: DEFAULT_SERVER, theme: 'system', lastProject: null };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (_) { /* 기본값 사용 */ }
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('설정 저장 실패', err);
  }
}

function serverUrl() {
  return String(settings.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
}

// ───────────────────────── 상태 ─────────────────────────
let win = null;
const preview = new PreviewServer();
let projectRoot = null;
let watcher = null;
const IGNORED_DIRS = new Set(['.codeai', '.git', 'node_modules', '.DS_Store']);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toRel(abs) {
  return path.relative(projectRoot, abs).split(path.sep).join('/');
}

// 프로젝트 폴더 밖으로 나가는 경로를 차단한다.
function safeResolve(rel) {
  if (!projectRoot) throw new Error('프로젝트가 열려 있지 않습니다.');
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('잘못된 경로입니다.');
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(projectRoot, clean);
  const root = path.resolve(projectRoot);
  if (abs === root || !abs.startsWith(root + path.sep)) throw new Error(`프로젝트 밖의 경로는 사용할 수 없습니다: ${rel}`);
  const first = clean.split('/')[0];
  if (first === '.codeai') throw new Error('.codeai 폴더는 수정할 수 없습니다.');
  return abs;
}

function isIgnoredRel(rel) {
  return rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

// ───────────────────────── 프로젝트 ─────────────────────────
function setProject(root) {
  projectRoot = root ? path.resolve(root) : null;
  preview.setRoot(projectRoot);
  if (watcher) {
    try { watcher.close(); } catch (_) { /* ignore */ }
    watcher = null;
  }
  if (projectRoot) {
    settings.lastProject = projectRoot;
    saveSettings();
    startWatcher();
    if (win) win.setTitle(`${path.basename(projectRoot)} — Code AI`);
  } else if (win) {
    win.setTitle('Code AI');
  }
  return projectInfo();
}

function projectInfo() {
  return projectRoot ? { root: projectRoot, name: path.basename(projectRoot) } : null;
}

function startWatcher() {
  let pending = new Set();
  let timer = null;
  try {
    watcher = fs.watch(projectRoot, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join('/');
      if (isIgnoredRel(rel)) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...pending];
        pending = new Set();
        send('fs:changed', { paths });
      }, 150);
    });
    watcher.on('error', () => { /* 폴더 삭제 등 */ });
  } catch (err) {
    console.error('파일 감시 실패', err);
  }
}

async function readTree(dir, depth = 0) {
  if (depth > 12) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: toRel(abs), type: 'dir', children: await readTree(abs, depth + 1) });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: toRel(abs), type: 'file' });
    }
  }
  out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'ko')));
  return out;
}

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.markdown',
  '.txt', '.svg', '.xml', '.yml', '.yaml', '.toml', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php',
  '.sh', '.bat', '.ps1', '.vue', '.svelte', '.scss', '.sass', '.less', '.csv', '.ini', '.env', '.sql', '.kt', '.swift']);

function isTextFile(rel) {
  const ext = path.extname(rel).toLowerCase();
  return TEXT_EXT.has(ext) || (!ext && !rel.includes('.'));
}

async function listFilesFlat(dir = projectRoot, acc = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const e of entries) {
    if (IGNORED_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await listFilesFlat(abs, acc);
    else if (e.isFile()) acc.push(toRel(abs));
    if (acc.length > 2000) break;
  }
  return acc;
}

// AI에게 보낼 관련 파일 수집 (텍스트 파일, 용량 제한, 우선순위 파일 먼저)
// 배포 시 data URI(base64)로 보내는 바이너리 파일
const BINARY_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
};

async function collectFiles(priority = [], { maxFiles = 40, maxFileSize = 120 * 1024, maxTotal = 400 * 1024, includeBinary = false } = {}) {
  const all = (await listFilesFlat()).filter((p) => isTextFile(p) || (includeBinary && BINARY_MIME[path.extname(p).toLowerCase()]));
  const pri = priority.filter((p) => p && all.includes(p));
  const rest = all.filter((p) => !pri.includes(p));
  const ordered = [...new Set([...pri, ...rest])];
  const files = [];
  let total = 0;
  for (const rel of ordered) {
    if (files.length >= maxFiles) break;
    try {
      const abs = path.join(projectRoot, rel);
      const st = await fs.promises.stat(abs);
      if (st.size > maxFileSize) continue;
      if (total + st.size > maxTotal) continue;
      const mime = isTextFile(rel) ? null : BINARY_MIME[path.extname(rel).toLowerCase()];
      const content = mime
        ? `data:${mime};base64,${(await fs.promises.readFile(abs)).toString('base64')}`
        : await fs.promises.readFile(abs, 'utf8');
      files.push({ path: rel, content });
      total += st.size;
    } catch (_) { /* skip */ }
  }
  return files;
}

// ───────────────────────── 템플릿 ─────────────────────────
function templatesDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'templates'),
    path.join(__dirname, '..', '..', '..', 'shared', 'templates')
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[candidates.length - 1];
}

async function listTemplates() {
  const dir = templatesDir();
  let names = [];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(dir, d.name, 'template.json'), 'utf8'));
      out.push({ id: d.name, name: meta.name || d.name, description: meta.description || '' });
    } catch (_) { /* template.json 없음 */ }
  }
  const order = ['landing', 'portfolio', 'shop', 'report'];
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : 99);
  out.sort((a, b) => rank(a.id) - rank(b.id));
  return out;
}

async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const e of await fs.promises.readdir(src, { withFileTypes: true })) {
    if (e.name === 'template.json') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.promises.copyFile(s, d);
  }
}

const BLANK_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>새 프로젝트</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; background: #fff; color: #111; }
    h1 { font-size: 2rem; letter-spacing: -0.02em; }
    p { color: #666; }
  </style>
</head>
<body>
  <main>
    <h1>안녕하세요 👋</h1>
    <p>오른쪽 채팅에서 만들고 싶은 것을 말해 보세요.</p>
  </main>
</body>
</html>
`;

// ───────────────────────── 서버 통신 ─────────────────────────
const UNREACHABLE_MSG = 'AI 서버에 연결할 수 없습니다. 서버가 실행 중인지, 설정의 서버 주소가 올바른지 확인해 주세요.';

function friendlyError(err, url) {
  const code = err && (err.cause && err.cause.code || err.code);
  if (err && err.name === 'AbortError') return '요청이 취소되었습니다.';
  if (err && err.name === 'TimeoutError') return `AI 서버 응답 시간이 초과되었습니다. (${url})`;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' || (err && /fetch failed/i.test(err.message))) {
    return `${UNREACHABLE_MSG} (${url})`;
  }
  return (err && err.message) || String(err);
}

async function health() {
  const url = serverUrl();
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, message: `AI 서버 오류 (HTTP ${res.status})`, url };
    const data = await res.json();
    return { ok: !!data.ok, model: data.model, version: data.version, url };
  } catch (err) {
    return { ok: false, message: friendlyError(err, url), url };
  }
}

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
  const url = serverUrl();
  try {
    const res = await fetch(`${url}/updates/latest.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { available: false };
    const data = await res.json();
    const current = app.getVersion();
    if (!data.version || compareVersions(data.version, current) <= 0) return { available: false, current };
    const dl = data.downloads || {};
    const link = process.platform === 'darwin' ? dl.mac : dl.win;
    return { available: true, version: data.version, notes: data.notes || '', url: link || dl.win || dl.mac || null, current };
  } catch (_) {
    return { available: false };
  }
}

// 채팅 스트리밍
const activeChats = new Map();

async function runChat(id, payload) {
  const url = serverUrl();
  const controller = new AbortController();
  activeChats.set(id, controller);
  const root = projectRoot;
  let snapshot = null;
  const applied = [];
  const emit = (ev) => send('chat:event', { id, ...ev });

  try {
    const files = root ? await collectFiles([payload.activeFile, payload.selection && payload.selection.file]) : [];
    const body = { messages: payload.messages, files };
    if (payload.selection) body.selection = payload.selection;

    let res;
    try {
      res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      emit({ type: 'error', message: friendlyError(err, url), unreachable: err.name !== 'AbortError' });
      return;
    }
    if (!res.ok || !res.body) {
      let msg = '';
      try { msg = await res.text(); } catch (_) { /* ignore */ }
      try { msg = JSON.parse(msg).error || JSON.parse(msg).message || msg; } catch (_) { /* text */ }
      emit({ type: 'error', message: `AI 서버 오류 (HTTP ${res.status})${msg ? ': ' + String(msg).slice(0, 300) : ''}` });
      return;
    }

    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;

    const handleEvent = async (data) => {
      let ev;
      try { ev = JSON.parse(data); } catch (_) { return; }
      if (ev.type === 'delta') {
        emit({ type: 'delta', text: String(ev.text || '') });
      } else if (ev.type === 'file') {
        if (!root || root !== projectRoot) {
          emit({ type: 'file', path: ev.path, ok: false, message: '프로젝트가 열려 있지 않아 파일을 저장하지 못했습니다.' });
          return;
        }
        try {
          const abs = safeResolve(ev.path);
          const rel = toRel(abs);
          if (!snapshot) snapshot = new history.Snapshot(root, payload.prompt || '');
          await snapshot.capture(rel);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, String(ev.content ?? ''), 'utf8');
          applied.push(rel);
          emit({ type: 'file', path: rel, ok: true });
        } catch (err) {
          emit({ type: 'file', path: ev.path, ok: false, message: err.message });
        }
      } else if (ev.type === 'done') {
        finished = true;
      } else if (ev.type === 'error') {
        emit({ type: 'error', message: ev.message || 'AI 서버에서 오류가 발생했습니다.' });
        finished = true;
      }
    };

    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (data) await handleEvent(data);
        }
      }
      if (buf.trim()) {
        const data = buf.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) await handleEvent(data);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        emit({ type: 'error', message: '요청을 중지했습니다.', aborted: true });
      } else {
        emit({ type: 'error', message: '응답을 받는 중 연결이 끊어졌습니다: ' + friendlyError(err, url) });
      }
      return;
    }
    if (!finished) { /* 서버가 done 없이 종료해도 정상 처리 */ }
    emit({ type: 'done', applied, snapshotId: snapshot && snapshot.created ? snapshot.id : null });
  } catch (err) {
    emit({ type: 'error', message: friendlyError(err, url) });
  } finally {
    activeChats.delete(id);
  }
}

// ───────────────────────── IPC ─────────────────────────
function registerIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, version: app.getVersion(), platform: process.platform }));
  ipcMain.handle('settings:set', (_e, partial) => {
    const allowed = {};
    if (partial && typeof partial.serverUrl === 'string') allowed.serverUrl = partial.serverUrl.trim() || DEFAULT_SERVER;
    if (partial && ['system', 'light', 'dark'].includes(partial.theme)) {
      allowed.theme = partial.theme;
      nativeTheme.themeSource = partial.theme;
    }
    settings = { ...settings, ...allowed };
    saveSettings();
    return settings;
  });

  ipcMain.handle('preview:base', () => preview.base);

  ipcMain.handle('project:current', () => projectInfo());
  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: '폴더 열기', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return setProject(r.filePaths[0]);
  });
  ipcMain.handle('project:close', () => setProject(null));
  ipcMain.handle('project:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: '프로젝트를 만들 위치 선택', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('project:defaultDir', () => {
    const p = path.join(app.getPath('documents'), 'CodeAI');
    return p;
  });
  ipcMain.handle('project:create', async (_e, { parentDir, name, template }) => {
    const safeName = String(name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    if (!safeName) throw new Error('프로젝트 이름을 입력해 주세요.');
    if (!parentDir) throw new Error('저장 위치를 선택해 주세요.');
    const dest = path.join(parentDir, safeName);
    if (fs.existsSync(dest) && (await fs.promises.readdir(dest)).length > 0) {
      throw new Error(`이미 같은 이름의 폴더가 있고 비어 있지 않습니다: ${dest}`);
    }
    await fs.promises.mkdir(dest, { recursive: true });
    if (template) {
      const src = path.join(templatesDir(), path.basename(template));
      if (!fs.existsSync(src)) throw new Error('템플릿을 찾을 수 없습니다: ' + template);
      await copyDir(src, dest);
    } else {
      await fs.promises.writeFile(path.join(dest, 'index.html'), BLANK_HTML, 'utf8');
    }
    return setProject(dest);
  });
  ipcMain.handle('templates:list', () => listTemplates());

  ipcMain.handle('fs:tree', async () => (projectRoot ? readTree(projectRoot) : []));
  ipcMain.handle('fs:read', async (_e, rel) => {
    const abs = safeResolve(rel);
    const st = await fs.promises.stat(abs);
    if (st.size > 5 * 1024 * 1024) throw new Error('파일이 너무 커서 편집기에서 열 수 없습니다 (5MB 초과).');
    return fs.promises.readFile(abs, 'utf8');
  });
  ipcMain.handle('fs:write', async (_e, rel, content) => {
    const abs = safeResolve(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, String(content), 'utf8');
    return true;
  });
  ipcMain.handle('fs:createFile', async (_e, rel) => {
    const abs = safeResolve(rel);
    if (fs.existsSync(abs)) throw new Error('이미 존재하는 파일입니다.');
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, '', 'utf8');
    return toRel(abs);
  });
  ipcMain.handle('fs:createFolder', async (_e, rel) => {
    const abs = safeResolve(rel);
    await fs.promises.mkdir(abs, { recursive: true });
    return toRel(abs);
  });
  ipcMain.handle('fs:delete', async (_e, rel) => {
    const abs = safeResolve(rel);
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['삭제', '취소'], defaultId: 1, cancelId: 1,
      title: '삭제 확인', message: `'${rel}'을(를) 삭제할까요?`, detail: '삭제 전 상태는 변경 기록에 저장됩니다.'
    });
    if (r.response !== 0) return false;
    const st = await fs.promises.stat(abs);
    if (st.isFile()) {
      const snap = new history.Snapshot(projectRoot, `파일 삭제: ${rel}`, 'delete');
      await snap.capture(toRel(abs));
    }
    await fs.promises.rm(abs, { recursive: true, force: true });
    return true;
  });
  ipcMain.handle('fs:exists', async (_e, rel) => {
    try { return fs.existsSync(safeResolve(rel)); } catch (_) { return false; }
  });

  ipcMain.handle('chat:send', (_e, id, payload) => {
    runChat(id, payload || {});
    return true;
  });
  ipcMain.handle('chat:abort', (_e, id) => {
    const c = activeChats.get(id);
    if (c) c.abort();
    return !!c;
  });

  ipcMain.handle('history:list', async () => (projectRoot ? history.list(projectRoot) : []));
  ipcMain.handle('history:restore', async (_e, id) => {
    if (!projectRoot) throw new Error('프로젝트가 열려 있지 않습니다.');
    return history.restore(projectRoot, path.basename(id), safeResolve);
  });

  ipcMain.handle('deploy', async () => {
    if (!projectRoot) throw new Error('프로젝트가 열려 있지 않습니다.');
    const url = serverUrl();
    const files = await collectFiles(['index.html'], { maxFiles: 500, maxFileSize: 2 * 1024 * 1024, maxTotal: 20 * 1024 * 1024, includeBinary: true });
    if (!files.length) throw new Error('배포할 파일이 없습니다.');
    let res;
    try {
      res = await fetch(`${url}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: path.basename(projectRoot), files }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (err) {
      throw new Error(friendlyError(err, url));
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (_) { /* text */ }
    if (!res.ok) throw new Error(`배포 실패 (HTTP ${res.status}) ${data.error || data.message || text.slice(0, 200)}`);
    if (!data.url) throw new Error('서버 응답에 배포 주소가 없습니다.');
    return { url: data.url, count: files.length };
  });

  ipcMain.handle('server:health', () => health());
  ipcMain.handle('updates:check', () => checkUpdates());

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url));
    return false;
  });
  ipcMain.handle('shell:showItem', (_e, rel) => {
    if (!projectRoot) return false;
    shell.showItemInFolder(rel ? safeResolve(rel) : projectRoot);
    return true;
  });
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });
}

// ───────────────────────── 메뉴 ─────────────────────────
function buildMenu() {
  const cmd = (name) => () => send('menu', name);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'Code AI', submenu: [{ role: 'about', label: 'Code AI 정보' }, { type: 'separator' }, { role: 'quit', label: '종료' }] }] : []),
    {
      label: '파일',
      submenu: [
        { label: '새 프로젝트…', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-project') },
        { label: '폴더 열기…', accelerator: 'CmdOrCtrl+O', click: cmd('open-folder') },
        { label: '새 파일', accelerator: 'CmdOrCtrl+N', click: cmd('new-file') },
        { type: 'separator' },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { type: 'separator' },
        { label: '설정…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '종료' }])
      ]
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' }
      ]
    },
    {
      label: '보기',
      submenu: [
        { label: '테마 전환 (다크/라이트)', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('toggle-theme') },
        { label: '미리보기 새로고침', accelerator: 'F5', click: cmd('refresh-preview') },
        { label: '변경 기록', accelerator: 'CmdOrCtrl+H', click: cmd('history') },
        { type: 'separator' },
        { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { role: 'resetZoom', label: '원래 크기' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '개발자 도구' }
      ]
    },
    {
      label: '도움말',
      submenu: [
        { label: '업데이트 확인', click: cmd('check-updates') },
        { label: `버전 ${app.getVersion()}`, enabled: false }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ───────────────────────── 창 ─────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 960,
    minHeight: 600,
    title: 'Code AI',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // 미리보기에서 PDF 표시
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => { if (!IS_SMOKE) win.show(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 앱 창 자체가 다른 주소로 이동하지 못하게 막는다.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  // 미리보기 등에서 새 창을 열면 기본 브라우저로.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (IS_SMOKE) runSmokeTest();
}

function runSmokeTest() {
  const errors = [];
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? 'info';
    const message = e.message;
    console.log(`[renderer:${level}] ${message}`);
    if (level === 'error' || level === 3) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, p, err) => { errors.push('preload: ' + err.message); });
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      let state = {};
      try {
        state = await win.webContents.executeJavaScript(`({
          ready: !!window.__codeaiReady,
          monaco: !!(window.monaco && window.monaco.editor),
          api: typeof window.codeai === 'object',
          project: document.getElementById('project-name') ? document.getElementById('project-name').textContent : null,
          tree: document.querySelectorAll('#file-tree .tree-item').length,
          preview: document.getElementById('preview-frame') ? document.getElementById('preview-frame').src : null,
          serverStatus: document.getElementById('server-status') ? document.getElementById('server-status').title : null,
          nodeIntegration: typeof process !== 'undefined'
        })`);
      } catch (err) {
        errors.push('executeJavaScript: ' + err.message);
      }
      // 개발용: --smoke-eval=<파일> 의 스크립트를 렌더러에서 실행하고 결과를 출력
      const evalArg = process.argv.find((a) => a.startsWith('--smoke-eval='));
      if (evalArg) {
        try {
          const code = fs.readFileSync(evalArg.slice('--smoke-eval='.length), 'utf8');
          const frameArg = process.argv.find((a) => a.startsWith('--smoke-frame-eval='));
          if (frameArg) {
            setTimeout(() => {
              const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(preview.base));
              if (!frame) return errors.push('preview frame not found');
              frame.executeJavaScript(fs.readFileSync(frameArg.slice('--smoke-frame-eval='.length), 'utf8'))
                .catch((err) => errors.push('frame-eval: ' + err.message));
            }, 1500);
          }
          const result = await win.webContents.executeJavaScript(code);
          console.log('SMOKE_EVAL ' + JSON.stringify(result));
        } catch (err) {
          errors.push('smoke-eval: ' + err.message);
        }
      }
      console.log('SMOKE_STATE ' + JSON.stringify(state));
      const ok = state.ready && state.monaco && state.api && !state.nodeIntegration && errors.length === 0;
      console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL ' + JSON.stringify(errors));
      app.exit(ok ? 0 : 1);
    }, 5000);
  });
}

// ───────────────────────── 시작 ─────────────────────────
const gotLock = IS_SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (IS_SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'codeai-smoke-' + process.pid));
    loadSettings();
    nativeTheme.themeSource = settings.theme;
    await preview.start();

    const projArg = process.argv.find((a) => a.startsWith('--project='));
    const initial = projArg ? projArg.slice('--project='.length) : settings.lastProject;
    if (initial && fs.existsSync(initial) && fs.statSync(initial).isDirectory()) setProject(initial);

    registerIpc();
    buildMenu();
    createWindow();
    nativeTheme.on('updated', () => send('theme:updated', { dark: nativeTheme.shouldUseDarkColors }));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const c of activeChats.values()) c.abort();
    if (watcher) watcher.close();
    preview.stop();
    if (process.platform !== 'darwin') app.quit();
  });
}
