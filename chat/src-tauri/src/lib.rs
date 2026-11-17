// SEUL Chat (Tauri) — 앱 안쪽 부분
// 대화 저장·검색(chats.rs), 설정, API 키를 맡는다. AI 호출은 화면 쪽 ui/ai.js(shared/ai.js 복사본)가 한다.
// API 키: 컴퓨터에서는 Code AI와 같은 OS 보안 저장소 항목을 같이 써서, 한쪽에 넣으면 둘 다 쓸 수 있다.
// 폰(안드로이드)에는 그런 저장소가 없어서, 다른 앱이 읽을 수 없는 이 앱 전용 폴더의 파일에 둔다.

mod chats;

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

struct AppState {
    settings: Mutex<Value>,
    settings_path: PathBuf,
    chats_dir: PathBuf,
    #[allow(dead_code)] // 폰에서만 씀
    key_file: PathBuf,
}

fn default_settings() -> Value {
    json!({ "theme": "system", "model": null, "persona": "friend" })
}

// ───────── 키 저장 ─────────

#[cfg(desktop)]
mod keystore {
    use std::path::Path;
    // Code AI(app/src-tauri/src/settings.rs)와 같은 값이어야 키를 같이 쓴다.
    const KEYRING_SERVICE: &str = "ai.seul.codeai";
    const KEYRING_USER: &str = "api-key";
    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
    }
    pub fn get(_file: &Path) -> Option<String> {
        entry().and_then(|e| e.get_password().ok()).filter(|k| !k.is_empty())
    }
    pub fn set(_file: &Path, key: Option<&str>) -> Result<(), String> {
        let e = entry().ok_or("이 컴퓨터의 보안 저장소를 쓸 수 없습니다.")?;
        match key {
            Some(k) => e.set_password(k).map_err(|err| format!("키를 저장하지 못했습니다: {err}")),
            None => {
                let _ = e.delete_credential();
                Ok(())
            }
        }
    }
}

#[cfg(mobile)]
mod keystore {
    use std::path::Path;
    pub fn get(file: &Path) -> Option<String> {
        std::fs::read_to_string(file).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
    }
    pub fn set(file: &Path, key: Option<&str>) -> Result<(), String> {
        match key {
            Some(k) => {
                if let Some(d) = file.parent() {
                    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
                }
                std::fs::write(file, k).map_err(|e| format!("키를 저장하지 못했습니다: {e}"))
            }
            None => {
                let _ = std::fs::remove_file(file);
                Ok(())
            }
        }
    }
}

fn public_settings(app: &AppHandle, state: &AppState, s: &Value) -> Value {
    let key = keystore::get(&state.key_file);
    let mut v = s.clone();
    v["hasApiKey"] = json!(key.is_some());
    v["keyProvider"] = json!(key.as_deref().map(|k| if k.starts_with("sk-ant-") { "claude" } else { "gemini" }));
    v["apiKeyHint"] = json!(key.as_deref().map(|k| {
        let c: Vec<char> = k.chars().collect();
        if c.len() < 12 { "…".to_string() } else { format!("{}…{}", c[..7].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>()) }
    }));
    v["version"] = json!(app.package_info().version.to_string());
    v
}

#[tauri::command]
fn settings_get(app: AppHandle, state: State<AppState>) -> Value {
    public_settings(&app, &state, &state.settings.lock().unwrap())
}

/// theme, model, persona 만 바꿀 수 있다.
#[tauri::command]
fn settings_set(app: AppHandle, state: State<AppState>, partial: Value) -> Value {
    let mut s = state.settings.lock().unwrap();
    if let Some(t) = partial.get("theme").and_then(Value::as_str).filter(|t| ["system", "light", "dark"].contains(t)) {
        s["theme"] = json!(t);
    }
    if let Some(m) = partial.get("model") {
        let ok = m.is_null() || m.as_str().is_some_and(|m| (m.starts_with("gemini-") || m.starts_with("claude-")) && m.len() < 64);
        if ok {
            s["model"] = m.clone();
        }
    }
    if let Some(p) = partial.get("persona").and_then(Value::as_str).filter(|p| p.len() < 32) {
        s["persona"] = json!(p);
    }
    if let Some(dir) = state.settings_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&state.settings_path, serde_json::to_string_pretty(&*s).unwrap_or_default());
    public_settings(&app, &state, &s)
}

/// 화면의 ai.js가 API를 직접 부르므로 키 원문을 준다.
#[tauri::command]
fn api_key_get(state: State<AppState>) -> Option<String> {
    keystore::get(&state.key_file)
}

/// 키 저장(None이면 삭제). 확인은 화면 쪽에서 먼저 한다.
#[tauri::command]
fn api_key_store(app: AppHandle, state: State<AppState>, key: Option<String>) -> CmdResult<Value> {
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    keystore::set(&state.key_file, key.as_deref())?;
    Ok(public_settings(&app, &state, &state.settings.lock().unwrap()))
}

#[tauri::command]
fn chats_list(state: State<AppState>) -> Vec<Value> {
    chats::list(&state.chats_dir)
}

#[tauri::command]
fn chat_load(state: State<AppState>, id: String) -> CmdResult<Value> {
    chats::load(&state.chats_dir, &id)
}

#[tauri::command]
fn chat_save(state: State<AppState>, chat: Value) -> CmdResult<()> {
    chats::save(&state.chats_dir, &chat)
}

#[tauri::command]
fn chat_delete(state: State<AppState>, id: String) -> CmdResult<()> {
    chats::delete(&state.chats_dir, &id)
}

#[tauri::command]
fn chats_search(state: State<AppState>, query: String) -> Vec<Value> {
    chats::search(&state.chats_dir, &query)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let paths = app.path();
            let settings_path = paths.app_config_dir()?.join("settings.json");
            let mut settings = default_settings();
            if let Some(saved) = fs::read_to_string(&settings_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                if let (Value::Object(base), Value::Object(saved)) = (&mut settings, saved) {
                    base.extend(saved);
                }
            }
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                chats_dir: paths.app_data_dir()?.join("chats"),
                key_file: paths.app_data_dir()?.join("api-key"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            api_key_get,
            api_key_store,
            chats_list,
            chat_load,
            chat_save,
            chat_delete,
            chats_search,
        ])
        .run(tauri::generate_context!())
        .expect("SEUL Chat을 시작하지 못했습니다");
}
