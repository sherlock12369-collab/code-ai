import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileBlocks } from './lib/fileBlocks.js';
import { buildMessages } from './lib/prompt.js';
import { deploySite, DeployError } from './lib/deploy.js';
import { safeRelativePath } from './lib/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = '1.1.1';

// AI는 Claude API만 사용한다. API 키는 서버에 두지 않고, 사용자가 자기 키를 요청 헤더(x-api-key)로 보낸다.
export const DEFAULT_MODEL = 'claude-opus-5-5';

// 사용자가 고를 수 있는 모델. MODEL 환경 변수 값(claude-로 시작해야 함)도 추가로 허용된다.
// price: 100만 토큰당 입력 / 출력 요금 (USD)
export const MODEL_CHOICES = [
  { id: 'claude-opus-5-5', label: '고품질 — Claude Opus 5.5 (추천)', price: '$4 / $20' },
  { id: 'claude-sonnet-5-5', label: '균형 — Claude Sonnet 5.5', price: '$2 / $10' },
  { id: 'claude-haiku-5-5', label: '빠름·저렴 — Claude Haiku 5.5', price: '$0.10 / $0.50' },
];

// Haiku에는 서버 측 거절 대체(fallbacks)가 없다.
const NO_FALLBACK = new Set(['claude-haiku-5-5']);

const isClaudeModel = (id) => typeof id === 'string' && /^claude-[a-z0-9.-]+$/.test(id);

export function getConfig(env = process.env) {
  return {
    port: env.PORT !== undefined && env.PORT !== '' && Number.isInteger(Number(env.PORT)) ? Number(env.PORT) : 8787,
    host: env.HOST || '0.0.0.0',
    // 테스트/프록시용. 비우면 Anthropic 공식 주소.
    apiBaseUrl: (env.CLAUDE_API_BASE_URL || '').replace(/\/+$/, ''),
    model: isClaudeModel(env.MODEL) ? env.MODEL : DEFAULT_MODEL,
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // 배포 전용 서버(인터넷 공용): AI 채팅은 끄고 사이트 배포/서비스만 한다.
    deployOnly: /^(1|true)$/i.test(env.DEPLOY_ONLY || ''),
    // IP당 1시간 배포 횟수 제한 (0 = 제한 없음)
    deployLimitPerHour: Number(env.DEPLOY_LIMIT_PER_HOUR) > 0 ? Number(env.DEPLOY_LIMIT_PER_HOUR) : 0,
    // 프록시(Fly.io 등) 뒤에서 실제 접속 IP 헤더를 믿을지
    trustProxy: /^(1|true)$/i.test(env.TRUST_PROXY || ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
    updatesFile: path.resolve(env.UPDATES_FILE || path.join(__dirname, 'updates', 'latest.json')),
    downloadsDir: path.resolve(env.DOWNLOADS_DIR || path.join(__dirname, 'downloads')),
  };
}

// 옵션(일부만 줘도 됨)을 환경 변수/기본 설정과 합친다. undefined 값은 무시한다.
export function resolveConfig(options = {}, env = process.env) {
  const cfg = getConfig(env);
  for (const [k, v] of Object.entries(options || {})) if (v !== undefined) cfg[k] = v;
  cfg.port = Number(cfg.port) || 0;
  cfg.apiBaseUrl = String(cfg.apiBaseUrl || '').replace(/\/+$/, '');
  if (!isClaudeModel(cfg.model)) cfg.model = DEFAULT_MODEL;
  cfg.publicUrl = String(cfg.publicUrl || '').replace(/\/+$/, '');
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.updatesFile = path.resolve(cfg.updatesFile);
  cfg.downloadsDir = path.resolve(cfg.downloadsDir);
  return cfg;
}

// 허용된 모델 id 목록 (선택지 3개 + MODEL 값)
export function allowedModels(cfg) {
  const ids = MODEL_CHOICES.map((m) => m.id);
  if (cfg.model && !ids.includes(cfg.model)) ids.push(cfg.model);
  return ids;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
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

// ---------- Claude API ----------

// 요청에서 사용자의 Claude API 키를 꺼낸다. (x-api-key 헤더 또는 Authorization: Bearer)
export function apiKeyFrom(req) {
  let key = req.headers['x-api-key'];
  if (!key) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) key = m[1];
  }
  key = typeof key === 'string' ? key.trim() : '';
  return key || null;
}

