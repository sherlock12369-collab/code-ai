'use strict';
// 미리보기용 로컬 정적 서버 (127.0.0.1 전용).
// - 현재 프로젝트 폴더를 그대로 서비스하므로 HTML의 상대 경로 자산이 동작한다.
// - HTML 응답에는 클릭 수정용 inspector 스크립트를 주입한다.
// - Markdown(.md)은 렌더링된 HTML 문서로 응답한다 (?raw=1 이면 원본).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { INSPECTOR_SCRIPT } = require('./inspector');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.xml': 'application/xml; charset=utf-8'
};

let markedMod = null;
async function renderMarkdown(src) {
  if (!markedMod) markedMod = await import('marked');
  return markedMod.marked.parse(src, { gfm: true, breaks: false });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MD_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#111111;--muted:#666;--line:#e5e5e5;--code:#f5f5f7;--accent:#7c5cff}
html[data-theme=dark]{--bg:#0d0d0f;--fg:#ededed;--muted:#9a9a9a;--line:#2a2a2e;--code:#18181b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 "Pretendard","Apple SD Gothic Neo","Malgun Gothic","Segoe UI",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:48px 32px 96px}
h1,h2,h3,h4{line-height:1.3;margin:1.8em 0 .6em;letter-spacing:-.01em}
h1{font-size:2.1em;margin-top:0;padding-bottom:.4em;border-bottom:1px solid var(--line)}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
a{color:var(--accent)}
img{max-width:100%;border-radius:8px}
code{font-family:"JetBrains Mono",Consolas,monospace;font-size:.9em;background:var(--code);padding:.15em .4em;border-radius:4px}
pre{background:var(--code);padding:16px;border-radius:8px;overflow:auto;border:1px solid var(--line)}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.5em 1em;border-left:4px solid var(--accent);color:var(--muted);background:var(--code);border-radius:0 6px 6px 0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left}
th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
`;

class PreviewServer {
  constructor() {
    this.root = null;
    this.port = 0;
    this.server = null;
  }

  setRoot(root) {
    this.root = root;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('미리보기 오류: ' + err.message);
          } catch (_) { /* ignore */ }
        });
      });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.base);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  async handle(req, res) {
    const url = new URL(req.url, this.base);
    const headers = { 'Cache-Control': 'no-store' };

    if (url.pathname === '/__codeai__/inspector.js') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(INSPECTOR_SCRIPT);
    }

    if (!this.root) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this.messagePage('프로젝트가 열려 있지 않습니다.', url.searchParams.get('theme')));
    }

    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch (_) {
      res.writeHead(400);
      return res.end();
    }
    const abs = path.resolve(this.root, '.' + rel);
    const rootResolved = path.resolve(this.root);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let target = abs;
    let stat;
    try {
      stat = await fs.promises.stat(target);
      if (stat.isDirectory()) {
        target = path.join(target, 'index.html');
        stat = await fs.promises.stat(target);
      }
    } catch (_) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(this.messagePage(`파일을 찾을 수 없습니다: ${escapeHtml(rel)}`, url.searchParams.get('theme')));
    }

    const ext = path.extname(target).toLowerCase();
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';

    if (ext === '.md' || ext === '.markdown') {
      if (url.searchParams.get('raw') === '1') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
        return fs.createReadStream(target).pipe(res);
      }
      const src = await fs.promises.readFile(target, 'utf8');
      const body = await renderMarkdown(src);
      const html = `<!doctype html><html lang="ko" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(path.basename(target))}</title>
<style>${MD_CSS}</style></head><body><main>${body}</main>
<script src="/__codeai__/inspector.js"></script></body></html>`;
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (ext === '.html' || ext === '.htm') {
      let html = await fs.promises.readFile(target, 'utf8');
      const tag = '<script src="/__codeai__/inspector.js"></script>';
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>');
      else html += tag;
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    });
    fs.createReadStream(target).pipe(res);
  }

  messagePage(msg, themeParam) {
    const theme = themeParam === 'dark' ? 'dark' : 'light';
    return `<!doctype html><html lang="ko" data-theme="${theme}"><head><meta charset="utf-8"><style>
:root{--bg:#fff;--fg:#666}html[data-theme=dark]{--bg:#0d0d0f;--fg:#9a9a9a}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:14px "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}</style></head>
<body><div>${msg}</div></body></html>`;
  }
}

module.exports = { PreviewServer };
