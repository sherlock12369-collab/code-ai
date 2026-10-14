import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileBlocks } from './lib/fileBlocks.js';
import { buildMessages } from './lib/prompt.js';
import { deploySite, DeployError } from './lib/deploy.js';
import { safeRelativePath } from './lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = '1.0.0';

export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || '0.0.0.0',
    ollamaUrl: (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    model: env.MODEL || 'qwen2.5-coder:7b',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    updatesFile: path.join(__dirname, 'updates', 'latest.json'),
    downloadsDir: path.join(__dirname, 'downloads'),
  };
}

const MAX_BODY = 50 * 1024 * 1024; // 50MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('JSON 형식이 올바르지 않습니다.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function baseUrl(cfg, req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  return `http://${req.headers.host || `localhost:${cfg.port}`}`;
}

// ---------- /api/chat ----------

const OLLAMA_DOWN_MSG = 'AI 모델 서버에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.';

async function handleChat(cfg, req, res) {
  const body = await readJsonBody(req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    send({ type: 'error', message: '메시지가 비어 있습니다.' });
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let ollamaRes;
  try {
    ollamaRes = await fetch(`${cfg.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: buildMessages(body.messages, body.files, body.selection),
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[chat] Ollama 연결 실패:', err.cause?.code || err.message);
    send({ type: 'error', message: OLLAMA_DOWN_MSG });
    return res.end();
  }

  if (!ollamaRes.ok) {
    let detail = '';
    try {
      detail = (await ollamaRes.json()).error || '';
    } catch {}
    console.error(`[chat] Ollama 오류 ${ollamaRes.status}: ${detail}`);
    const message =
      ollamaRes.status === 404 && /model/i.test(detail)
        ? `모델 '${cfg.model}'을(를) 찾을 수 없습니다. 서버에서 'ollama pull ${cfg.model}'을 실행하세요.`
        : `AI 모델 서버 오류가 발생했습니다. (${ollamaRes.status}${detail ? `: ${detail}` : ''})`;
    send({ type: 'error', message });
    return res.end();
  }

  let full = '';
  try {
    const decoder = new TextDecoder();
    let buf = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj.error) throw new Error(obj.error);
      const text = obj.message?.content;
      if (text) {
        full += text;
        send({ type: 'delta', text });
      }
    };
    for await (const chunk of ollamaRes.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    handleLine(buf);
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[chat] 스트리밍 오류:', err.message);
    send({ type: 'error', message: `답변을 받는 중 오류가 발생했습니다: ${err.message}` });
    return res.end();
  }

  for (const f of parseFileBlocks(full)) send({ type: 'file', path: f.path, content: f.content });
  send({ type: 'done' });
  res.end();
}

// ---------- 정적 파일 ----------

async function serveStatic(res, rootDir, relPath, method) {
  let rel = relPath === '' || relPath.endsWith('/') ? relPath + 'index.html' : relPath;
  const safe = safeRelativePath(rel);
  if (!safe) return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });

  let filePath = path.resolve(rootDir, safe);
  if (!filePath.startsWith(path.resolve(rootDir) + path.sep)) {
    return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
  }

  let st;
  try {
    st = await stat(filePath);
    if (st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      st = await stat(filePath);
    }
  } catch {
    return sendJson(res, 404, { error: '파일을 찾을 수 없습니다.' });
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

// ---------- 라우터 ----------

export function createApp(cfg = getConfig()) {
  const sitesDir = path.join(cfg.dataDir, 'sites');

  return http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return sendJson(res, 400, { error: '잘못된 주소입니다.' });
    }
    const isGet = req.method === 'GET' || req.method === 'HEAD';

    try {
      if (pathname === '/api/health' && isGet) {
        return sendJson(res, 200, { ok: true, model: cfg.model, version: VERSION });
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        return await handleChat(cfg, req, res);
      }

      if (pathname === '/api/deploy' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const id = await deploySite(sitesDir, body);
        const url = `${baseUrl(cfg, req)}/sites/${id}/`;
        console.log(`[deploy] ${id} 배포 완료 (${body.files.length}개 파일)`);
        return sendJson(res, 200, { url });
      }

      if (pathname === '/updates/latest.json' && isGet) {
        const text = await readFile(cfg.updatesFile, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(text);
      }

      if (pathname.startsWith('/sites/') && isGet) {
        const rest = pathname.slice('/sites/'.length);
        const slash = rest.indexOf('/');
        const id = slash === -1 ? rest : rest.slice(0, slash);
        if (!/^[a-z0-9-]+$/.test(id)) return sendJson(res, 404, { error: '사이트를 찾을 수 없습니다.' });
        if (slash === -1) {
          // /sites/<id> → /sites/<id>/ (상대 경로가 올바르게 동작하도록)
          res.writeHead(301, { Location: `/sites/${id}/` });
          return res.end();
        }
        return await serveStatic(res, path.join(sitesDir, id), rest.slice(slash + 1), req.method);
      }

      if (pathname.startsWith('/downloads/') && isGet) {
        return await serveStatic(res, cfg.downloadsDir, pathname.slice('/downloads/'.length), req.method);
      }

      if (pathname === '/' && isGet) {
        return sendJson(res, 200, { name: 'Code AI 서버', version: VERSION, model: cfg.model });
      }

      return sendJson(res, 404, { error: '찾을 수 없는 경로입니다.' });
    } catch (err) {
      const status = err instanceof DeployError ? err.status : err.status || 500;
      if (status >= 500) console.error('[server] 오류:', err);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status >= 500 ? '서버 내부 오류가 발생했습니다.' : err.message });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cfg = getConfig();
  createApp(cfg).listen(cfg.port, cfg.host, () => {
    console.log(`Code AI 서버 v${VERSION} 실행 중: http://localhost:${cfg.port}`);
    console.log(`  모델: ${cfg.model}  (Ollama: ${cfg.ollamaUrl})`);
  });
}
