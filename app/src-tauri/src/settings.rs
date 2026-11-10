// 설정 (JSON 파일) + API 키 (OS 보안 저장소: Windows 자격 증명 관리자 / macOS 키체인)

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const PUBLIC_DEPLOY_URL: &str = "https://code-ai-sites.fly.dev";
const KEYRING_SERVICE: &str = "ai.seul.codeai";
const KEYRING_USER: &str = "api-key";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub deploy_server_url: String,
    pub model: Option<String>,
    pub setup_done: bool,
    pub theme: String,
    pub last_project: Option<String>,
    /// OS 보안 저장소를 쓸 수 없을 때만 사용 (평문)
    pub api_key_plain: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            deploy_server_url: PUBLIC_DEPLOY_URL.to_string(),
            model: None,
            setup_done: false,
            theme: "system".to_string(),
            last_project: None,
            api_key_plain: None,
        }
    }
}

pub fn is_model_id(s: &str) -> bool {
    let rest = s.strip_prefix("claude-").or_else(|| s.strip_prefix("gemini-"));
    match rest {
        Some(r) => !r.is_empty() && r.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'),
        None => false,
    }
}

impl Settings {
    fn normalize(&mut self) {
        if !["system", "light", "dark"].contains(&self.theme.as_str()) {
            self.theme = "system".into();
        }
        if let Some(m) = &self.model {
            if !is_model_id(m) {
                self.model = None;
            }
        }
    }

    /// 2.0 설정 파일을 읽는다. 없으면 1.x(Electron) 설정에서 키를 뺀 나머지를 가져온다.
    pub fn load(path: &Path, legacy: Option<PathBuf>) -> Settings {
        let mut s = fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str::<Settings>(&t).ok());
        if s.is_none() {
            if let Some(old) = legacy.and_then(|p| fs::read_to_string(p).ok()) {
                if let Ok(v) = serde_json::from_str::<Value>(&old) {
                    let mut n = Settings::default();
                    if let Some(t) = v.get("theme").and_then(Value::as_str) {
                        n.theme = t.to_string();
                    }
                    if let Some(m) = v.get("model").and_then(Value::as_str) {
                        n.model = Some(m.to_string());
                    }
                    if let Some(p) = v.get("lastProject").and_then(Value::as_str) {
                        n.last_project = Some(p.to_string());
                    }
                    // 1.x의 키는 Electron 방식으로 암호화되어 있어 옮길 수 없다 → 설정 도우미를 다시 보여 준다.
                    s = Some(n);
                }
            }
        }
        let mut s = s.unwrap_or_default();
        s.normalize();
        s
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            if let Err(e) = fs::write(path, text) {
                eprintln!("설정 저장 실패: {e}");
            }
        }
    }

    /// 화면(렌더러)에 줄 설정. 키 원문은 넣지 않는다.
    pub fn public(&self, key: Option<&str>, extra: Value) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut v {
            map.remove("apiKeyPlain");
            map.insert("hasApiKey".into(), Value::Bool(key.is_some()));
            map.insert("apiKeyHint".into(), Value::String(key.map(key_hint).unwrap_or_default()));
            map.insert(
                "keyProvider".into(),
                key.map(|k| Value::String(provider_of_key(k).into())).unwrap_or(Value::Null),
            );
            if let Value::Object(e) = extra {
                map.extend(e);
            }
        }
        v
    }
}

pub fn provider_of_key(key: &str) -> &'static str {
    if key.starts_with("sk-ant-") {
        "claude"
    } else {
        "gemini"
    }
}

fn key_hint(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 12 {
        return "…".into();
    }
    let head: String = chars[..7].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

pub fn get_key(settings: &Settings) -> Option<String> {
    if let Some(k) = entry().and_then(|e| e.get_password().ok()) {
        if !k.is_empty() {
            return Some(k);
        }
    }
    settings.api_key_plain.clone().filter(|k| !k.is_empty())
}

/// 키를 저장한다 (None이면 지운다). 보안 저장소가 안 되면 설정 파일에 평문으로 둔다.
pub fn store_key(settings: &mut Settings, key: Option<&str>) {
    match key {
        None => {
            if let Some(e) = entry() {
                let _ = e.delete_credential();
            }
            settings.api_key_plain = None;
        }
        Some(k) => {
            let ok = entry().map(|e| e.set_password(k).is_ok()).unwrap_or(false);
            settings.api_key_plain = if ok { None } else { Some(k.to_string()) };
        }
    }
}
