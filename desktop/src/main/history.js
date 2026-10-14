'use strict';
// 변경 기록 / 되돌리기
// <project>/.codeai/history/<id>/meta.json  + files/<원래 경로>
// meta: { id, time, prompt, files: [{ path, existed }] }
// 스냅샷은 "변경 직전"의 파일 상태를 저장한다.

const fs = require('fs');
const path = require('path');

function historyDir(root) {
  return path.join(root, '.codeai', 'history');
}

function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}-${Math.random().toString(36).slice(2, 6)}`;
}

class Snapshot {
  constructor(root, prompt, kind = 'ai') {
    this.root = root;
    this.id = newId();
    this.dir = path.join(historyDir(root), this.id);
    this.meta = { id: this.id, time: new Date().toISOString(), prompt: prompt || '', kind, files: [] };
    this.saved = new Set();
    this.created = false;
  }

  // 파일을 변경하기 직전에 호출. 같은 파일은 한 스냅샷에 한 번만 저장.
  async capture(rel) {
    rel = rel.split(path.sep).join('/');
    if (this.saved.has(rel)) return;
    this.saved.add(rel);
    if (!this.created) {
      await fs.promises.mkdir(path.join(this.dir, 'files'), { recursive: true });
      this.created = true;
    }
    const abs = path.join(this.root, rel);
    let existed = false;
    try {
      const st = await fs.promises.stat(abs);
      if (st.isFile()) {
        const dest = path.join(this.dir, 'files', rel);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(abs, dest);
        existed = true;
      }
    } catch (_) { /* 새 파일 */ }
    this.meta.files.push({ path: rel, existed });
    await this.writeMeta();
  }

  async writeMeta() {
    await fs.promises.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2), 'utf8');
  }
}

async function list(root) {
  const dir = historyDir(root);
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(dir, n, 'meta.json'), 'utf8'));
      out.push(meta);
    } catch (_) { /* 손상된 항목 무시 */ }
  }
  out.sort((a, b) => (a.time < b.time ? 1 : -1));
  return out;
}

// 스냅샷 복구: 복구 직전 상태도 새 스냅샷으로 남겨서 복구 자체도 되돌릴 수 있게 한다.
async function restore(root, id, safeResolve) {
  const dir = path.join(historyDir(root), id);
  const meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const label = meta.prompt ? `되돌리기: ${meta.prompt}` : '되돌리기';
  const backup = new Snapshot(root, label, 'restore');
  const changed = [];
  for (const f of meta.files) {
    const abs = safeResolve(f.path);
    await backup.capture(f.path);
    if (f.existed) {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.copyFile(path.join(dir, 'files', f.path), abs);
    } else {
      await fs.promises.rm(abs, { force: true });
      // 비게 된 상위 폴더 정리
      let dirPath = path.dirname(abs);
      while (dirPath.startsWith(path.resolve(root) + path.sep)) {
        try { await fs.promises.rmdir(dirPath); } catch (_) { break; }
        dirPath = path.dirname(dirPath);
      }
    }
    changed.push(f.path);
  }
  return { changed, backupId: backup.created ? backup.id : null };
}

module.exports = { Snapshot, list, restore };
