import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { readText, resolveInRoot } from './workspace';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/html; charset=utf-8',
  '.markdown': 'text/html; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const INJECT_PATH = '/__codeai/inject.js';

/**
 * 작업 공간을 127.0.0.1 의 임의 포트로 서비스하는 작은 정적 서버.
 * - HTML 에는 클릭 수정/새로고침용 스크립트를 주입합니다.
 * - Markdown 은 VS Code 내장 렌더러로 HTML 문서로 바꿔서 보냅니다.
 * - 저장되지 않은 편집 내용도 바로 반영됩니다 (열린 문서의 텍스트를 사용).
 */
export class PreviewServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port = 0;
  private starting: Promise<number> | undefined;

  constructor(private readonly injectScriptUri: vscode.Uri) {}

  start(): Promise<number> {
    if (this.port) {
      return Promise.resolve(this.port);
    }
    if (!this.starting) {
      this.starting = new Promise<number>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this.handle(req, res).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            res.end('미리보기 오류: ' + (err?.message || err));
          });
        });
        server.on('error', (e) => {
          this.starting = undefined;
          reject(e);
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          this.port = typeof addr === 'object' && addr ? addr.port : 0;
          this.server = server;
          resolve(this.port);
        });
      });
    }
    return this.starting;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const theme = url.searchParams.get('__theme') === 'light' ? 'light' : 'dark';
    const noCache = {
      'Cache-Control': 'no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    };

    if (url.pathname === INJECT_PATH) {
      const bytes = await vscode.workspace.fs.readFile(this.injectScriptUri);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...noCache });
      res.end(Buffer.from(bytes));
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('작업 폴더가 없습니다.');
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      rel = url.pathname.replace(/^\/+/, '');
    }
    let uri = rel ? resolveInRoot(root, rel) : root;
    if (!uri) {
      res.writeHead(403);
      res.end();
      return;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        uri = vscode.Uri.joinPath(uri, 'index.html');
        stat = await vscode.workspace.fs.stat(uri);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...noCache });
      res.end(this.wrapPage(`<h2>파일을 찾을 수 없습니다</h2><p><code>${escapeHtml(rel || '/')}</code></p>`, theme, 'Not found'));
      return;
    }

    const ext = path.extname(uri.path).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      const html = await readText(uri);
      res.writeHead(200, { 'Content-Type': MIME[ext], ...noCache });
      res.end(injectScript(html));
      return;
    }
    if (ext === '.md' || ext === '.markdown') {
      const md = await readText(uri);
      let body: string;
      try {
        body = (await vscode.commands.executeCommand<string>('markdown.api.render', md)) || '';
      } catch {
        body = `<pre>${escapeHtml(md)}</pre>`;
      }
      res.writeHead(200, { 'Content-Type': MIME[ext], ...noCache });
      res.end(this.wrapPage(`<article class="markdown-body">${body}</article>`, theme, path.basename(uri.path)));
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri!.toString() && d.isDirty);
    const data = open ? Buffer.from(open.getText(), 'utf8') : Buffer.from(await vscode.workspace.fs.readFile(uri));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', ...noCache });
    res.end(data);
  }

  private wrapPage(body: string, theme: 'dark' | 'light', title: string): string {
    const dark = theme === 'dark';
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:${dark ? '#1e1e1e' : '#ffffff'};--fg:${dark ? '#e6e6e6' : '#1f1f1f'};--muted:${dark ? '#9a9a9a' : '#666'};--border:${dark ? '#333' : '#e3e3e3'};--code:${dark ? '#2a2a2a' : '#f5f5f7'};--accent:#7c5cff}
html,body{background:var(--bg);color:var(--fg);margin:0}
body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;padding:32px 24px}
.markdown-body{max-width:820px;margin:0 auto}
h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .6em}h1,h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
a{color:var(--accent)}code{background:var(--code);padding:.15em .4em;border-radius:4px;font-size:.9em;font-family:Consolas,"D2Coding",monospace}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--accent)}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--border);padding:6px 12px;text-align:left}
img{max-width:100%}hr{border:0;border-top:1px solid var(--border)}
</style></head><body>${body}<script src="${INJECT_PATH}"></script></body></html>`;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
    this.starting = undefined;
  }
}

function injectScript(html: string): string {
  const tag = `<script src="${INJECT_PATH}"></script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>');
  }
  if (/<\/html>/i.test(html)) {
    return html.replace(/<\/html>(?![\s\S]*<\/html>)/i, tag + '</html>');
  }
  return html + tag;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
