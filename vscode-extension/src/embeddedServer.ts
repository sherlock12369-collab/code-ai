import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';

// 확장 안에 들어 있는 AI 서버(server/server.bundle.mjs)를 확장 호스트 안에서 직접 실행한다.
// 그래서 다른 PC에서도 서버를 따로 설치하거나 켤 필요가 없다.

// TypeScript(commonjs)가 import()를 require()로 바꾸지 않게 한다 (ESM 번들을 불러오기 위해).
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

let starting: Promise<string> | undefined;

/** 내장 서버를 (한 번만) 시작하고 주소를 돌려준다. */
export function startEmbeddedServer(context: vscode.ExtensionContext): Promise<string> {
  starting ??= (async () => {
    const entry = path.join(context.extensionPath, 'server', 'server.bundle.mjs');
    if (!fs.existsSync(entry)) {
      throw new Error('확장에 내장 AI 서버 파일이 없습니다: ' + entry);
    }
    const mod = await dynamicImport(pathToFileURL(entry).href);
    const dataDir = path.join(context.globalStorageUri.fsPath, 'server-data');
    fs.mkdirSync(dataDir, { recursive: true });
    // 127.0.0.1에만 열고, 포트는 비어 있는 것을 자동으로 고른다.
    const { server, url } = await mod.startServer({ port: 0, host: '127.0.0.1', dataDir });
    context.subscriptions.push({ dispose: () => server.close() });
    return url as string;
  })();
  return starting;
}
