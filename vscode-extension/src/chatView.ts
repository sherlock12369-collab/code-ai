import * as vscode from 'vscode';
import { ChatMessage, getModel, hasApiKey, health, Selection, ServerError, streamChat, UNREACHABLE_MESSAGE } from './api';
import { HistoryStore } from './history';
import { collectContextFiles, getRoot, resolveInRoot, toRelative, writeText } from './workspace';

interface PendingFile {
  path: string;
  content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'codeai.chatView';

  private view: vscode.WebviewView | undefined;
  private messages: ChatMessage[] = [];
  private selection: Selection | undefined;
  private abort: AbortController | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingPosts: unknown[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly history: HistoryStore,
    private readonly hooks: { onFilesApplied: (paths: string[]) => void }
  ) {
    this.disposables.push(
      history.onDidChange(() => void this.sendHistory()),
      vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveFile()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codeai.serverUrl')) {
          void this.checkServer();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    view.onDidDispose(() => {
      this.view = undefined;
    }, null, this.disposables);
  }

  private post(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    } else {
      this.pendingPosts.push(msg);
    }
  }

  async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    } else {
      this.view.show(true);
    }
  }

  /** 미리보기에서 클릭한 요소를 다음 요청에 첨부합니다. */
  async attachSelection(sel: Selection): Promise<void> {
    this.selection = sel;
    await this.reveal();
    this.post({ type: 'selection', selection: sel });
  }

  newChat(): void {
    this.abort?.abort();
    this.messages = [];
    this.selection = undefined;
    this.post({ type: 'reset' });
  }

  notify(kind: 'info' | 'error' | 'deploy', text: string, url?: string): void {
    this.post({ type: 'notice', kind, text, url });
  }

  async checkServer(): Promise<boolean> {
    try {
      const h = await health();
      if (!hasApiKey()) {
        this.post({ type: 'server', ok: false, text: 'Claude API 키 필요' });
        return false;
      }
      this.post({ type: 'server', ok: true, text: `연결됨 · ${getModel()}` });
      return true;
    } catch (e) {
      this.post({ type: 'server', ok: false, text: '서버 연결 안 됨' });
      return false;
    }
  }

  private sendActiveFile(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const root = getRoot();
    const rel = doc && root && doc.uri.scheme === 'file' ? toRelative(doc.uri) : undefined;
    this.post({ type: 'activeFile', file: rel && rel !== doc!.uri.fsPath ? rel : undefined });
  }

  private async sendHistory(): Promise<void> {
    const list = await this.history.list();
    this.post({
      type: 'history',
      items: list.slice(0, 50).map((h) => ({
        id: h.id,
        time: new Date(h.time).toLocaleString('ko-KR'),
        label: h.label,
        files: h.files.map((f) => f.path),
      })),
    });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        for (const p of this.pendingPosts.splice(0)) {
          void this.view?.webview.postMessage(p);
        }
        this.post({ type: 'restore', messages: this.messages, selection: this.selection });
        this.sendActiveFile();
        void this.sendHistory();
        void this.checkServer();
        break;
      case 'send':
        await this.send(String(msg.text || ''));
        break;
      case 'stop':
        this.abort?.abort();
        break;
      case 'clearSelection':
        this.selection = undefined;
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'restore':
        await vscode.commands.executeCommand('codeai.restoreHistory', String(msg.id));
        break;
      case 'deleteHistory':
        await this.history.remove(String(msg.id));
        break;
      case 'openFile': {
        const root = getRoot();
        const uri = root && resolveInRoot(root, String(msg.path));
        if (uri) {
          await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.One });
        }
        break;
      }
      case 'openUrl':
        if (msg.url) {
          await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        }
        break;
      case 'copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.showInformationMessage('링크를 복사했습니다.');
        }
        break;
      case 'command':
        if (['codeai.openPreview', 'codeai.deploy', 'codeai.startFromTemplate', 'codeai.checkServer'].includes(msg.command)) {
          await vscode.commands.executeCommand(msg.command);
        }
        break;
    }
  }

  private async send(text: string): Promise<void> {
    text = text.trim();
    if (!text || this.abort) {
      return;
    }
    const selection = this.selection;
    this.selection = undefined;
    this.messages.push({ role: 'user', content: text });
    this.post({ type: 'user', text, selection });
    this.post({ type: 'assistantStart' });

    const controller = new AbortController();
    this.abort = controller;
    let answer = '';
    const pendingFiles: PendingFile[] = [];
    let errorText: string | undefined;

    try {
      const files = await collectContextFiles(selection?.file ? [selection.file] : []);
      this.post({ type: 'context', files: files.map((f) => f.path) });
      await streamChat(
        { messages: this.messages.slice(-20), files, model: getModel(), ...(selection ? { selection } : {}) },
        (ev) => {
          switch (ev.type) {
            case 'delta':
              answer += ev.text;
              this.post({ type: 'delta', text: ev.text });
              break;
            case 'file':
              if (ev.path && typeof ev.content === 'string') {
                const idx = pendingFiles.findIndex((f) => f.path === ev.path);
                if (idx >= 0) {
                  pendingFiles[idx] = { path: ev.path, content: ev.content };
                } else {
                  pendingFiles.push({ path: ev.path, content: ev.content });
                }
              }
              break;
            case 'error':
              errorText = ev.message || '알 수 없는 오류가 발생했습니다.';
              break;
            case 'done':
              break;
          }
        },
        controller.signal
      );
    } catch (e: any) {
      errorText = e instanceof ServerError ? e.message : '요청 중 오류가 발생했습니다: ' + (e?.message || e);
      if (e instanceof ServerError && e.unreachable) {
        this.post({ type: 'server', ok: false, text: '서버 연결 안 됨' });
        void vscode.window.showErrorMessage(UNREACHABLE_MESSAGE, '설정 열기').then((pick) => {
          if (pick) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'codeai.serverUrl');
          }
        });
      }
    } finally {
      this.abort = undefined;
    }
    if (errorText && (!hasApiKey() || /API 키/.test(errorText))) {
      void vscode.window.showErrorMessage(errorText, 'API 키 입력').then((pick) => {
        if (pick) {
          void vscode.commands.executeCommand('codeai.setApiKey');
        }
      });
    }

    if (answer) {
      this.messages.push({ role: 'assistant', content: answer });
    } else if (errorText) {
      // 실패한 요청은 대화 기록에서 제거해 다음 요청이 꼬이지 않게 합니다.
      this.messages.pop();
    }

    let applied: string[] = [];
    if (pendingFiles.length && !controller.signal.aborted) {
      try {
        applied = await this.applyFiles(pendingFiles, text);
      } catch (e: any) {
        errorText = (errorText ? errorText + '\n' : '') + '파일 적용 실패: ' + (e?.message || e);
      }
    }
    this.post({
      type: 'assistantEnd',
      error: errorText,
      aborted: controller.signal.aborted,
      applied,
    });
  }

  /** 파일 변경 전 스냅샷을 남기고 작업 공간에 씁니다. */
  private async applyFiles(files: PendingFile[], prompt: string): Promise<string[]> {
    const root = getRoot();
    if (!root) {
      throw new Error('열려 있는 작업 폴더가 없습니다. 폴더를 연 뒤 다시 시도해 주세요.');
    }
    const valid = files.filter((f) => resolveInRoot(root, f.path));
    if (!valid.length) {
      return [];
    }
    await this.history.snapshot(
      valid.map((f) => f.path),
      prompt
    );
    const applied: string[] = [];
    for (const f of valid) {
      const uri = resolveInRoot(root, f.path)!;
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (openDoc && openDoc.isDirty) {
        // 저장되지 않은 편집이 있으면 WorkspaceEdit 로 바꾸고 저장합니다.
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, openDoc.lineCount, 0), f.content);
        await vscode.workspace.applyEdit(edit);
        await openDoc.save();
      } else {
        await writeText(uri, f.content);
      }
      applied.push(f.path);
    }
    this.hooks.onFilesApplied(applied);
    return applied;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>Code AI</title>
