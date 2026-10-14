import { safeRelativePath } from './paths.js';

// 모델 답변에서 ```file:<path> ... ``` 블록을 찾아 [{ path, content }]로 반환한다.
// - 줄 단위로 파싱하며, 블록 안의 중첩 코드 펜스(예: Markdown 파일 안의 ```js ... ```)를 고려한다.
// - 같은 경로가 여러 번 나오면 마지막 내용을 사용한다.
// - 닫히지 않은 블록(답변이 잘린 경우)은 무시한다.
// - 안전하지 않은 경로(절대 경로, ..)는 무시한다.
export function parseFileBlocks(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const result = new Map();

  let current = null; // { path, lines, depth }
  for (const line of lines) {
    if (!current) {
      const m = /^\s*```+\s*file:\s*(.+?)\s*$/.exec(line);
      if (m) current = { path: m[1], lines: [], depth: 0 };
      continue;
    }
    const trimmed = line.trim();
    if (/^```+$/.test(trimmed)) {
      if (current.depth > 0) {
        current.depth--;
        current.lines.push(line);
      } else {
        const safe = safeRelativePath(current.path);
        if (safe) {
          result.delete(safe);
          result.set(safe, current.lines.join('\n') + (current.lines.length ? '\n' : ''));
        }
        current = null;
      }
      continue;
    }
    if (/^```+\S/.test(trimmed)) current.depth++; // 중첩 펜스 시작 (```js 등)
    current.lines.push(line);
  }

  return [...result].map(([path, content]) => ({ path, content }));
}
