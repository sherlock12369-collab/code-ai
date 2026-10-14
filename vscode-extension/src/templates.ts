import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getRoot } from './workspace';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  dir: string;
}

export const PENDING_PREVIEW_KEY = 'codeai.pendingTemplatePreview';

const FALLBACK_NAMES: Record<string, string> = {
  shop: '쇼핑몰',
  portfolio: '포트폴리오',
  landing: '랜딩페이지',
  report: '보고서(문서)',
};

/** 패키지에 포함된 templates/ 폴더(없으면 개발용 ../shared/templates)를 찾습니다. */
function templatesDir(context: vscode.ExtensionContext): string | undefined {
  const candidates = [
    path.join(context.extensionPath, 'templates'),
    path.join(context.extensionPath, '..', 'shared', 'templates'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory() && fs.readdirSync(c).length > 0) {
        return c;
      }
    } catch {
      /* 없음 */
    }
  }
  return undefined;
}

export function listTemplates(context: vscode.ExtensionContext): TemplateInfo[] {
  const dir = templatesDir(context);
  if (!dir) {
    return [];
  }
  const result: TemplateInfo[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const tdir = path.join(dir, entry.name);
    let meta: { name?: string; description?: string } = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(tdir, 'template.json'), 'utf8'));
    } catch {
      /* template.json 없음 → 기본값 사용 */
    }
    result.push({
      id: entry.name,
      name: meta.name || FALLBACK_NAMES[entry.name] || entry.name,
      description: meta.description || '',
      dir: tdir,
    });
  }
  const order = ['landing', 'portfolio', 'shop', 'report'];
  return result.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name, 'ko');
  });
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (!(dir === base && e.name === 'template.json')) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

async function copyTemplate(t: TemplateInfo, target: vscode.Uri): Promise<string[]> {
  const files = listFiles(t.dir);
  for (const rel of files) {
    const dest = vscode.Uri.joinPath(target, ...rel.split('/'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dest, '..'));
    await vscode.workspace.fs.writeFile(dest, fs.readFileSync(path.join(t.dir, ...rel.split('/'))));
  }
  return files;
}

function pickEntry(files: string[]): string | undefined {
  return (
    files.find((f) => /^index\.html?$/i.test(f)) ||
    files.find((f) => /^README\.md$/i.test(f)) ||
    files.find((f) => /\.(html?|md)$/i.test(f))
  );
}

/** 명령: 템플릿으로 시작 */
export async function startFromTemplate(context: vscode.ExtensionContext): Promise<void> {
  const templates = listTemplates(context);
  if (!templates.length) {
    vscode.window.showWarningMessage(
      '사용할 수 있는 템플릿이 없습니다. 확장 설치 폴더의 templates 폴더를 확인해 주세요.'
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    templates.map((t) => ({ label: t.name, description: t.id, detail: t.description, t })),
    { title: 'Code AI: 템플릿으로 시작', placeHolder: '시작할 템플릿을 고르세요', matchOnDetail: true }
  );
  if (!picked) {
    return;
  }
  const t = picked.t;

  const root = getRoot();
  let target: vscode.Uri | undefined;
  let openAsFolder = false;
  if (root) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '현재 작업 폴더에 만들기', description: root.fsPath, value: 'here' },
        { label: '현재 폴더 안의 새 하위 폴더에 만들기', description: `${t.id}/`, value: 'sub' },
        { label: '다른 폴더 선택…', description: '선택한 폴더를 새 창으로 엽니다', value: 'other' },
      ],
      { title: `${t.name} 템플릿`, placeHolder: '어디에 만들까요?' }
    );
    if (!choice) {
      return;
    }
    if (choice.value === 'here') {
      target = root;
    } else if (choice.value === 'sub') {
      const name = await vscode.window.showInputBox({ prompt: '새 폴더 이름', value: t.id, validateInput: (v) => (/^[^\\/:*?"<>|]+$/.test(v.trim()) ? undefined : '올바른 폴더 이름을 입력하세요') });
      if (!name) {
        return;
      }
      target = vscode.Uri.joinPath(root, name.trim());
    } else {
      openAsFolder = true;
    }
  } else {
    openAsFolder = true;
  }

  if (openAsFolder) {
    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: '이 폴더에 만들기',
      title: '템플릿을 만들 폴더를 선택하세요',
    });
    if (!sel?.[0]) {
      return;
    }
    target = sel[0];
  }
  if (!target) {
    return;
  }

  // 덮어쓰기 확인
  const files = listFiles(t.dir);
  const conflicts: string[] = [];
  for (const rel of files) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(target, ...rel.split('/')));
      conflicts.push(rel);
    } catch {
      /* 없음 */
    }
  }
  if (conflicts.length) {
    const ok = await vscode.window.showWarningMessage(
      `이미 있는 파일 ${conflicts.length}개를 덮어씁니다: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ' …' : ''}`,
      { modal: true },
      '덮어쓰기'
    );
    if (ok !== '덮어쓰기') {
      return;
    }
  }

  try {
    await copyTemplate(t, target);
  } catch (e: any) {
    vscode.window.showErrorMessage('템플릿을 복사하지 못했습니다: ' + (e?.message || e));
    return;
  }

  const entry = pickEntry(files);
  if (openAsFolder) {
    await context.globalState.update(PENDING_PREVIEW_KEY, { folder: target.toString(), entry });
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: !!root });
    return;
  }
  vscode.window.showInformationMessage(`'${t.name}' 템플릿으로 시작했습니다.`);
  if (entry) {
    const uri = vscode.Uri.joinPath(target, ...entry.split('/'));
    await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('codeai.openPreview', uri);
  }
}
