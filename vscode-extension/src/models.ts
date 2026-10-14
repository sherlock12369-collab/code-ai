import * as vscode from 'vscode';
import { checkKey, getModel, hasApiKey, listModels, ModelInfo, setApiKey } from './api';

/** 서버에 연결할 수 없을 때 보여 줄 기본 목록 (Claude 모델만) */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: '고품질 — Claude Opus 5.5 (추천)', price: '$4 / $20' },
  { id: 'claude-sonnet-5-5', label: '균형 — Claude Sonnet 5.5', price: '$2 / $10' },
  { id: 'claude-haiku-5-5', label: '빠름·저렴 — Claude Haiku 5.5', price: '$0.10 / $0.50' },
];

export const SECRET_KEY = 'codeai.claudeApiKey';
const KEY_CONSOLE_URL = 'https://console.anthropic.com/settings/keys';

function shortName(id: string): string {
  return id.replace(/^claude-/, '');
}

/** 상태 표시줄의 모델 표시 (클릭하면 모델 선택, 키가 없으면 키 입력) */
export class ModelStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly sub: vscode.Disposable;

  constructor() {
    this.update();
    this.item.show();
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeai.model')) {
        this.update();
      }
    });
  }

  update(): void {
    const id = getModel();
    const known = FALLBACK_MODELS.find((m) => m.id === id);
    if (!hasApiKey()) {
      this.item.text = '$(key) Code AI: API 키 필요';
      this.item.tooltip = 'Claude API 키가 없습니다. 클릭해서 입력';
      this.item.command = 'codeai.setApiKey';
      return;
    }
    this.item.text = `$(sparkle) Code AI: ${shortName(id)}`;
    this.item.tooltip = `Code AI 모델: ${id}${known ? ` (${known.label})` : ''}\n클릭해서 모델 선택`;
    this.item.command = 'codeai.selectModel';
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}

interface ModelPick extends vscode.QuickPickItem {
  id: string;
}

/** "Code AI: 모델 선택" — 서버의 /api/models 목록에서 골라 설정에 저장한다. */
export async function selectModel(): Promise<void> {
  const current = getModel();
  let models: ModelInfo[] = FALLBACK_MODELS;
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Code AI: 모델 목록 확인 중' },
      () => listModels()
    );
    if (Array.isArray(res.models) && res.models.length) {
      models = res.models.filter((m) => /^claude-/.test(m.id));
    }
  } catch {
    /* 서버 없음 → 기본 목록 */
  }

  const items: ModelPick[] = models.map((m) => ({
    id: m.id,
    label: `${m.id === current ? '$(circle-filled)' : '$(circle-outline)'} ${m.label || m.id}`,
    description: [m.id, m.price && `${m.price} / 100만 토큰`].filter(Boolean).join(' · '),
    detail: m.id === current ? '현재 사용 중' : undefined,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Code AI: 모델 선택 (Claude)',
    placeHolder: '사용할 Claude 모델을 고르세요',
    matchOnDescription: true,
  });
  if (!pick) {
    return;
  }
  await vscode.workspace.getConfiguration('codeai').update('model', pick.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Code AI 모델을 '${pick.id}'(으)로 바꿨습니다.`);
}

/** "Code AI: Claude API 키 입력" — 서버로 키를 확인한 뒤 VS Code SecretStorage에 저장한다. */
export async function promptApiKey(context: vscode.ExtensionContext, onChange: () => void): Promise<boolean> {
  for (;;) {
    const key = await vscode.window.showInputBox({
      title: 'Code AI: Claude API 키 입력',
      prompt: '본인의 Claude API 키(sk-ant-…)를 붙여 넣으세요. 요금은 키 주인의 Anthropic 계정에 청구되며, 키는 VS Code 보안 저장소에만 저장됩니다.',
      placeHolder: 'sk-ant-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() && !/^sk-ant-[\w-]{10,}$/.test(v.trim()) ? 'sk-ant- 로 시작하는 Claude API 키를 입력하세요.' : undefined),
    });
    if (key === undefined) {
      return false;
    }
    if (!key.trim()) {
      const pick = await vscode.window.showInformationMessage('Claude API 키가 필요합니다.', '키 발급 페이지 열기');
      if (pick) {
        void vscode.env.openExternal(vscode.Uri.parse(KEY_CONSOLE_URL));
      }
      return false;
    }
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Code AI: API 키 확인 중…' },
      () => checkKey(key.trim())
    );
    if (res.ok) {
      await context.secrets.store(SECRET_KEY, key.trim());
      setApiKey(key.trim());
      onChange();
      vscode.window.showInformationMessage('Claude API 키가 확인되어 저장되었습니다.');
      return true;
    }
    const again = await vscode.window.showErrorMessage(res.error || '키를 확인하지 못했습니다.', '다시 입력');
    if (!again) {
      return false;
    }
  }
}

export async function clearApiKey(context: vscode.ExtensionContext, onChange: () => void): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  setApiKey(undefined);
  onChange();
  vscode.window.showInformationMessage('저장된 Claude API 키를 삭제했습니다.');
}
