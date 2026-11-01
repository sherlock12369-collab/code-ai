import * as vscode from 'vscode';
import { checkKey, getModel, hasApiKey, keyProvider, listModels, ModelInfo, providerOfKey, providerOfModel, setApiKey } from './api';

/** 서버에 연결할 수 없을 때 보여 줄 기본 목록 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-flash', provider: 'gemini', label: '무료 — Gemini 3.8 Flash (추천)', price: '무료' },
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', label: '무료·많이 — Gemini 3.5 Flash-Lite', price: '무료' },
  { id: 'claude-opus-5-5', provider: 'claude', label: '고품질 — Claude Opus 5.5 (추천)', price: '$4 / $20' },
  { id: 'claude-sonnet-5-5', provider: 'claude', label: '균형 — Claude Sonnet 5.5', price: '$2 / $10' },
  { id: 'claude-haiku-5-5', provider: 'claude', label: '빠름·저렴 — Claude Haiku 5.5', price: '$0.10 / $0.50' },
];

// 키 이름은 예전 그대로 둔다 (1.1에서 저장한 Claude 키를 계속 쓰도록).
export const SECRET_KEY = 'codeai.claudeApiKey';
const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
const CLAUDE_KEY_URL = 'https://console.anthropic.com/settings/keys';

function shortName(id: string): string {
  return id.replace(/^(claude|gemini)-/, '');
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
      this.item.tooltip = 'API 키가 없습니다. 클릭해서 무료 Gemini 키 입력';
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
  const provider = keyProvider();
  let models: ModelInfo[] = FALLBACK_MODELS.filter((m) => m.provider === provider);
  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Code AI: 모델 목록 확인 중' },
      () => listModels()
    );
    if (Array.isArray(res.models) && res.models.length) {
      const own = res.models.filter((m) => /^(claude|gemini)-/.test(m.id) && providerOfModel(m.id) === provider);
      if (own.length) {
        models = own;
      }
    }
  } catch {
    /* 서버 없음 → 기본 목록 */
  }

  const items: ModelPick[] = models.map((m) => ({
    id: m.id,
    label: `${m.id === current ? '$(circle-filled)' : '$(circle-outline)'} ${m.label || m.id}`,
    description: [m.id, m.price && (m.price === '무료' ? '무료 (하루 횟수 제한)' : `${m.price} / 100만 토큰`)].filter(Boolean).join(' · '),
    detail: m.id === current ? '현재 사용 중' : undefined,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: `Code AI: 모델 선택 (${provider === 'gemini' ? 'Gemini 무료' : 'Claude'})`,
    placeHolder: '사용할 모델을 고르세요 (저장된 API 키의 모델만 보입니다)',
    matchOnDescription: true,
  });
  if (!pick) {
    return;
  }
  await vscode.workspace.getConfiguration('codeai').update('model', pick.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Code AI 모델을 '${pick.id}'(으)로 바꿨습니다.`);
}

/** "Code AI: API 키 입력" — 서버로 키를 확인한 뒤 VS Code SecretStorage에 저장한다. */
export async function promptApiKey(context: vscode.ExtensionContext, onChange: () => void): Promise<boolean> {
  for (;;) {
    const key = await vscode.window.showInputBox({
      title: 'Code AI: API 키 입력',
      prompt: '무료 Gemini 키(AIza…, aistudio.google.com 에서 카드 없이 발급) 또는 Claude 키(sk-ant-…, 유료)를 붙여 넣으세요. 키는 VS Code 보안 저장소에만 저장됩니다.',
      placeHolder: 'AIza… 또는 sk-ant-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim() && !/^sk-ant-[\w-]{10,}$/.test(v.trim()) && !/^AIza[\w-]{20,}$/.test(v.trim())
          ? 'AIza… (Gemini) 또는 sk-ant-… (Claude) 로 시작하는 키를 입력하세요.'
          : undefined,
    });
    if (key === undefined) {
      return false;
    }
    if (!key.trim()) {
      const pick = await vscode.window.showInformationMessage('API 키가 필요합니다.', '무료 Gemini 키 받기', 'Claude 키 받기');
      if (pick) {
        void vscode.env.openExternal(vscode.Uri.parse(pick === 'Claude 키 받기' ? CLAUDE_KEY_URL : GEMINI_KEY_URL));
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
      vscode.window.showInformationMessage(`${providerOfKey(key.trim()) === 'gemini' ? '무료 Gemini' : 'Claude'} API 키가 확인되어 저장되었습니다.`);
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
  vscode.window.showInformationMessage('저장된 API 키를 삭제했습니다.');
}
