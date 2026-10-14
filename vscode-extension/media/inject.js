/* Code AI 미리보기 주입 스크립트: 클릭 수정(선택 모드), 새로고침, 스크롤 유지 */
(function () {
  if (window.__codeaiInjected) return;
  window.__codeaiInjected = true;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;

  var KEY = '__codeai_scroll:' + location.pathname;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved) {
      var pos = JSON.parse(saved);
      sessionStorage.removeItem(KEY);
      var restore = function () { window.scrollTo(pos.x || 0, pos.y || 0); };
      if (document.readyState === 'complete') restore();
      else window.addEventListener('load', restore);
    }
  } catch (e) { /* storage 사용 불가 */ }

  var selectMode = false;
  var hoverEl = null;
  var overlay = document.createElement('div');
  overlay.setAttribute('data-codeai', 'overlay');
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c5cff;background:rgba(124,92,255,.12);' +
    'border-radius:3px;display:none;transition:all .05s ease-out;box-sizing:border-box';
  var label = document.createElement('div');
  label.setAttribute('data-codeai', 'label');
  label.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483647;background:#7c5cff;color:#fff;font:12px/1.4 Consolas,monospace;' +
    'padding:2px 6px;border-radius:3px;display:none;max-width:60vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';

  function mount() {
    if (!overlay.isConnected && document.body) {
      document.body.appendChild(overlay);
      document.body.appendChild(label);
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function selectorFor(el) {
    if (!(el instanceof Element)) return '';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll('#' + cssEscape(cur.id)).length === 1) {
        parts.unshift('#' + cssEscape(cur.id));
        break;
      }
      if (tag === 'body') {
        parts.unshift('body');
        break;
      }
      var part = tag;
      var classes = Array.prototype.filter.call(cur.classList || [], function (c) { return c && c.indexOf('codeai') !== 0; });
      if (classes.length) part += '.' + classes.slice(0, 2).map(cssEscape).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function currentFile() {
    var p = decodeURIComponent(location.pathname).replace(/^\/+/, '');
    if (!p || /\/$/.test(p)) p += 'index.html';
    return p;
  }

  function show(el) {
    if (!el || el === document.body || el === document.documentElement) {
      overlay.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    var r = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    label.textContent = selectorFor(el);
    label.style.display = 'block';
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = (r.top > 22 ? r.top - 22 : r.bottom + 2) + 'px';
  }

  function onMove(e) {
    if (!selectMode) return;
    var el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-codeai')) return;
    hoverEl = el;
    show(el);
  }

  function onClick(e) {
    if (!selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var el = e.target;
    if (!(el instanceof Element)) return;
    var html = el.outerHTML || '';
    if (html.length > 6000) html = html.slice(0, 6000) + '\n<!-- ...생략... -->';
    parentWin.postMessage({
      codeai: 'selection',
      selector: selectorFor(el),
      html: html,
      file: currentFile()
    }, '*');
  }

  function swallow(e) {
    if (selectMode) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('submit', swallow, true);
  window.addEventListener('scroll', function () { if (selectMode && hoverEl) show(hoverEl); }, true);

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.codeai === 'selectMode') {
      selectMode = !!d.on;
      mount();
      document.documentElement.style.cursor = selectMode ? 'crosshair' : '';
      if (!selectMode) show(null);
    } else if (d.codeai === 'reload') {
      try { sessionStorage.setItem(KEY, JSON.stringify({ x: window.scrollX, y: window.scrollY })); } catch (err) { /* 무시 */ }
      location.reload();
    }
  });

  function ready() {
    mount();
    parentWin.postMessage({ codeai: 'ready', file: currentFile(), title: document.title }, '*');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
