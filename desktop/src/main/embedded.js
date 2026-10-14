'use strict';
// 내장 AI 서버 — 앱에 함께 들어 있는 server/ (Node ESM)를 메인 프로세스 안에서 직접 실행한다.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');

const PREFERRED_PORT = 8787;
const HOST = '127.0.0.1';

// 개발 중에는 저장소의 server/, 설치본에서는 resources/server
function serverDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'server'),
    path.join(__dirname, '..', '..', '..', 'server')
  ];
  return candidates.find((p) => p && fs.existsSync(path.join(p, 'server.js'))) || null;
}

// 누군가 이미 그 포트에서 응답하는지 확인 (Windows에서는 0.0.0.0에 묶인 포트에 127.0.0.1로 또 묶일 수 있어서 먼저 확인)
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: HOST });
    const done = (busy) => { sock.destroy(); resolve(busy); };
    sock.setTimeout(700, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

class EmbeddedServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.error = null;
    this.starting = null;
    this.dir = null;
  }

  get url() {
    return this.port ? `http://${HOST}:${this.port}` : null;
  }

  status() {
    return { running: !!this.server, url: this.url, port: this.port, error: this.error, dir: this.dir };
  }

  // options: { dataDir, model }
  start(options = {}) {
    if (this.server) return Promise.resolve(this.status());
    if (!this.starting) {
      this.starting = this._start(options).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async _start({ dataDir, model } = {}) {
    this.error = null;
    try {
      const dir = serverDir();
      if (!dir) throw new Error('내장 AI 서버 파일을 찾을 수 없습니다.');
      this.dir = dir;
      const mod = await import(pathToFileURL(path.join(dir, 'server.js')).href);
      const env = { ...process.env, HOST, PORT: String(PREFERRED_PORT) };
      if (dataDir) env.DATA_DIR = dataDir;
      if (model) env.MODEL = model;
      delete env.PUBLIC_URL;
      const cfg = mod.getConfig(env);
      cfg.host = HOST;
      if (dataDir) fs.mkdirSync(dataDir, { recursive: true });

      const candidates = [];
      for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 13; p++) candidates.push(p);
      candidates.push(0); // 마지막: 아무 빈 포트
      let lastErr = null;
      for (const port of candidates) {
        if (port && (await portBusy(port))) continue;
        const server = mod.createApp({ ...cfg, port: port || PREFERRED_PORT });
        try {
          const actual = await listen(server, port);
          cfg.port = actual;
          this.server = server;
          this.port = actual;
          server.on('error', (err) => console.error('[embedded] 서버 오류', err));
          console.log(`[embedded] 내장 AI 서버 실행: ${this.url} (데이터: ${cfg.dataDir})`);
          return this.status();
        } catch (err) {
          lastErr = err;
          try { server.close(); } catch (_) { /* ignore */ }
          if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
        }
      }
      throw lastErr || new Error('사용할 수 있는 포트가 없습니다.');
    } catch (err) {
      console.error('[embedded] 시작 실패', err);
      this.error = err.message || String(err);
      return this.status();
    }
  }

  stop() {
    if (this.server) {
      try {
        this.server.closeAllConnections?.();
        this.server.close();
      } catch (_) { /* ignore */ }
    }
    this.server = null;
    this.port = null;
  }
}

module.exports = { EmbeddedServer, serverDir };
