// SEUL Chat 대화 저장: <앱 데이터>/chats/<id>.json
// 대화 하나 = { id, title, persona, created, updated, messages: [{ role, content, images?, time }] }
// (2단계에서 로그인하면 이 파일들을 Firebase와 연동한다)

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn file_of(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if valid_id(id) {
        Ok(dir.join(format!("{id}.json")))
    } else {
        Err("잘못된 대화 id입니다.".into())
    }
}

fn read_all(dir: &Path) -> Vec<Value> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .filter_map(|e| fs::read_to_string(e.path()).ok())
                .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn text_of(m: &Value) -> &str {
    m.get("content").and_then(Value::as_str).unwrap_or("")
}

fn summary(c: &Value) -> Value {
    let msgs = c.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let last = msgs.iter().rev().map(text_of).find(|t| !t.is_empty()).unwrap_or("");
    json!({
        "id": c.get("id"),
        "title": c.get("title"),
        "persona": c.get("persona"),
        "updated": c.get("updated"),
        "count": msgs.len(),
        "preview": last.chars().take(80).collect::<String>(),
    })
}

fn by_updated_desc(list: &mut [Value]) {
    list.sort_by(|a, b| {
        let ka = a.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
        let kb = b.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
        kb.partial_cmp(&ka).unwrap_or(std::cmp::Ordering::Equal)
    });
}

pub fn list(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = read_all(dir).iter().map(summary).collect();
    by_updated_desc(&mut out);
    out
}

pub fn load(dir: &Path, id: &str) -> Result<Value, String> {
    let t = fs::read_to_string(file_of(dir, id)?).map_err(|_| "대화를 찾을 수 없습니다.".to_string())?;
    serde_json::from_str(&t).map_err(|e| e.to_string())
}

pub fn save(dir: &Path, chat: &Value) -> Result<(), String> {
    let id = chat.get("id").and_then(Value::as_str).ok_or("대화 id가 없습니다.")?;
    let path = file_of(dir, id)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // 쓰다가 꺼져도 깨지지 않게 임시 파일에 쓰고 바꿔치기한다.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(chat).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let p = file_of(dir, id)?;
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 제목과 내용에서 찾는다 (대소문자 무시). 찾은 곳 주변 글을 snippet으로 준다.
pub fn search(dir: &Path, query: &str) -> Vec<Value> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return list(dir);
    }
    let mut out = vec![];
    for c in read_all(dir) {
        let title = c.get("title").and_then(Value::as_str).unwrap_or("");
        let mut snippet: Option<String> = None;
        if title.to_lowercase().contains(&q) {
            snippet = Some(String::new());
        }
        if let Some(msgs) = c.get("messages").and_then(Value::as_array) {
            for m in msgs {
                let t = text_of(m);
                let lower = t.to_lowercase();
                if let Some(byte_i) = lower.find(&q) {
                    // 소문자로 바꿔도 글자 수는 같다고 보고 글자 위치로 자른다.
                    let char_i = lower[..byte_i].chars().count();
                    let chars: Vec<char> = t.chars().collect();
                    let start = char_i.saturating_sub(30);
                    let end = (char_i + q.chars().count() + 50).min(chars.len());
                    let mut s: String = chars[start.min(chars.len())..end].iter().collect();
                    if start > 0 {
                        s = format!("…{s}");
                    }
                    if end < chars.len() {
                        s.push('…');
                    }
                    snippet = Some(s.replace('\n', " "));
                    break;
                }
            }
        }
        if let Some(s) = snippet {
            let mut v = summary(&c);
            v["snippet"] = Value::String(s);
            out.push(v);
        }
    }
    by_updated_desc(&mut out);
    out
}
