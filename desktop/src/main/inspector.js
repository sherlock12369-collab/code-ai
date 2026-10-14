'use strict';
// 미리보기 페이지에 주입되는 스크립트 (클릭 수정용 "선택 모드").
// 부모(앱)와 postMessage로 통신한다.
//   부모 -> 페이지: { source: 'codeai-host', type: 'select-mode', on: boolean }
//                   { source: 'codeai-host', type: 'clear-selection' }
//   페이지 -> 부모: { source: 'codeai-preview', type: 'ready' }
//                   { source: 'codeai-preview', type: 'selected', selector, html }

const INSPECTOR_SCRIPT = String.raw`(function () {
  if (window.__codeaiInspector) return;
  window.__codeaiInspector = true;
  if (window.parent === window) return;

  var selectMode = false;
  var hoverBox = null;
  var selectBox = null;
  var selectedEl = null;
  var label = null;

  function box(color, fill, z) {
    var d = document.createElement('div');
    d.setAttribute('data-codeai-overlay', '');
    d.style.cssText = 'position:fixed;pointer-events:none;z-index:' + z + ';border:2px solid ' + color +
      ';background:' + fill + ';border-radius:3px;transition:all .06s ease-out;display:none;box-sizing:border-box;';
    document.documentElement.appendChild(d);
    return d;
  }

  function ensureBoxes() {
    if (!hoverBox || !hoverBox.isConnected) hoverBox = box('#7c5cff', 'rgba(124,92,255,.10)', 2147483646);
    if (!selectBox || !selectBox.isConnected) selectBox = box('#7c5cff', 'rgba(124,92,255,.18)', 2147483645);
    if (!label || !label.isConnected) {
      label = document.createElement('div');
      label.setAttribute('data-codeai-overlay', '');
      label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#7c5cff;color:#fff;' +
        'font:600 11px/1.6 Consolas,monospace;padding:1px 6px;border-radius:3px;display:none;white-space:nowrap;';
      document.documentElement.appendChild(label);
    }
  }

  function place(el, b, withLabel) {
    if (!el) { b.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
    if (withLabel) {
      label.textContent = shortName(el);
      label.style.display = 'block';
      label.style.left = Math.max(0, r.left) + 'px';
      label.style.top = Math.max(0, r.top - 20) + 'px';
    }
  }

  function shortName(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    return s;
  }

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function selectorFor(el) {
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      if (tag === 'body') { parts.unshift('body'); break; }
      if (cur.id && document.querySelectorAll('#' + cssEscape(cur.id)).length === 1) {
        parts.unshift('#' + cssEscape(cur.id));
        break;
      }
      var part = tag;
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

  function isOverlay(el) { return el && el.hasAttribute && el.hasAttribute('data-codeai-overlay'); }

  document.addEventListener('mousemove', function (e) {
    if (!selectMode) return;
    ensureBoxes();
    var el = e.target;
    if (isOverlay(el) || el === document.documentElement) { place(null, hoverBox); label.style.display = 'none'; return; }
    place(el, hoverBox, true);
  }, true);

  function block(e) {
    if (!selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  ['mousedown', 'mouseup', 'dblclick', 'submit', 'auxclick'].forEach(function (t) {
    document.addEventListener(t, block, true);
  });

  document.addEventListener('click', function (e) {
    if (!selectMode) return;
    block(e);
    var el = e.target;
    if (isOverlay(el) || el === document.documentElement) return;
    selectedEl = el;
    ensureBoxes();
    place(el, selectBox);
    var html = el.outerHTML || '';
    if (html.length > 6000) html = html.slice(0, 6000) + '\n<!-- ...생략... -->';
    window.parent.postMessage({ source: 'codeai-preview', type: 'selected', selector: selectorFor(el), html: html }, '*');
  }, true);

  function refresh() {
    if (selectedEl && selectBox) {
      if (selectedEl.isConnected) place(selectedEl, selectBox); else selectBox.style.display = 'none';
    }
  }
  window.addEventListener('scroll', refresh, true);
  window.addEventListener('resize', refresh);

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data || {};
    if (d.source !== 'codeai-host') return;
    if (d.type === 'select-mode') {
      selectMode = !!d.on;
      ensureBoxes();
      document.documentElement.style.cursor = selectMode ? 'crosshair' : '';
      if (!selectMode) { hoverBox.style.display = 'none'; label.style.display = 'none'; }
    } else if (d.type === 'clear-selection') {
      selectedEl = null;
      if (selectBox) selectBox.style.display = 'none';
    }
  });

  window.parent.postMessage({ source: 'codeai-preview', type: 'ready' }, '*');
})();`;

module.exports = { INSPECTOR_SCRIPT };
