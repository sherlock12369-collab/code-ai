'use strict';
// 자동 업데이트
//  - Windows: electron-updater + GitHub Releases (latest.yml). 백그라운드로 받고 재시작 시 설치.
//  - macOS: 서명이 없어 자동 설치 불가 → GitHub 최신 릴리스를 확인해 알림 + 다운로드 링크.

const { app } = require('electron');

const OWNER = 'sherlock12369-collab';
const REPO = 'code-ai';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let autoUpdater = null;
let state = { status: 'idle', version: null, percent: null, error: null };
let notify = () => {};

function nativeSupported() {
  return process.platform === 'win32' && app.isPackaged;
}

function setState(patch) {
  state = { ...state, ...patch };
  notify(state);
}

// onState(state): 상태가 바뀔 때마다 호출 (렌더러에 전달)
function init(onState) {
  notify = onState || notify;
  if (!nativeSupported()) return false;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater 로드 실패', err);
    return false;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => console.log('[updater]', m), warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => {} };
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setState({ status: 'latest' }));
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info.version, percent: 1 }));
  autoUpdater.on('error', (err) => setState({ status: 'error', error: (err && err.message) || String(err) }));
  return true;
}

// GitHub 최신 릴리스 (macOS 알림용, Windows 대체 경로)
async function checkGithub() {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodeAI-Desktop' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  const assets = rel.assets || [];
  const pick = (re) => (assets.find((a) => re.test(a.name)) || {}).browser_download_url;
  const url = process.platform === 'darwin' ? pick(/\.dmg$/i) : pick(/\.exe$/i);
  return { version, notes: rel.name && rel.name !== rel.tag_name ? rel.name : '', url: url || rel.html_url || RELEASES_URL };
}

// 반환: { available, native, version, notes, url, current, status }
async function check({ fallbackLatestJson } = {}) {
  const current = app.getVersion();
  if (autoUpdater) {
    if (state.status === 'ready') return { available: true, native: true, status: 'ready', version: state.version, current };
    try {
      const r = await autoUpdater.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      if (v && compareVersions(v, current) > 0) {
        return { available: true, native: true, status: state.status, version: v, current };
      }
      return { available: false, current };
    } catch (err) {
      console.error('[updater] 확인 실패', err);
      // 아래 GitHub/서버 확인으로 대체
    }
  }
  try {
    const r = await checkGithub();
    if (r.version && compareVersions(r.version, current) > 0) return { available: true, native: false, ...r, current };
    if (r.version) return { available: false, current };
  } catch (_) { /* 오프라인 등 */ }
  if (fallbackLatestJson) {
    try {
      const r = await fallbackLatestJson();
      if (r && r.version && compareVersions(r.version, current) > 0) return { available: true, native: false, ...r, current };
    } catch (_) { /* ignore */ }
  }
  return { available: false, current };
}

function installNow() {
  if (autoUpdater && state.status === 'ready') {
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }
  return false;
}

function getState() {
  return { ...state, native: !!autoUpdater };
}

module.exports = { init, check, installNow, getState, compareVersions, RELEASES_URL };
