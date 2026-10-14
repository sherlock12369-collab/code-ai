export const SYSTEM_PROMPT = `당신은 "Code AI"의 코딩 도우미입니다. 사용자가 웹사이트, 문서, 프로그램을 만들고 고치도록 돕습니다.

규칙:
1. 항상 한국어로 친절하고 간결하게 답하세요. (코드, 파일 이름, 기술 용어는 원래대로 써도 됩니다.)
2. 파일을 새로 만들거나 수정할 때는 반드시 파일 "전체 내용"을 아래 형식의 블록으로 출력하세요. 일부만 보여주거나 "... 기존 코드 ..." 처럼 생략하지 마세요.
\`\`\`file:경로/파일이름.확장자
(파일 전체 내용)
\`\`\`
   예: \`\`\`file:index.html
3. 파일 경로는 프로젝트 루트 기준 상대 경로로 쓰세요. (절대 경로나 ".." 금지)
4. 수정하지 않는 파일은 다시 출력하지 마세요.
5. 파일 블록 앞에는 무엇을 왜 바꾸는지 짧게 설명하세요.
6. 사용자가 미리보기에서 요소를 선택해 첨부한 경우, 그 요소를 중심으로 요청을 처리하고 해당 파일 전체를 다시 출력하세요.
7. 웹 페이지는 별도 빌드 없이 브라우저에서 바로 열리는 HTML/CSS/JS로 만드세요.
8. 사용자가 요청한 내용(색상, 개수, 문구 등)을 정확히 지키세요. 요청하지 않은 메뉴, 머리글, 꼬리글 같은 내용을 임의로 덧붙이지 마세요.`;

const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 200_000;

// 프로젝트 파일과 선택 요소를 모델에게 줄 컨텍스트 텍스트로 만든다.
export function buildContext(files, selection) {
  const parts = [];

  if (Array.isArray(files) && files.length) {
    let total = 0;
    const fileParts = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
      let content = f.content;
      if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + '\n...(이하 생략)';
      if (total + content.length > MAX_TOTAL_CHARS) {
        fileParts.push(`(파일이 너무 많아 ${f.path} 이후는 생략되었습니다)`);
        break;
      }
      total += content.length;
      fileParts.push(`\`\`\`file:${f.path}\n${content}${content.endsWith('\n') ? '' : '\n'}\`\`\``);
    }
    parts.push('[현재 프로젝트 파일]\n' + fileParts.join('\n\n'));
  }

  if (selection && typeof selection === 'object' && (selection.selector || selection.html)) {
    const lines = ['[사용자가 미리보기에서 선택한 요소]'];
    if (selection.file) lines.push(`파일: ${selection.file}`);
    if (selection.selector) lines.push(`CSS 선택자: ${selection.selector}`);
    if (selection.html) lines.push('HTML:\n```html\n' + String(selection.html).slice(0, 20_000) + '\n```');
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

// Claude Messages API에 보낼 { system, messages }를 만든다. 컨텍스트는 마지막 사용자 메시지 앞에 붙인다.
// Claude는 user/assistant가 번갈아 나와야 하고, user로 시작해서 user로 끝나야 한다.
export function buildMessages(messages, files, selection) {
  const history = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
    const last = history[history.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else history.push({ role: m.role, content: m.content });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  while (history.length && history[history.length - 1].role !== 'user') history.pop();

  const context = buildContext(files, selection);
  if (context) {
    if (history.length) {
      const idx = history.length - 1;
      history[idx] = { role: 'user', content: `${context}\n\n[요청]\n${history[idx].content}` };
    } else {
      history.push({ role: 'user', content: context });
    }
  }

  return { system: SYSTEM_PROMPT, messages: history };
}
