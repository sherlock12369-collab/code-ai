// 프로젝트 폴더: 경로 검사, 파일 트리, 읽기/쓰기, AI에 보낼 파일 모으기, 템플릿

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const IGNORED: [&str; 4] = [".codeai", ".git", "node_modules", ".DS_Store"];

const TEXT_EXT: [&str; 46] = [
    "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "markdown", "txt", "svg", "xml", "yml",
    "yaml", "toml", "py", "java", "c", "cpp", "h", "cs", "go", "rs", "rb", "php", "sh", "bat", "ps1", "vue", "svelte",
    "scss", "sass", "less", "csv", "ini", "env", "sql", "kt", "swift", "dart", "lua", "r", "gitignore",
];

fn binary_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => return None,
    })
}

fn ext_of(rel: &str) -> String {
    Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

pub fn is_text_file(rel: &str) -> bool {
    let ext = ext_of(rel);
    if ext.is_empty() {
        return !Path::new(rel).file_name().and_then(|n| n.to_str()).unwrap_or("").contains('.');
    }
    TEXT_EXT.contains(&ext.as_str())
}

pub fn is_ignored_rel(rel: &str) -> bool {
    rel.split(['/', '\\']).any(|s| IGNORED.contains(&s))
}

pub fn to_rel(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

/// 프로젝트 안의 상대 경로 → 실제 경로. 프로젝트 밖, 프로젝트 자체, .codeai 는 거부한다.
pub fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let clean = rel.trim().replace('\\', "/");
    let clean = clean.trim_start_matches('/');
    if clean.is_empty() {
        return Err("잘못된 경로입니다.".into());
    }
    let mut abs = root.to_path_buf();
    let mut depth = 0usize;
    for c in Path::new(clean).components() {
        match c {
            Component::Normal(seg) => {
                abs.push(seg);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(format!("프로젝트 밖의 경로는 사용할 수 없습니다: {rel}"));
                }
                abs.pop();
                depth -= 1;
            }
            _ => return Err(format!("프로젝트 밖의 경로는 사용할 수 없습니다: {rel}")),
        }
    }
    if depth == 0 {
        return Err(format!("프로젝트 밖의 경로는 사용할 수 없습니다: {rel}"));
    }
    if to_rel(root, &abs).split('/').next() == Some(".codeai") {
        return Err(".codeai 폴더는 수정할 수 없습니다.".into());
    }
    Ok(abs)
}

#[derive(Serialize)]
pub struct TreeNode {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TreeNode>>,
}

pub fn read_tree(root: &Path, dir: &Path, depth: usize) -> Vec<TreeNode> {
    if depth > 12 {
        return vec![];
    }
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<TreeNode> = vec![];
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        let abs = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            out.push(TreeNode { name, path: to_rel(root, &abs), kind: "dir", children: Some(read_tree(root, &abs, depth + 1)) });
        } else if ft.is_file() {
            out.push(TreeNode { name, path: to_rel(root, &abs), kind: "file", children: None });
        }
    }
    out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

pub fn list_files_flat(root: &Path, dir: &Path, acc: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if acc.len() > 2000 {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            list_files_flat(root, &e.path(), acc);
        } else if ft.is_file() {
            acc.push(to_rel(root, &e.path()));
        }
    }
}

pub struct CollectOpts {
    pub max_files: usize,
    pub max_file_size: u64,
    pub max_total: u64,
    pub include_binary: bool,
}

pub const CHAT_LIMITS: CollectOpts = CollectOpts { max_files: 40, max_file_size: 120 * 1024, max_total: 400 * 1024, include_binary: false };
pub const DEPLOY_LIMITS: CollectOpts =
    CollectOpts { max_files: 500, max_file_size: 2 * 1024 * 1024, max_total: 20 * 1024 * 1024, include_binary: true };

/// AI(또는 배포)에 보낼 파일 모으기. 텍스트 파일 위주, 용량 제한, 우선순위 파일 먼저.
/// 바이너리는 data URI(base64)로.
pub fn collect_files(root: &Path, priority: &[String], o: &CollectOpts) -> Vec<Value> {
    let mut all = vec![];
    list_files_flat(root, root, &mut all);
    all.retain(|p| is_text_file(p) || (o.include_binary && binary_mime(&ext_of(p)).is_some()));
    let mut ordered: Vec<String> = priority.iter().filter(|p| all.contains(p)).cloned().collect();
    for p in all {
        if !ordered.contains(&p) {
            ordered.push(p);
        }
    }
    let mut files = vec![];
    let mut total = 0u64;
    for rel in ordered {
        if files.len() >= o.max_files {
            break;
        }
        let abs = root.join(&rel);
        let Ok(meta) = fs::metadata(&abs) else { continue };
        let size = meta.len();
        if size > o.max_file_size || total + size > o.max_total {
            continue;
        }
        let content = if is_text_file(&rel) {
            match fs::read(&abs) {
                Ok(b) => String::from_utf8_lossy(&b).to_string(),
                Err(_) => continue,
            }
        } else {
            let Some(m) = binary_mime(&ext_of(&rel)) else { continue };
            match fs::read(&abs) {
                Ok(b) => format!("data:{m};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)),
                Err(_) => continue,
            }
        };
        total += size;
        files.push(json!({ "path": rel, "content": content }));
    }
    files
}

// ───────── 템플릿 ─────────

pub fn list_templates(dir: &Path) -> Vec<Value> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<(usize, Value)> = vec![];
    let order = ["landing", "portfolio", "shop", "report"];
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let id = e.file_name().to_string_lossy().to_string();
        let Some(meta) = fs::read_to_string(e.path().join("template.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        let rank = order.iter().position(|o| *o == id).unwrap_or(99);
        out.push((
            rank,
            json!({
                "id": id,
                "name": meta.get("name").and_then(Value::as_str).unwrap_or(&id),
                "description": meta.get("description").and_then(Value::as_str).unwrap_or(""),
            }),
        ));
    }
    out.sort_by_key(|(r, _)| *r);
    out.into_iter().map(|(_, v)| v).collect()
}

pub fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for e in fs::read_dir(src)?.flatten() {
        if e.file_name() == "template.json" {
            continue;
        }
        let d = dest.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &d)?;
        } else {
            fs::copy(e.path(), d)?;
        }
    }
    Ok(())
}

pub const BLANK_HTML: &str = r#"<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>새 프로젝트</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; background: #fff; color: #111; }
    h1 { font-size: 2rem; letter-spacing: -0.02em; }
    p { color: #666; }
  </style>
</head>
<body>
  <main>
    <h1>안녕하세요 👋</h1>
    <p>오른쪽 채팅에서 만들고 싶은 것을 말해 보세요.</p>
  </main>
</body>
</html>
"#;

/// 이름을 폴더 이름으로 쓸 수 있게 다듬는다.
pub fn safe_folder_name(name: &str) -> String {
    name.trim().chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '-' } else { c }).collect()
}

/// 배포용 짧은 이름 (영문 소문자·숫자·-)
pub fn slugify(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.trim_matches('-').chars().take(40).collect();
    if s.is_empty() {
        "site".into()
    } else {
        s
    }
}
