import * as path from 'path';
import * as vscode from 'vscode';
import { deploy, FilePayload, ServerError } from './api';
import { EXCLUDE_GLOB, isTextFile, readText, requireRoot, toRelative } from './workspace';

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const BINARY_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export interface DeployResult {
  url: string;
  count: number;
  skipped: string[];
}

/** 작업 공간 파일을 /api/deploy 로 보내고 공유 링크를 받습니다. */
export async function deployWorkspace(): Promise<DeployResult | undefined> {
  const root = requireRoot();
  const name =
    path
      .basename(root.fsPath)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'my-site';

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Code AI: 배포 중…', cancellable: false },
    async (progress) => {
      progress.report({ message: '파일 모으는 중' });
      // 저장되지 않은 파일이 있으면 먼저 저장
      await vscode.workspace.saveAll(false);
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), EXCLUDE_GLOB, MAX_FILES + 1);
      if (!uris.length) {
        throw new Error('배포할 파일이 없습니다.');
      }
      if (uris.length > MAX_FILES) {
        throw new Error(`파일이 너무 많습니다 (최대 ${MAX_FILES}개).`);
      }
      const files: FilePayload[] = [];
      const skipped: string[] = [];
      let total = 0;
      for (const uri of uris) {
        const rel = toRelative(uri);
        let content: string;
        if (isTextFile(uri.path)) {
          content = await readText(uri);
        } else {
          // 이미지 등 바이너리는 서버 규약에 따라 data URI(base64)로 보냄
          const mime = BINARY_MIME[path.extname(uri.path).toLowerCase()];
          if (!mime) {
            skipped.push(rel);
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          content = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
        }
        total += Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL_BYTES) {
          throw new Error('프로젝트 용량이 너무 큽니다 (최대 20MB).');
        }
        files.push({ path: rel, content });
      }
      if (!files.length) {
        throw new Error('배포할 텍스트 파일이 없습니다.');
      }
      if (!files.some((f) => /(^|\/)index\.html?$/i.test(f.path))) {
        const ok = await vscode.window.showWarningMessage(
          'index.html 파일이 없습니다. 그래도 배포할까요?',
          { modal: true },
          '배포'
        );
        if (ok !== '배포') {
          return undefined;
        }
      }
      progress.report({ message: `${files.length}개 파일 업로드 중` });
      try {
        const res = await deploy(name, files);
        if (!res?.url) {
          throw new Error('서버가 배포 주소를 돌려주지 않았습니다.');
        }
        return { url: res.url, count: files.length, skipped };
      } catch (e) {
        if (e instanceof ServerError) {
          throw e;
        }
        throw new Error('배포 실패: ' + ((e as Error)?.message || e));
      }
    }
  );
}
