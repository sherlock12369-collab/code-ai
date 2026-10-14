import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface FilePayload {
  path: string;
  content: string;
}

export interface Selection {
  selector: string;
  html: string;
  file: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  files?: FilePayload[];
  selection?: Selection;
  model?: string;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'file'; path: string; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export const UNREACHABLE_MESSAGE =
  'Code AI 서버에 연결할 수 없습니다. 설정 "codeai.serverUrl"을 비워 두면 확장에 내장된 서버를 사용합니다. 직접 지정했다면 주소가 올바른지 확인해 주세요.';

export class ServerError extends Error {
  constructor(message: string, public readonly unreachable = false) {
    super(message);
  }
}

// 확장에 내장된 AI 서버 주소 (extension.ts가 시작한 뒤 넣어 준다)
let embeddedUrl: string | undefined;
export function setEmbeddedServerUrl(url: string | undefined): void {
  embeddedUrl = url;
}

/** 설정 "codeai.serverUrl"이 비어 있으면 내장 서버를 쓴다. */
export function getServerUrl(): string {
  const raw = (vscode.workspace.getConfiguration('codeai').get<string>('serverUrl') || '').trim();
  return (raw || embeddedUrl || 'http://localhost:8787').replace(/\/+$/, '');
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

// 사용자의 Claude API 키 (SecretStorage에서 읽어 extension.ts가 넣어 준다). 서버에 x-api-key 헤더로 보낸다.
let apiKey: string | undefined;
export function setApiKey(key: string | undefined): void {
  apiKey = key || undefined;
}
export function hasApiKey(): boolean {
  return !!apiKey;
}

export const NO_KEY_MESSAGE = 'Claude API 키가 없습니다. 명령 "Code AI: Claude API 키 입력"으로 본인의 키를 입력해 주세요.';

/** 설정 "codeai.model" 에서 고른 모델 id */
export function getModel(): string {
  return vscode.workspace.getConfiguration('codeai').get<string>('model') || DEFAULT_MODEL;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** 100만 토큰당 입력 / 출력 요금 (USD) */
  price: string;
}

export function listModels(): Promise<{ models: ModelInfo[]; default?: string }> {
  return jsonRequest('GET', '/api/models', undefined, 8000);
}

function isConnectionError(err: NodeJS.ErrnoException): boolean {
  return ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(
    err.code || ''
  );
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  /** 지정하면 이 키를, 아니면 저장된 키를 x-api-key 헤더로 보낸다 (/api/chat, /api/check-key만) */
  key?: string;
  /** 지정하면 codeai.serverUrl 대신 이 서버로 보낸다 (배포 서버) */
  base?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onResponse: (res: http.IncomingMessage) => void;
  onError: (err: Error) => void;
}

function request(opts: RequestOptions): void {
  const base = opts.base || getServerUrl();
  let url: URL;
  try {
    url = new URL(base + opts.path);
  } catch {
    opts.onError(new ServerError('서버 주소 형식이 올바르지 않습니다: ' + base));
    return;
  }
  const lib = url.protocol === 'https:' ? https : http;
  const data = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : undefined;
  const req = lib.request(
    url,
    {
      method: opts.method,
      headers: {
        Accept: opts.path === '/api/chat' ? 'text/event-stream' : 'application/json',
        ...((opts.path === '/api/chat' || opts.path === '/api/check-key') && (opts.key || apiKey)
          ? { 'x-api-key': (opts.key || apiKey) as string }
          : {}),
        ...(data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {}),
      },
    },
    opts.onResponse
  );
  req.on('error', (err: NodeJS.ErrnoException) => {
    if (opts.signal?.aborted) {
      return;
    }
    opts.onError(isConnectionError(err) ? new ServerError(UNREACHABLE_MESSAGE, true) : new ServerError('요청 실패: ' + err.message));
  });
  if (opts.timeoutMs) {
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
  }
  opts.signal?.addEventListener('abort', () => req.destroy());
  if (data) {
    req.write(data);
  }
  req.end();
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function jsonRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 60000,
  key?: string,
  base?: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request({
      method,
      path,
      key,
      base,
      body,
      timeoutMs,
      onError: reject,
      onResponse: async (res) => {
        try {
          const text = await readBody(res);
          let parsed: any;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = undefined;
          }
          if ((res.statusCode || 500) >= 400) {
            const msg = parsed?.error || parsed?.message || text || `HTTP ${res.statusCode}`;
            reject(new ServerError(`서버 오류 (${res.statusCode}): ${msg}`));
            return;
          }
          if (parsed === undefined) {
            reject(new ServerError('서버 응답을 해석할 수 없습니다.'));
            return;
          }
          resolve(parsed as T);
        } catch (e) {
          reject(e);
        }
      },
    });
  });
}

export function health(): Promise<{ ok: boolean; model?: string; version?: string }> {
  return jsonRequest('GET', '/api/health', undefined, 5000);
}

/** 키가 올바른지 서버로 확인한다 (요금 없음). */
export async function checkKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    return await jsonRequest<{ ok: boolean; error?: string }>('POST', '/api/check-key', {}, 20000, key);
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function deploy(name: string, files: FilePayload[]): Promise<{ url: string }> {
  // 공용 배포 서버(공유 링크). 비워 두면 codeai.serverUrl 서버에 배포한다.
  const deployBase = (vscode.workspace.getConfiguration('codeai').get<string>('deployServerUrl') || '').trim().replace(/\/+$/, '');
  return jsonRequest('POST', '/api/deploy', { name, files }, 120000, undefined, deployBase || undefined);
}

/**
 * POST /api/chat 을 호출하고 SSE 이벤트를 하나씩 onEvent 로 전달합니다.
 * 스트림이 끝나면 resolve 됩니다. 연결 실패는 ServerError 로 reject 됩니다.
 */
export function streamChat(body: ChatRequest, onEvent: (ev: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!apiKey) {
    return Promise.reject(new ServerError(NO_KEY_MESSAGE));
  }
  return new Promise<void>((resolve, reject) => {
    request({
      method: 'POST',
      path: '/api/chat',
      body,
      signal,
      onError: reject,
      onResponse: async (res) => {
        if ((res.statusCode || 500) >= 400) {
          const text = await readBody(res).catch(() => '');
          let msg = text;
          try {
            const j = JSON.parse(text);
            msg = j.error || j.message || text;
          } catch {
            /* ignore */
          }
          reject(new ServerError(`서버 오류 (${res.statusCode}): ${msg || '알 수 없는 오류'}`));
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        let finished = false;
        const flush = (block: string) => {
          const dataLines = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''));
          if (!dataLines.length) {
            return;
          }
          const payload = dataLines.join('\n');
          if (payload === '[DONE]') {
            return;
          }
          try {
            const ev = JSON.parse(payload) as ChatEvent;
            if (ev.type === 'done') {
              finished = true;
            }
            onEvent(ev);
          } catch {
            /* 잘못된 이벤트는 무시 */
          }
        };
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, idx);
            const sepLen = buffer.slice(idx).match(/^\r?\n\r?\n/)![0].length;
            buffer = buffer.slice(idx + sepLen);
            flush(block);
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            flush(buffer);
          }
          if (!finished) {
            onEvent({ type: 'done' });
          }
          resolve();
        });
        res.on('error', (e) => (signal?.aborted ? resolve() : reject(new ServerError('응답 수신 중 오류: ' + e.message))));
        signal?.addEventListener('abort', () => {
          res.destroy();
          resolve();
        });
      },
    });
  });
}
