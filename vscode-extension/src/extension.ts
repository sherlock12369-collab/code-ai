import * as vscode from 'vscode';
import { ServerError, UNREACHABLE_MESSAGE, health, setApiKey, setEmbeddedServerUrl } from './api';
import { startEmbeddedServer } from './embeddedServer';
import { ChatViewProvider } from './chatView';
import { deployWorkspace } from './deploy';
import { HistoryStore } from './history';
import { clearApiKey, ModelStatus, promptApiKey, SECRET_KEY, selectModel } from './models';
import { PreviewManager, previewKind } from './preview';
import { PreviewServer } from './previewServer';
import { PENDING_PREVIEW_KEY, startFromTemplate } from './templates';
import { getRoot, resolveInRoot } from './workspace';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 사용자의 Claude API 키는 VS Code 보안 저장소(SecretStorage)에 둔다.
  setApiKey(await context.secrets.get(SECRET_KEY));
  // 확장에 들어 있는 AI 서버를 켠다 (다른 PC에서도 서버 설치 불필요)
  try {
    setEmbeddedServerUrl(await startEmbeddedServer(context));
  } catch (e: any) {
    console.error('[Code AI] 내장 서버 시작 실패', e);
    void vscode.window.showWarningMessage('Code AI 내장 AI 서버를 시작하지 못했습니다: ' + (e?.message || e));
  }
  const modelStatus = new ModelStatus();
  const askKey = () => promptApiKey(context, () => modelStatus.update());
  const history = new HistoryStore();
  const server = new PreviewServer(vscode.Uri.joinPath(context.extensionUri, 'media', 'inject.js'));

  let preview: PreviewManager;
  const chat = new ChatViewProvider(context, history, {
    onFilesApplied: (paths) => {
      preview?.scheduleRefresh(100);
      const root = getRoot();
      if (!root) {
        return;
      }
      const autoOpen = vscode.workspace.getConfiguration('codeai').get<boolean>('autoOpenPreview', true);
      if (!preview.isOpen && autoOpen) {
        const html = paths.find((p) => /(^|\/)index\.html?$/i.test(p)) || paths.find((p) => /\.(html?|md)$/i.test(p));
        const uri = html && resolveInRoot(root, html);
        if (uri) {
          void preview.open(uri);
        }
      }
    },
  });
  preview = new PreviewManager(context, server, (sel) => void chat.attachSelection(sel));

  context.subscriptions.push(
    server,
    preview,
    chat,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('codeai.openPreview', async (uri?: vscode.Uri) => {
      await preview.open(uri instanceof vscode.Uri ? uri : undefined);
    }),

    vscode.commands.registerCommand('codeai.deploy', async () => {
      try {
        const res = await deployWorkspace();
        if (!res) {
          return;
        }
        const skippedNote = res.skipped.length ? ` (이진 파일 ${res.skipped.length}개 제외)` : '';
        chat.notify('deploy', `배포 완료! 파일 ${res.count}개${skippedNote}. 공유 링크:`, res.url);
        const pick = await vscode.window.showInformationMessage(`배포 완료: ${res.url}`, '링크 복사', '브라우저에서 열기');
        if (pick === '링크 복사') {
          await vscode.env.clipboard.writeText(res.url);
          vscode.window.showInformationMessage('링크를 복사했습니다.');
        } else if (pick === '브라우저에서 열기') {
          await vscode.env.openExternal(vscode.Uri.parse(res.url));
        }
      } catch (e: any) {
        const msg = e instanceof ServerError ? e.message : e?.message || String(e);
        chat.notify('error', msg);
        vscode.window.showErrorMessage(msg);
      }
    }),

    vscode.commands.registerCommand('codeai.startFromTemplate', () => startFromTemplate(context)),

    vscode.commands.registerCommand('codeai.showHistory', async () => {
      const items = await history.list();
      if (!items.length) {
        vscode.window.showInformationMessage('아직 변경 기록이 없습니다.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        items.map((h) => ({
          label: h.label || '(설명 없음)',
          description: new Date(h.time).toLocaleString('ko-KR'),
          detail: h.files.map((f) => f.path).join(', '),
          id: h.id,
        })),
        { title: 'Code AI: 변경 기록', placeHolder: '되돌릴 시점을 고르세요 (해당 변경 이전 상태로 복구)' }
      );
      if (pick) {
        await vscode.commands.executeCommand('codeai.restoreHistory', pick.id);
      }
    }),

    vscode.commands.registerCommand('codeai.restoreHistory', async (id: string) => {
      if (!id) {
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        '이 변경 이전 상태로 파일을 되돌릴까요? 현재 상태도 기록에 저장되므로 다시 되돌릴 수 있습니다.',
        { modal: true },
        '되돌리기'
      );
      if (ok !== '되돌리기') {
        return;
      }
      try {
        const entry = await history.restore(id);
        preview.scheduleRefresh(100);
        const msg = `${entry.files.length}개 파일을 되돌렸습니다.`;
        chat.notify('info', msg);
        vscode.window.showInformationMessage(msg);
      } catch (e: any) {
        vscode.window.showErrorMessage('되돌리기 실패: ' + (e?.message || e));
      }
    }),

    modelStatus,
    vscode.commands.registerCommand('codeai.selectModel', () => selectModel()),
    vscode.commands.registerCommand('codeai.setApiKey', () => askKey()),
    vscode.commands.registerCommand('codeai.clearApiKey', () => clearApiKey(context, () => modelStatus.update())),
    context.secrets.onDidChange(async (ev) => {
      if (ev.key === SECRET_KEY) {
        setApiKey(await context.secrets.get(SECRET_KEY));
        modelStatus.update();
      }
    }),

    vscode.commands.registerCommand('codeai.newChat', () => chat.newChat()),

    vscode.commands.registerCommand('codeai.checkServer', async () => {
      try {
        const h = await health();
        vscode.window.showInformationMessage(`Code AI 서버 연결됨${h.model ? ` · 모델: ${h.model}` : ''}${h.version ? ` · v${h.version}` : ''}`);
      } catch (e: any) {
        vscode.window.showErrorMessage(e instanceof ServerError ? e.message : UNREACHABLE_MESSAGE);
      }
      void chat.checkServer();
    })
  );

  // 템플릿으로 새 폴더를 연 직후라면 시작 파일과 미리보기를 엽니다.
  const pending = context.globalState.get<{ folder: string; entry?: string }>(PENDING_PREVIEW_KEY);
  const root = getRoot();
  if (pending && root && root.toString() === pending.folder) {
    void context.globalState.update(PENDING_PREVIEW_KEY, undefined);
    const uri = pending.entry ? resolveInRoot(root, pending.entry) : undefined;
    if (uri && previewKind(uri)) {
      void vscode.window
        .showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.One })
        .then(() => preview.open(uri));
    }
  }
}

export function deactivate(): void {
  /* 리소스는 context.subscriptions 로 정리됩니다 */
}
