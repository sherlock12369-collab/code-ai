// 상대 경로 정규화 및 경로 탈출(path traversal) 차단.
// 안전하면 정규화된 POSIX 상대 경로를 반환하고, 위험하면 null을 반환한다.
export function safeRelativePath(input) {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > 512) return null;
  if (input.includes('\0')) return null;

  let p = input.trim().replace(/\\/g, '/');
  // 절대 경로, 드라이브 문자(C:), UNC 경로 거부
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;

  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    // Windows에서 문제가 되는 문자 거부
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) return null;
    parts.push(seg);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}