const NO_KEY_MSG = 'Claude API 키가 없습니다. 설정에서 본인의 Claude API 키(sk-ant-…)를 입력하세요.';

function claudeClient(cfg, apiKey) {
  return new Anthropic({ apiKey, authToken: null, ...(cfg.apiBaseUrl ? { baseURL: cfg.apiBaseUrl } : {}) });
}

// SDK 오류 → 사용자에게 보여 줄 한국어 메시지 (구체적인 것부터 확인)
export function claudeErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude API 키가 올바르지 않습니다. 설정에서 키를 다시 확인하세요.';
  if (err instanceof Anthropic.PermissionDeniedError) return '이 API 키로는 해당 모델을 사용할 권한이 없습니다.';
  if (err instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없습니다. 설정에서 다른 모델을 골라 보세요.';
  if (err instanceof Anthropic.RateLimitError) return '요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return 'Claude API 크레딧이 부족합니다. console.anthropic.com 에서 결제 정보를 확인하세요.';
    return `요청이 올바르지 않습니다: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Claude API에 연결할 수 없습니다. 인터넷 연결을 확인하세요.';
  if (err instanceof Anthropic.APIError && err.status >= 500) return 'Claude API 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도하세요.';
  return `Claude API 오류: ${err?.message || err}`;
}

// ---------- /api/chat ----------

async function handleChat(cfg, req, res) {
  const body = await readJsonBody(req);

  const apiKey = apiKeyFrom(req);
  if (!apiKey) return sendJson(res, 401, { error: NO_KEY_MSG });

  // 모델 선택 (없으면 서버 기본값). 허용되지 않은 모델은 SSE 시작 전에 400.
  let model = cfg.model;
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    const allowed = allowedModels(cfg);
    if (typeof body.model !== 'string' || !allowed.includes(body.model)) {
      return sendJson(res, 400, {
        error: `지원하지 않는 모델입니다: ${String(body.model).slice(0, 100)} (사용 가능: ${allowed.join(', ')})`,
      });
    }
    model = body.model;
  }

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

  const { system, messages } = buildMessages(body.messages, body.files, body.selection);
  if (messages.length === 0) {
    send({ type: 'error', message: '메시지가 비어 있습니다.' });
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const params = {
    model,
    max_tokens: 64000,
    system,
    messages,
    output_config: { effort: 'high' },
  };
  // 안전 분류기가 거절하면 서버에서 다른 Claude 모델로 이어서 답하게 한다.
  if (!NO_FALLBACK.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let full = '';
  let final;
  try {
    const stream = claudeClient(cfg, apiKey).beta.messages.stream(params, { signal: controller.signal });
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        // 앞 모델이 중간에 거절함 → 이어받는 모델의 답만 파일로 저장한다.
        full = '';
        send({ type: 'delta', text: '\n\n(다른 Claude 모델로 이어서 답합니다)\n\n' });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        send({ type: 'delta', text: event.delta.text });
      }
    }
    final = await stream.finalMessage();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[chat] Claude API 오류:', err.status ?? '', err.message);
    send({ type: 'error', message: claudeErrorMessage(err) });
    return res.end();
  }

  if (final.stop_reason === 'refusal') {
    send({ type: 'error', message: 'Claude가 이 요청에는 답할 수 없다고 했습니다. 요청을 바꿔서 다시 시도해 보세요.' });
    return res.end();
  }
  if (final.stop_reason === 'max_tokens') {
    send({ type: 'delta', text: '\n\n(답변이 너무 길어 중간에 끊겼습니다. 끝나지 않은 파일은 저장되지 않았습니다.)' });
  }

  for (const f of parseFileBlocks(full)) send({ type: 'file', path: f.path, content: f.content });
  send({ type: 'done' });
  res.end();
}

// ---------- /api/check-key ----------

// 키가 맞는지 확인한다. 모델 정보 조회만 하므로 요금이 들지 않는다.
async function handleCheckKey(cfg, req, res) {
  const apiKey = apiKeyFrom(req);
  if (!apiKey) return sendJson(res, 401, { ok: false, error: NO_KEY_MSG });
  try {
    await claudeClient(cfg, apiKey).models.retrieve(cfg.model, { timeout: 15000, maxRetries: 1 });
    return sendJson(res, 200, { ok: true, model: cfg.model });
  } catch (err) {
    const status = err instanceof Anthropic.AuthenticationError ? 401 : 200;
    return sendJson(res, status, { ok: false, error: claudeErrorMessage(err) });
  }
}

// ---------- /api/models ----------

function handleModels(cfg, res) {
  const models = allowedModels(cfg).map((id) => {
    const choice = MODEL_CHOICES.find((m) => m.id === id);
    return { id, label: choice ? choice.label : `사용자 지정 (${id})`, price: choice ? choice.price : '' };
  });
  return sendJson(res, 200, { models, default: cfg.model, provider: 'claude' });
}

// ---------- 배포 횟수 제한 ----------

function clientIp(cfg, req) {
  if (cfg.trustProxy) {
    const h = req.headers['fly-client-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || 'unknown';
}

// 허용되면 true. 최근 1시간 기록만 유지한다.
function allowDeploy(cfg, hits, ip) {
  if (!cfg.deployLimitPerHour) return true;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  const ok = recent.length < cfg.deployLimitPerHour;
  if (ok) recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k);
  }
  return ok;
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

// options: { port, host, dataDir, apiBaseUrl, model, publicUrl, updatesFile, downloadsDir }
// 일부만 줘도 나머지는 환경 변수/기본값을 쓴다. (기존처럼 getConfig() 결과 전체를 넘겨도 된다.)
export function createApp(options) {
  const cfg = resolveConfig(options);
  const sitesDir = path.join(cfg.dataDir, 'sites');
  const deployHits = new Map();

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
        if (cfg.deployOnly) return sendJson(res, 200, { ok: true, mode: 'deploy', version: VERSION });
        return sendJson(res, 200, { ok: true, model: cfg.model, version: VERSION });
      }

      if (cfg.deployOnly && ['/api/chat', '/api/check-key', '/api/models'].includes(pathname)) {
        return sendJson(res, 404, { error: '이 서버는 배포 전용입니다. AI 채팅은 앱의 내장 서버를 사용하세요.' });
      }

      if (pathname === '/api/models' && isGet) {
        return handleModels(cfg, res);
      }

      if (pathname === '/api/check-key' && req.method === 'POST') {
        return await handleCheckKey(cfg, req, res);
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        return await handleChat(cfg, req, res);
      }

      if (pathname === '/api/deploy' && req.method === 'POST') {
        if (!allowDeploy(cfg, deployHits, clientIp(cfg, req))) {
          return sendJson(res, 429, { error: '배포 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
        }
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

// 서버를 만들어 실행하고 { server, port, url, config }를 돌려준다. (데스크톱 앱 내장용)
// port: 0 이면 빈 포트를 자동으로 고른다.
export function startServer(options = {}) {
  const cfg = resolveConfig(options);
  const server = createApp(cfg);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}`, config: { ...cfg, port } });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(
    ({ port, config }) => {
      console.log(`Code AI 서버 v${VERSION} 실행 중: http://localhost:${port}`);
      console.log(`  기본 모델: ${config.model} (Claude API — 사용자 키는 요청마다 x-api-key 헤더로 받음)`);
    },
    (err) => {
      console.error(
        err.code === 'EADDRINUSE' ? `포트가 이미 사용 중입니다: ${err.port ?? ''}` : `서버를 시작할 수 없습니다: ${err.message}`,
      );
      process.exit(1);
    },
  );
}
