import * as path from 'path';
import * as vscode from 'vscode';
import { FilePayload } from './api';

export const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/.codeai/**,**/.vscode/**,**/*.vsix}';

const TEXT_EXTS = new Set([
  '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.markdown',
  '.txt', '.svg', '.xml', '.vue', '.svelte', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php',
  '.sh', '.yml', '.yaml', '.toml', '.ini', '.env', '.csv', '.sql', '.kt', '.swift', '.dart', '.lua', '.webmanifest',
  '.map', '.gitignore', '',
]);

export function getRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function requireRoot(): vscode.Uri {
  const root = getRoot();
  if (!root) {
    throw new Error('열려 있는 작업 폴더가 없습니다. 먼저 폴더를 열어 주세요.');
  }
  return root;
}

/** 작업 공간 기준 상대 경로를 안전하게 Uri 로 바꿉니다. 작업 공간 밖을 가리키면 undefined. */
export function resolveInRoot(root: vscode.Uri, relPath: string): vscode.Uri | undefined {
  const clean = relPath.replace(/\\/g, '/').replace(/^\.?\/+/, '').trim();
  if (!clean || path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    return undefined;
  }
  const parts = clean.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) {
    return undefined;
  }
  return vscode.Uri.joinPath(root, ...parts);
}

export function toRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

export function isTextFile(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (base.startsWith('.') && !path.extname(base.slice(1))) {
    return true;
  }
  return TEXT_EXTS.has(path.extname(p).toLowerCase());
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

export async function writeText(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 400 * 1024;

/**
 * 채팅 요청에 함께 보낼 파일을 모읍니다.
 * 우선순위: 활성 편집기 → 열린 탭 → 선택된 파일 → 작업 공간의 웹 관련 파일.
 */
export async function collectContextFiles(extra: string[] = []): Promise<FilePayload[]> {
  const root = getRoot();
  if (!root) {
    return [];
  }
  const max = vscode.workspace.getConfiguration('codeai').get<number>('maxContextFiles') ?? 20;
  const ordered: vscode.Uri[] = [];
  const seen = new Set<string>();
  const push = (u: vscode.Uri | undefined) => {
    if (!u || u.scheme !== 'file' || seen.has(u.toString())) {
      return;
    }
    const rel = toRelative(u);
    if (rel === u.fsPath || rel.startsWith('..') || /(^|\/)(node_modules|\.git|\.codeai)\//.test(rel)) {
      return;
    }
    seen.add(u.toString());
    ordered.push(u);
  };

  push(vscode.window.activeTextEditor?.document.uri);
  for (const rel of extra) {
    push(resolveInRoot(root, rel));
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        push(tab.input.uri);
      }
    }
  }
  const found = await vscode.workspace.findFiles(
    '**/*.{html,htm,css,js,mjs,jsx,ts,tsx,json,md,svg,vue,svelte}',
    EXCLUDE_GLOB,
    200
  );
  found.sort((a, b) => toRelative(a).split('/').length - toRelative(b).split('/').length);
  for (const f of found) {
    if (/package-lock\.json$|\.min\.(js|css)$/.test(f.path)) {
      continue;
    }
    push(f);
  }

  const files: FilePayload[] = [];
  let total = 0;
  for (const uri of ordered) {
    if (files.length >= max) {
      break;
    }
    if (!isTextFile(uri.path)) {
      continue;
    }
    try {
      const content = await readText(uri);
      const size = Buffer.byteLength(content, 'utf8');
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) {
        continue;
      }
      total += size;
      files.push({ path: toRelative(uri), content });
    } catch {
      /* 읽기 실패 무시 */
    }
  }
  return files;
}
