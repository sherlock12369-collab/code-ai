import * as vscode from 'vscode';
import { exists, getRoot, resolveInRoot, writeText } from './workspace';

export interface HistoryFileEntry {
  path: string;
  existed: boolean;
}

export interface HistoryEntry {
  id: string;
  time: number;
  label: string;
  files: HistoryFileEntry[];
}

/**
 * AI 가 파일을 수정하기 전에 원래 내용을 .codeai/history/<id>/ 에 저장합니다.
 *   meta.json       — HistoryEntry
 *   files/<path>    — 수정 전 내용 (기존에 있던 파일만)
 */
export class HistoryStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private dir(root: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(root, '.codeai', 'history');
  }

  async snapshot(paths: string[], label: string): Promise<HistoryEntry | undefined> {
    const root = getRoot();
    if (!root || !paths.length) {
      return undefined;
    }
    const now = Date.now();
    const id = `${now}-${Math.random().toString(36).slice(2, 7)}`;
    const base = vscode.Uri.joinPath(this.dir(root), id);
    const files: HistoryFileEntry[] = [];
    for (const p of Array.from(new Set(paths))) {
      const uri = resolveInRoot(root, p);
      if (!uri) {
        continue;
      }
      const existed = await exists(uri);
      if (existed) {
        const target = resolveInRoot(vscode.Uri.joinPath(base, 'files'), p)!;
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
        await vscode.workspace.fs.copy(uri, target, { overwrite: true });
      }
      files.push({ path: p, existed });
    }
    const entry: HistoryEntry = { id, time: now, label: label.slice(0, 120), files };
    await writeText(vscode.Uri.joinPath(base, 'meta.json'), JSON.stringify(entry, null, 2));
    await this.ensureGitignore(root);
    this._onDidChange.fire();
    return entry;
  }

  async list(): Promise<HistoryEntry[]> {
    const root = getRoot();
    if (!root) {
      return [];
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.dir(root));
    } catch {
      return [];
    }
    const result: HistoryEntry[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir(root), name, 'meta.json'));
        result.push(JSON.parse(Buffer.from(raw).toString('utf8')));
      } catch {
        /* 손상된 항목 무시 */
      }
    }
    return result.sort((a, b) => b.time - a.time);
  }

  /** 스냅샷 시점으로 되돌립니다. 되돌리기 전 현재 상태도 스냅샷으로 남깁니다. */
  async restore(id: string): Promise<HistoryEntry> {
    const root = getRoot();
    if (!root) {
      throw new Error('열려 있는 작업 폴더가 없습니다.');
    }
    const entry = (await this.list()).find((e) => e.id === id);
    if (!entry) {
      throw new Error('변경 기록을 찾을 수 없습니다.');
    }
    await this.snapshot(
      entry.files.map((f) => f.path),
      `되돌리기 전 상태 (${new Date(entry.time).toLocaleString('ko-KR')} 복구)`
    );
    const base = vscode.Uri.joinPath(this.dir(root), id, 'files');
    for (const f of entry.files) {
      const target = resolveInRoot(root, f.path);
      if (!target) {
        continue;
      }
      if (f.existed) {
        const saved = resolveInRoot(base, f.path)!;
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
        await vscode.workspace.fs.copy(saved, target, { overwrite: true });
      } else if (await exists(target)) {
        await vscode.workspace.fs.delete(target, { useTrash: true });
      }
    }
    this._onDidChange.fire();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const root = getRoot();
    if (!root) {
      return;
    }
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir(root), id), { recursive: true, useTrash: false });
    this._onDidChange.fire();
  }

  private async ensureGitignore(root: vscode.Uri): Promise<void> {
    const gi = vscode.Uri.joinPath(root, '.codeai', '.gitignore');
    if (!(await exists(gi))) {
      await writeText(gi, '*\n');
    }
  }
}