</head>
<body>
  <div class="status" id="status"><span class="dot"></span><span id="statusText">서버 확인 중…</span></div>
  <div class="actions">
    <button data-cmd="codeai.openPreview" title="미리보기 열기">미리보기</button>
    <button data-cmd="codeai.startFromTemplate" title="템플릿으로 시작">템플릿</button>
    <button data-cmd="codeai.deploy" class="primary" title="배포">배포</button>
  </div>
  <main id="log" class="log">
    <div class="welcome" id="welcome">
      <h2>무엇을 만들어 볼까요?</h2>
      <p>원하는 것을 한국어로 설명하면 AI가 파일을 만들고 고쳐 줍니다.</p>
      <div class="examples">
        <button class="example">카페 소개 랜딩페이지 만들어줘</button>
        <button class="example">이 페이지를 다크 모드로 바꿔줘</button>
        <button class="example">README.md 문서를 정리해줘</button>
      </div>
      <p class="tip">팁: 미리보기의 <b>선택 모드</b>로 요소를 클릭하면 "이거 빨간색으로" 처럼 바로 요청할 수 있어요.</p>
    </div>
  </main>
  <details class="history" id="history">
    <summary>변경 기록 <span class="count" id="historyCount">0</span></summary>
    <ul id="historyList"><li class="muted">아직 기록이 없습니다.</li></ul>
  </details>
  <footer class="composer">
    <div class="chips" id="chips"></div>
    <textarea id="input" rows="3" placeholder="메시지를 입력하세요 (Enter: 보내기, Shift+Enter: 줄바꿈)"></textarea>
    <div class="composer-bar">
      <span class="muted small" id="activeFile"></span>
      <span class="spacer"></span>
      <button id="stop" hidden>중지</button>
      <button id="send" class="primary">보내기</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.abort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }
}
