import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { safeRelativePath } from './paths.js';

const MAX_FILES = 2000;

export class DeployError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || 'site';
}

// 요청 본문을 검증하고 파일 목록을 [{ rel, content }]로 반환한다. 문제가 있으면 DeployError.
export function validateDeploy(body) {
  if (!body || typeof body !== 'object') throw new DeployError('요청 형식이 올바르지 않습니다.');
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) throw new DeployError('배포할 파일이 없습니다.');
  if (files.length > MAX_FILES) throw new DeployError(`파일이 너무 많습니다. (최대 ${MAX_FILES}개)`);

  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') throw new DeployError('파일 형식이 올바르지 않습니다.');
    const rel = safeRelativePath(f.path);
    if (!rel) throw new DeployError(`허용되지 않는 파일 경로입니다: ${String(f.path)}`);
    if (typeof f.content !== 'string') throw new DeployError(`파일 내용이 문자열이 아닙니다: ${rel}`);
    out.push({ rel, content: f.content });
  }
  return out;
}

// 파일을 sitesDir/<id>/ 아래에 저장하고 id를 반환한다.
export async function deploySite(sitesDir, body) {
  const files = validateDeploy(body);
  const id = `${slugify(body.name)}-${randomBytes(4).toString('hex')}`;
  const root = path.resolve(sitesDir, id);

  try {
    for (const { rel, content } of files) {
      const target = path.resolve(root, rel);
      // 이중 안전장치: 최종 경로가 반드시 사이트 폴더 안에 있어야 함
      if (!target.startsWith(root + path.sep)) {
        throw new DeployError(`허용되지 않는 파일 경로입니다: ${rel}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      // data:...;base64, 로 시작하는 내용은 바이너리(이미지 등)로 저장
      const m = /^data:[^;,]*;base64,/.exec(content);
      await writeFile(target, m ? Buffer.from(content.slice(m[0].length), 'base64') : content);
    }
  } catch (err) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return id;
}
