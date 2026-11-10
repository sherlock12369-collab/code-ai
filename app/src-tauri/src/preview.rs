// 미리보기용 로컬 정적 서버 (127.0.0.1 전용)
// - 현재 프로젝트 폴더를 그대로 서비스하므로 HTML의 상대 경로 자산이 동작한다.
// - HTML 응답에는 클릭 수정용 inspector 스크립트를 주입한다.
// - Markdown(.md)은 렌더링된 HTML 문서로 응답한다 (?raw=1 이면 원본).
// - /sites/<id>/ 는 "내 PC에만 배포"한 사이트를 서비스한다.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::thread;
use tiny_http::{Header, Request, Response, Server};

const INSPECTOR_SCRIPT: &str = include_str!("inspector.js");
const INSPECTOR_TAG: &str = "<script src=\"/__codeai__/inspector.js\"></script>";

const MD_CSS: &str = r#"
:root{color-scheme:light dark;--bg:#ffffff;--fg:#111111;--muted:#666;--line:#e5e5e5;--code:#f5f5f7;--accent:#7c5cff}
html[data-theme=dark]{--bg:#0d0d0f;--fg:#ededed;--muted:#9a9a9a;--line:#2a2a2e;--code:#18181b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 "Pretendard","Apple SD Gothic Neo","Malgun Gothic","Segoe UI",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:48px 32px 96px}
h1,h2,h3,h4{line-height:1.3;margin:1.8em 0 .6em;letter-spacing:-.01em}
h1{font-size:2.1em;margin-top:0;padding-bottom:.4em;border-bottom:1px solid var(--line)}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
a{color:var(--accent)}
img{max-width:100%;border-radius:8px}
code{font-family:"JetBrains Mono",Consolas,monospace;font-size:.9em;background:var(--code);padding:.15em .4em;border-radius:4px}
pre{background:var(--code);padding:16px;border-radius:8px;overflow:auto;border:1px solid var(--line)}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.5em 1em;border-left:4px solid var(--accent);color:var(--muted);background:var(--code);border-radius:0 6px 6px 0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left}
th{background:var(--code)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
"#;

fn mime(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "txt" | "md" | "markdown" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 주소 경로를 root 안의 실제 경로로 바꾼다. 밖으로 나가면 None.
fn resolve_in(root: &Path, url_path: &str) -> Option<PathBuf> {
    let mut p = root.to_path_buf();
    for c in Path::new(url_path.trim_start_matches('/')).components() {
        match c {
            Component::Normal(seg) => p.push(seg),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(p)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header")
}

fn reply(req: Request, status: u16, content_type: &str, body: Vec<u8>) {
    let res = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"));
    let _ = req.respond(res);
}

fn message_page(msg: &str, theme: &str) -> Vec<u8> {
    format!(
        r#"<!doctype html><html lang="ko" data-theme="{theme}"><head><meta charset="utf-8"><style>
:root{{--bg:#fff;--fg:#666}}html[data-theme=dark]{{--bg:#0d0d0f;--fg:#9a9a9a}}
body{{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:14px "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}}</style></head>
<body><div>{msg}</div></body></html>"#
    )
    .into_bytes()
}

fn render_markdown(src: &str, title: &str, theme: &str) -> Vec<u8> {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES;
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(src, opts));
    format!(
        "<!doctype html><html lang=\"ko\" data-theme=\"{theme}\"><head><meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title>\n\
<style>{MD_CSS}</style></head><body><main>{body}</main>\n{INSPECTOR_TAG}</body></html>",
        escape_html(title)
    )
    .into_bytes()
}

fn inject_inspector(html: &str) -> String {
    // 마지막 </body> 앞에 넣는다. 없으면 끝에 붙인다.
    let lower = html.to_ascii_lowercase();
    match lower.rfind("</body>") {
        Some(i) => format!("{}{}{}", &html[..i], INSPECTOR_TAG, &html[i..]),
        None => format!("{html}{INSPECTOR_TAG}"),
    }
}

pub struct PreviewServer {
    pub port: u16,
    pub root: Arc<RwLock<Option<PathBuf>>>,
}

impl PreviewServer {
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn start(sites_dir: PathBuf) -> Result<PreviewServer, String> {
        let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("미리보기 서버 주소를 알 수 없습니다.")?;
        let root: Arc<RwLock<Option<PathBuf>>> = Arc::new(RwLock::new(None));
        let shared = root.clone();
        thread::spawn(move || {
            for req in server.incoming_requests() {
                let root = shared.read().ok().and_then(|r| r.clone());
                let sites = sites_dir.clone();
                thread::spawn(move || handle(req, root, sites));
            }
        });
        Ok(PreviewServer { port, root })
    }

    pub fn set_root(&self, root: Option<PathBuf>) {
        if let Ok(mut r) = self.root.write() {
            *r = root;
        }
    }
}

fn handle(req: Request, root: Option<PathBuf>, sites_dir: PathBuf) {
    let url = req.url().to_string();
    let (path_part, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let param = |name: &str| {
        query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| v.to_string()))
    };
    let theme = if param("theme").as_deref() == Some("dark") { "dark" } else { "light" };

    if path_part == "/__codeai__/inspector.js" {
        return reply(req, 200, "text/javascript; charset=utf-8", INSPECTOR_SCRIPT.as_bytes().to_vec());
    }
    let Some(rel) = percent_decode(path_part) else {
        return reply(req, 400, "text/plain; charset=utf-8", b"bad request".to_vec());
    };

    // 내 PC에 배포한 사이트: inspector를 넣지 않고 그대로 서비스
    if let Some(rest) = rel.strip_prefix("/sites/") {
        let Some(mut target) = resolve_in(&sites_dir, rest) else {
            return reply(req, 403, "text/plain; charset=utf-8", b"Forbidden".to_vec());
        };
        if target.is_dir() {
            target = target.join("index.html");
        }
        return match fs::read(&target) {
            Ok(bytes) => {
                let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                reply(req, 200, mime(&ext), bytes)
            }
            Err(_) => reply(req, 404, "text/html; charset=utf-8", message_page("페이지를 찾을 수 없습니다.", "light")),
        };
    }

    let Some(root) = root else {
        return reply(req, 200, "text/html; charset=utf-8", message_page("프로젝트가 열려 있지 않습니다.", theme));
    };
    let Some(mut target) = resolve_in(&root, &rel) else {
        return reply(req, 403, "text/plain; charset=utf-8", b"Forbidden".to_vec());
    };
    if target.is_dir() {
        target = target.join("index.html");
    }
    if !target.is_file() {
        let msg = format!("파일을 찾을 수 없습니다: {}", escape_html(&rel));
        return reply(req, 404, "text/html; charset=utf-8", message_page(&msg, theme));
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let bytes = match fs::read(&target) {
        Ok(b) => b,
        Err(e) => return reply(req, 500, "text/plain; charset=utf-8", format!("미리보기 오류: {e}").into_bytes()),
    };

    match ext.as_str() {
        "md" | "markdown" if param("raw").as_deref() != Some("1") => {
            let title = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
            reply(req, 200, "text/html; charset=utf-8", render_markdown(&String::from_utf8_lossy(&bytes), title, theme))
        }
        "html" | "htm" => {
            let html = inject_inspector(&String::from_utf8_lossy(&bytes));
            reply(req, 200, "text/html; charset=utf-8", html.into_bytes())
        }
        _ => reply(req, 200, mime(&ext), bytes),
    }
}
