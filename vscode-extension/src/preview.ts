import * as path from 'path';
import * as vscode from 'vscode';
import { Selection } from './api';
import { PreviewServer } from './previewServer';
import { getRoot, toRelative } from './workspace';

export type PreviewKind = 'html' | 'markdown' | 'image' | 'pdf';

const KIND_BY_EXT: Record<string, PreviewKind> = {
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.ico': 'image',
  '.pdf': 'pdf',
};

export function previewKind(uri: vscode.Uri): PreviewKind | undefined {
  return KIND_BY_EXT[path.extname(uri.path).toLowerCase()];
}

function getNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** 현재 탭에서 미리보기할 수 있는 파일 Uri 를 찾습니다 (이미지 같은 커스텀 편집기 포함). */
export function activePreviewableUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    uri = input.uri;
  } else {
    uri = vscode.window.activeTextEditor?.document.uri;
  }
  return uri && previewKind(uri) ? uri : undefined;
}

export class PreviewManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: vscode.Uri | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private baseUrl: string | undefined;
  private lastShow: unknown;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: PreviewServer,
    private readonly onSelection: (sel: Selection) => void
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFsChange = (u: vscode.Uri) => {
      if (!/[\\/](\.git|\.codeai|node_modules)[\\/]/.test(u.fsPath)) {
        this.scheduleRefresh(150);
      }
    };
    watcher.onDidChange(onFsChange, null, this.disposables);
    watcher.onDidCreate(onFsChange, null, this.disposables);
    watcher.onDidDelete(onFsChange, null, this.disposables);
    this.disposables.push(watcher);

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh(100)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.panel || e.contentChanges.length === 0 || e.document.uri.scheme !== 'file') {
          return;
        }
        if (vscode.workspace.getConfiguration('codeai').get<boolean>('previewOnType', true)) {
          if (/\.(html?|css|js|md|markdown|svg)$/i.test(e.document.uri.path)) {
            this.scheduleRefresh(700);
          }
        }
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.followActive()),
      vscode.window.onDidChangeActiveTextEditor(() => this.followActive()),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.current) {
          void this.show(this.current, false);
        }
      })
    );
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** 명령: 미리보기 열기. uri 가 없으면 활성 파일 → 작업 공간의 index.html 순으로 찾습니다. */
  async open(uri?: vscode.Uri): Promise<void> {
    let target = uri && previewKind(uri) ? uri : activePreviewableUri() || this.current;
    if (!target) {
      const root = getRoot();
      if (root) {
        const found = await vscode.workspace.findFiles('**/index.html', '{**/node_modules/**,**/.codeai/**}', 5);
        found.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
        target = found[0];
        if (!target) {
          const any = await vscode.workspace.findFiles('**/*.{html,md}', '{**/node_modules/**,**/.codeai/**}', 1);
          target = any[0];
        }
      }
    }
    if (!target) {
      vscode.window.showWarningMessage('미리볼 파일이 없습니다. HTML, Markdown, 이미지 또는 PDF 파일을 열어 주세요.');
      return;
    }
    if (!getRoot() || toRelative(target) === target.fsPath) {
      vscode.window.showWarningMessage('작업 폴더 안의 파일만 미리볼 수 있습니다. 먼저 폴더를 열어 주세요.');
      return;
    }
    await this.show(target, true);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeai.preview',
      '미리보기',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri)],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'activity.svg');
    panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.panel = panel;
    return panel;
  }

  private async getBaseUrl(): Promise<string> {
    if (!this.baseUrl) {
      const port = await this.server.start();
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
      this.baseUrl = external.toString(true).replace(/\/?$/, '/');
    }
    return this.baseUrl;
  }

  private async show(uri: vscode.Uri, reveal: boolean): Promise<void> {
    const kind = previewKind(uri);
    if (!kind) {
      return;
    }
    let base: string;
    try {
      base = await this.getBaseUrl();
    } catch (e: any) {
      vscode.window.showErrorMessage('미리보기 서버를 시작할 수 없습니다: ' + (e?.message || e));
      return;
    }
    const isNewPanel = !this.panel;
    const panel = this.ensurePanel();
    if (reveal && !isNewPanel) {
      panel.reveal(undefined, true);
    }
    this.current = uri;
    const rel = toRelative(uri);
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
        ? 'light'
        : 'dark';
    const url = base + rel.split('/').map(encodeURIComponent).join('/') + `?__theme=${theme}`;
    panel.title = `미리보기 · ${path.basename(uri.path)}`;
    if (isNewPanel || !panel.webview.html) {
      panel.webview.html = this.renderHtml(panel.webview, base);
    }
    this.lastShow = { type: 'show', url, kind, file: rel };
    void panel.webview.postMessage(this.lastShow);
  }

  private followActive(): void {
    if (!this.panel) {
      return;
    }
    const uri = activePreviewableUri();
    if (uri && uri.toString() !== this.current?.toString() && getRoot() && toRelative(uri) !== uri.fsPath) {
      void this.show(uri, false);
    }
  }

  scheduleRefresh(delay = 150): void {
    if (!this.panel) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.panel?.webview.postMessage({ type: 'reload' });
    }, delay);
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case 'ready':
        if (this.lastShow) {
          void this.panel?.webview.postMessage(this.lastShow);
        }
        break;
      case 'selection': {
        const sel: Selection = {
          selector: String(msg.selector || ''),
          html: String(msg.html || ''),
          file: String(msg.file || (this.current ? toRelative(this.current) : '')),
        };
        this.onSelection(sel);
        break;
      }
      case 'openExternal':
        if (msg.url) {
          void vscode.env.openExternal(vscode.Uri.parse(String(msg.url).replace(/\?__theme=\w+$/, '')));
        }
        break;
      case 'openSource':
        if (this.current) {
          void vscode.window.showTextDocument(this.current, { viewColumn: vscode.ViewColumn.One });
        }
        break;
    }
  }

  private renderHtml(webview: vscode.Webview, base: string): string {
    const nonce = getNonce();
    const origin = new URL(base).origin;
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));
    const csp = [
      `default-src 'none'`,
      `frame-src ${origin} http://127.0.0.1:* http://localhost:*`,
      `img-src ${origin} ${webview.cspSource} http://127.0.0.1:* data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>미리보기</title>
</head>
<body>
  <header class="toolbar">
    <span class="file" id="file" title="원본 파일 열기">—</span>
    <span class="spacer"></span>
    <select id="device" title="화면 크기">
      <option value="full">전체 폭</option>
      <option value="1024">태블릿 가로 (1024)</option>
      <option value="768">태블릿 (768)</option>
      <option value="390">모바일 (390)</option>
    </select>
    <button id="select" class="toggle" title="미리보기에서 요소를 클릭해 채팅에 첨부합니다">선택 모드</button>
    <button id="refresh" title="새로고침">새로고침</button>
    <button id="external" title="브라우저에서 열기">브라우저</button>
  </header>
  <div class="hint" id="hint" hidden>수정할 요소를 클릭하세요. 선택한 요소가 채팅에 첨부됩니다. (Esc: 종료)</div>
  <main id="stage" class="stage">
    <div class="empty" id="empty">미리볼 파일을 여는 중…</div>
  </main>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }
}
