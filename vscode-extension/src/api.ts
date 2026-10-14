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
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'file'; path: string; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export const UNREACHABLE_MESSAGE =
  'Code AI 서버에 연결할 수 없습니다. 서버가 실행 중인지, 설정의 "codeai.serverUrl" 주소가 올바른지 확인해 주세요.';

export class ServerError extends Error {
  constructor(message: string, public readonly unreachable = false) {
    super(message);
  }
}

export function getServerUrl(): string {
  const raw = vscode.workspace.getConfiguration('codeai').get<string>('serverUrl') || 'http://localhost:8787';
  return raw.replace(/\/+$/, '');
}

function isConnectionError(err: NodeJS.ErrnoException): boolean {
  return ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(
    err.code || ''
  );
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onResponse: (res: http.IncomingMessage) => void;
  onError: (err: Error) => void;
}

function request(opts: RequestOptions): void {
  let url: URL;
  try {
    url = new URL(getServerUrl() + opts.path);
  } catch {
    opts.onError(new ServerError('서버 주소 형식이 올바르지 않습니다: ' + getServerUrl()));
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

function jsonRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request({
      method,
      path,
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

export function deploy(name: string, files: FilePayload[]): Promise<{ url: string }> {
  return jsonRequest('POST', '/api/deploy', { name, files }, 120000);
}

/**
 * POST /api/chat 을 호출하고 SSE 이벤트를 하나씩 onEvent 로 전달합니다.
 * 스트림이 끝나면 resolve 됩니다. 연결 실패는 ServerError 로 reject 됩니다.
 */
export function streamChat(body: ChatRequest, onEvent: (ev: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
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
