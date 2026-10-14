// Code AI 다운로드 사이트
(function () {
  'use strict';

  var VERSION = '1.1.0';
  var REPO = 'sherlock12369-collab/code-ai';
  var RELEASE_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var RELEASE_DL = 'https://github.com/' + REPO + '/releases/latest/download/';
  var THEME_KEY = 'codeai-theme';
  var downloads = {
    win: RELEASE_DL + 'CodeAI-Setup-' + VERSION + '.exe',
    mac: RELEASE_DL + 'CodeAI-' + VERSION + '.dmg',
    vsix: RELEASE_DL + 'codeai-' + VERSION + '.vsix'
  };

  var root = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 테마 ---------- */
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function currentTheme() {
    var t = root.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : systemTheme();
  }
  function applyTheme(t) {
    root.setAttribute('data-theme', t);
    var btn = $('themeToggle');
    if (btn) btn.setAttribute('aria-label', t === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
  }
  var toggle = $('themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-label', currentTheme() === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 저장 불가 시 무시 */ }
    });
  }

  /* ---------- OS 감지 ---------- */
  function detectOS() {
    var p = '';
    try {
      p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    } catch (e) { /* ignore */ }
    var ua = navigator.userAgent || '';
    var s = (p + ' ' + ua).toLowerCase();
    if (/mac|iphone|ipad|ipod/.test(s)) return 'mac';
    return 'win';
  }

  var OS_INFO = {
    win: { label: 'Windows용 다운로드', meta: '버전 ' + VERSION + ' · Windows 10 이상 · 64비트' },
    mac: { label: 'macOS용 다운로드', meta: '버전 ' + VERSION + ' · macOS 12 이상 · Apple 실리콘 / Intel' }
  };
  var os = detectOS();

  function setHref(id, url) {
    var el = $(id);
    if (el && url) el.setAttribute('href', url);
  }

  function render() {
    var info = OS_INFO[os];
    var primary = $('primaryDl');
    if (primary) primary.setAttribute('href', downloads[os]);
    var icon = $('primaryIcon');
    if (icon) icon.setAttribute('data-os', os);
    if ($('primaryLabel')) $('primaryLabel').textContent = info.label;
    if ($('primaryMeta')) $('primaryMeta').textContent = info.meta;

    // 보조 버튼: 현재 OS는 숨기고 다른 OS만 표시
    var winBtn = $('dlWin');
    var macBtn = $('dlMac');
    if (winBtn) winBtn.hidden = os === 'win';
    if (macBtn) macBtn.hidden = os === 'mac';
    setHref('dlWin', downloads.win);
    setHref('dlMac', downloads.mac);
    setHref('verWin', downloads.win);
    setHref('verMac', downloads.mac);
    setHref('dlVsix', downloads.vsix);
    setHref('footerDl', downloads[os]);
    var footer = $('footerDl');
    if (footer) footer.textContent = info.label;
  }

  render();

  /* ---------- 최신 버전 정보 (GitHub 최신 릴리스) ---------- */
  function isSafeUrl(u) {
    return typeof u === 'string' && /^https:\/\/github\.com\//i.test(u);
  }

  if (window.fetch) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);
    fetch(RELEASE_API, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return;
        (data.assets || []).forEach(function (a) {
          var u = a && a.browser_download_url;
          if (!isSafeUrl(u)) return;
          if (/\.exe$/i.test(u)) downloads.win = u;
          else if (/\.dmg$/i.test(u)) downloads.mac = u;
          else if (/\.vsix$/i.test(u)) downloads.vsix = u;
        });
        var v = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : '';
        if (v) {
          VERSION = v;
          OS_INFO.win.meta = OS_INFO.win.meta.replace(/버전 [^ ]+/, '버전 ' + VERSION);
          OS_INFO.mac.meta = OS_INFO.mac.meta.replace(/버전 [^ ]+/, '버전 ' + VERSION);
          if ($('currentVersion')) $('currentVersion').textContent = VERSION;
        }
        render();
      })
      .catch(function () { /* 서버에 연결할 수 없으면 기본 링크 사용 */ })
      .then(function () { clearTimeout(timer); });
  }
})();
