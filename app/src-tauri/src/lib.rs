// Code AI 2.0 (Tauri) — 앱 안쪽 부분
// 화면(ui/)은 window.codeai API(ui/bridge.js)로 여기의 명령들을 부른다.
// AI 호출(Gemini/Claude)은 화면 쪽 ui/ai.js가 직접 한다. 여기서는 파일·미리보기·기록·설정을 맡는다.

mod history;
mod preview;
mod project;
mod settings;

use notify::{RecursiveMode, Watcher};
use project::safe_resolve;
use serde::Deserialize;
use serde_json::{json, Value};
use settings::Settings;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

pub struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    project: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    snapshots: Mutex<HashMap<String, history::Snapshot>>,
    preview: preview::PreviewServer,
    sites_dir: PathBuf,
    templates_dir: PathBuf,
    /// SEUL Chat에서 codeai:// 링크로 넘어온, 아직 화면이 가져가지 않은 요청
    handoff: Mutex<Option<String>>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn root_of(state: &AppState) -> CmdResult<PathBuf> {
    state.project.lock().unwrap().clone().ok_or_else(|| "프로젝트가 열려 있지 않습니다.".to_string())
}

fn project_info(root: &Option<PathBuf>) -> Value {
    match root {
        Some(r) => json!({
            "root": r.to_string_lossy(),
            "name": r.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        }),
        None => Value::Null,
    }
}

fn public_settings(app: &AppHandle, state: &AppState) -> Value {
    let s = state.settings.lock().unwrap();
    let key = settings::get_key(&s);
    s.public(
        key.as_deref(),
        json!({
            "version": app.package_info().version.to_string(),
            "platform": std::env::consts::OS,
            "publicDeployUrl": settings::PUBLIC_DEPLOY_URL,
        }),
    )
}

// ───────── 프로젝트 열기/닫기 + 파일 감시 ─────────

fn set_project(app: &AppHandle, state: &AppState, root: Option<PathBuf>) -> Value {
    let root = root.map(|r| fs::canonicalize(&r).map(dunce).unwrap_or(r));
    *state.watcher.lock().unwrap() = None;
    state.preview.set_root(root.clone());
    *state.project.lock().unwrap() = root.clone();
    let title = match &root {
        Some(r) => {
            {
                let mut s = state.settings.lock().unwrap();
                s.last_project = Some(r.to_string_lossy().to_string());
                s.save(&state.settings_path);
            }
            *state.watcher.lock().unwrap() = start_watcher(app.clone(), r.clone());
            format!("{} — Code AI", r.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())
        }
        None => "Code AI".to_string(),
    };
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&title);
    }
    project_info(&root)
}

/// Windows의 \\?\C:\... 모양을 보통 경로로 되돌린다.
fn dunce(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC") {
            return PathBuf::from(rest);
        }
    }
    p
}

fn start_watcher(app: AppHandle, root: PathBuf) -> Option<notify::RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<String>();
    let root2 = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                let rel = project::to_rel(&root2, &p);
                if !rel.is_empty() && !project::is_ignored_rel(&rel) {
                    let _ = tx.send(rel);
                }
            }
        }
    })
    .ok()?;
    watcher.watch(&root, RecursiveMode::Recursive).ok()?;
    // 150ms 동안 모아서 한 번에 알린다. 감시가 끝나면(tx가 사라지면) 이 스레드도 끝난다.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths = vec![first];
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(150)) {
                if !paths.contains(&p) {
                    paths.push(p);
                }
            }
            let _ = app.emit("fs:changed", json!({ "paths": paths }));
        }
    });
    Some(watcher)
}

// ───────── 명령: 설정 / 키 ─────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    deploy_server_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_some")]
    model: Option<Option<String>>,
    setup_done: Option<bool>,
    theme: Option<String>,
}

// model: null(기본 모델로) 과 "없음"(바꾸지 않음)을 구분한다.
fn deserialize_some<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[tauri::command]
fn settings_get(app: AppHandle, state: State<AppState>) -> Value {
    public_settings(&app, &state)
}

#[tauri::command]
fn settings_set(app: AppHandle, state: State<AppState>, partial: SettingsPatch) -> Value {
    {
        let mut s = state.settings.lock().unwrap();
        if let Some(d) = partial.deploy_server_url {
            let d = d.trim().trim_end_matches('/').to_string();
            if d.is_empty() || d.starts_with("http://") || d.starts_with("https://") {
                s.deploy_server_url = d;
            }
        }
        if let Some(m) = partial.model {
            match m {
                None => s.model = None,
                Some(m) if settings::is_model_id(&m) => s.model = Some(m),
                _ => {}
            }
        }
        if let Some(b) = partial.setup_done {
            s.setup_done = b;
        }
        if let Some(t) = partial.theme {
            if ["system", "light", "dark"].contains(&t.as_str()) {
                s.theme = t;
            }
        }
        s.save(&state.settings_path);
    }
    public_settings(&app, &state)
}

/// 화면의 ai.js가 API를 직접 부르므로 키 원문을 준다. (미리보기 페이지는 다른 주소라 이 명령을 부를 수 없다)
#[tauri::command]
fn api_key_get(state: State<AppState>) -> Option<String> {
    settings::get_key(&state.settings.lock().unwrap())
}

/// 키 저장. 확인(요금 없는 모델 조회)은 화면 쪽에서 먼저 한다.
#[tauri::command]
fn api_key_store(app: AppHandle, state: State<AppState>, key: Option<String>) -> Value {
    {
        let mut s = state.settings.lock().unwrap();
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        // 다른 회사 키로 바꾸면 예전에 고른 모델은 버린다.
        if let (Some(k), Some(m)) = (&key, &s.model) {
            let model_provider = if m.starts_with("gemini-") { "gemini" } else { "claude" };
            if model_provider != settings::provider_of_key(k) {
                s.model = None;
            }
        }
        settings::store_key(&mut s, key.as_deref());
        s.save(&state.settings_path);
    }
    let v = public_settings(&app, &state);
    let _ = app.emit("settings:changed", v.clone());
    v
}

// ───────── 명령: 프로젝트 ─────────

#[tauri::command]
fn preview_base(state: State<AppState>) -> String {
    state.preview.base()
}

#[tauri::command]
fn project_current(state: State<AppState>) -> Value {
    project_info(&state.project.lock().unwrap())
}

#[tauri::command]
fn project_set(app: AppHandle, state: State<AppState>, root: Option<String>) -> CmdResult<Value> {
    let root = match root {
        Some(r) => {
            let p = PathBuf::from(r);
            if !p.is_dir() {
                return Err("폴더를 찾을 수 없습니다.".into());
            }
            Some(p)
        }
        None => None,
    };
    Ok(set_project(&app, &state, root))
}

#[tauri::command]
fn project_default_dir(app: AppHandle) -> String {
    app.path().document_dir().unwrap_or_else(|_| PathBuf::from(".")).join("CodeAI").to_string_lossy().to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOpts {
    parent_dir: Option<String>,
    name: Option<String>,
    template: Option<String>,
}

#[tauri::command]
fn project_create(app: AppHandle, state: State<AppState>, opts: CreateOpts) -> CmdResult<Value> {
    let name = project::safe_folder_name(opts.name.as_deref().unwrap_or(""));
    if name.is_empty() {
        return Err("프로젝트 이름을 입력해 주세요.".into());
    }
    let parent = opts.parent_dir.filter(|p| !p.is_empty()).ok_or("저장 위치를 선택해 주세요.")?;
    let dest = PathBuf::from(parent).join(&name);
    if dest.exists() && fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("이미 같은 이름의 폴더가 있고 비어 있지 않습니다: {}", dest.display()));
    }
    fs::create_dir_all(&dest).map_err(err)?;
    match opts.template.filter(|t| !t.is_empty()) {
        Some(t) => {
            let t = Path::new(&t).file_name().ok_or("잘못된 템플릿입니다.")?.to_owned();
            let src = state.templates_dir.join(t);
            if !src.is_dir() {
                return Err(format!("템플릿을 찾을 수 없습니다: {}", src.display()));
            }
            project::copy_dir(&src, &dest).map_err(err)?;
        }
        None => fs::write(dest.join("index.html"), project::BLANK_HTML).map_err(err)?,
    }
    Ok(set_project(&app, &state, Some(dest)))
}

#[tauri::command]
fn templates_list(state: State<AppState>) -> Vec<Value> {
    project::list_templates(&state.templates_dir)
}

// ───────── 명령: 파일 ─────────

#[tauri::command]
fn fs_tree(state: State<AppState>) -> Value {
    match state.project.lock().unwrap().clone() {
        Some(r) => serde_json::to_value(project::read_tree(&r, &r, 0)).unwrap_or(json!([])),
        None => json!([]),
    }
}

#[tauri::command]
fn fs_read(state: State<AppState>, rel: String) -> CmdResult<String> {
    let abs = safe_resolve(&root_of(&state)?, &rel)?;
    let meta = fs::metadata(&abs).map_err(|_| format!("파일을 찾을 수 없습니다: {rel}"))?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("파일이 너무 커서 편집기에서 열 수 없습니다 (5MB 초과).".into());
    }
    let bytes = fs::read(&abs).map_err(err)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
fn fs_write(state: State<AppState>, rel: String, content: String) -> CmdResult<bool> {
    let abs = safe_resolve(&root_of(&state)?, &rel)?;
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    fs::write(&abs, content).map_err(err)?;
    Ok(true)
}

#[tauri::command]
fn fs_create_file(state: State<AppState>, rel: String) -> CmdResult<String> {
    let root = root_of(&state)?;
    let abs = safe_resolve(&root, &rel)?;
    if abs.exists() {
        return Err("이미 존재하는 파일입니다.".into());
    }
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    fs::write(&abs, "").map_err(err)?;
    Ok(project::to_rel(&root, &abs))
}

#[tauri::command]
fn fs_create_folder(state: State<AppState>, rel: String) -> CmdResult<String> {
    let root = root_of(&state)?;
    let abs = safe_resolve(&root, &rel)?;
    fs::create_dir_all(&abs).map_err(err)?;
    Ok(project::to_rel(&root, &abs))
}

/// 삭제 (확인 창은 화면 쪽에서 띄운다). 파일이면 지우기 전 상태를 변경 기록에 남긴다.
#[tauri::command]
fn fs_delete(state: State<AppState>, rel: String) -> CmdResult<bool> {
    let root = root_of(&state)?;
    let abs = safe_resolve(&root, &rel)?;
    if abs.is_file() {
        let mut snap = history::Snapshot::new(&root, &format!("파일 삭제: {rel}"), "delete");
        snap.capture(&project::to_rel(&root, &abs)).map_err(err)?;
        fs::remove_file(&abs).map_err(err)?;
    } else if abs.is_dir() {
        fs::remove_dir_all(&abs).map_err(err)?;
    }
    Ok(true)
}

#[tauri::command]
fn fs_exists(state: State<AppState>, rel: String) -> bool {
    root_of(&state).and_then(|r| safe_resolve(&r, &rel)).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
fn reveal_path(state: State<AppState>, rel: Option<String>) -> CmdResult<String> {
    let root = root_of(&state)?;
    Ok(match rel.filter(|r| !r.is_empty()) {
        Some(r) => safe_resolve(&root, &r)?,
        None => root,
    }
    .to_string_lossy()
    .to_string())
}

#[tauri::command]
fn collect_files(state: State<AppState>, priority: Vec<String>, deploy: bool) -> Vec<Value> {
    match state.project.lock().unwrap().clone() {
        Some(r) => project::collect_files(&r, &priority, if deploy { &project::DEPLOY_LIMITS } else { &project::CHAT_LIMITS }),
        None => vec![],
    }
}

// ───────── 명령: AI가 만든 파일 저장 (변경 기록 포함) ─────────

/// AI 답변의 파일 하나를 저장한다. 채팅 하나(chat_id)당 스냅샷 하나에 바꾸기 전 상태를 모은다.
/// root는 채팅을 시작할 때의 프로젝트. 그새 프로젝트가 바뀌었으면 저장하지 않는다.
#[tauri::command]
fn ai_write_file(state: State<AppState>, chat_id: String, root: String, prompt: String, path: String, content: String) -> CmdResult<String> {
    let current = root_of(&state).map_err(|_| "프로젝트가 열려 있지 않아 파일을 저장하지 못했습니다.".to_string())?;
    if current.to_string_lossy() != root {
        return Err("프로젝트가 바뀌어 파일을 저장하지 못했습니다.".into());
    }
    let abs = safe_resolve(&current, &path)?;
    let rel = project::to_rel(&current, &abs);
    {
        let mut snaps = state.snapshots.lock().unwrap();
        let snap = snaps.entry(chat_id).or_insert_with(|| history::Snapshot::new(&current, &prompt, "ai"));
        snap.capture(&rel).map_err(err)?;
    }
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    fs::write(&abs, content).map_err(err)?;
    Ok(rel)
}

/// 채팅이 끝나면 부른다. 만든 스냅샷 id (없으면 null)
#[tauri::command]
fn ai_finish(state: State<AppState>, chat_id: String) -> Option<String> {
    state.snapshots.lock().unwrap().remove(&chat_id).filter(|s| s.created).map(|s| s.meta.id)
}

#[tauri::command]
fn history_list(state: State<AppState>) -> Value {
    match state.project.lock().unwrap().clone() {
        Some(r) => serde_json::to_value(history::list(&r)).unwrap_or(json!([])),
        None => json!([]),
    }
}

#[tauri::command]
fn history_restore(state: State<AppState>, id: String) -> CmdResult<Value> {
    let root = root_of(&state)?;
    history::restore(&root, &id, |rel| safe_resolve(&root, rel))
}

// ───────── 명령: 내 PC에 배포 ─────────

#[derive(Deserialize)]
struct DeployFile {
    path: String,
    content: String,
}

/// 공용 배포 서버에 닿지 않을 때: 앱 데이터 폴더에 저장하고 미리보기 서버로 서비스한다 (내 PC에서만 열림).
#[tauri::command]
fn deploy_local(state: State<AppState>, name: String, files: Vec<DeployFile>) -> CmdResult<String> {
    use base64::Engine;
    if files.is_empty() {
        return Err("배포할 파일이 없습니다.".into());
    }
    let suffix = format!("{:06x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos() & 0xffffff);
    let id = format!("{}-{}", project::slugify(&name), suffix);
    let dir = state.sites_dir.join(&id);
    for f in files {
        let abs = safe_resolve(&dir, &f.path)?;
        if let Some(p) = abs.parent() {
            fs::create_dir_all(p).map_err(err)?;
        }
        let bytes = match f.content.strip_prefix("data:").and_then(|r| r.split_once(";base64,")) {
            Some((_, b64)) => base64::engine::general_purpose::STANDARD.decode(b64).map_err(err)?,
            None => f.content.into_bytes(),
        };
        fs::write(abs, bytes).map_err(err)?;
    }
    Ok(format!("{}/sites/{}/", state.preview.base(), id))
}

// ───────── SEUL Chat에서 넘어온 요청 (codeai://new?text=...) ─────────

fn handle_urls(app: &AppHandle, urls: &[tauri::Url]) {
    for url in urls {
        if url.scheme() != "codeai" {
            continue;
        }
        if let Some((_, text)) = url.query_pairs().find(|(k, _)| k == "text") {
            let text: String = text.chars().take(4000).collect();
            *app.state::<AppState>().handoff.lock().unwrap() = Some(text);
            let _ = app.emit("handoff", ());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
    }
}

/// 화면이 넘어온 요청을 가져간다 (한 번만).
#[tauri::command]
fn take_handoff(state: State<AppState>) -> Option<String> {
    state.handoff.lock().unwrap().take()
}

// ───────── 메뉴 ─────────

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let version = format!("버전 {}", app.package_info().version);
    let file = Submenu::with_items(
        app,
        "파일",
        true,
        &[
            &item("new-project", "새 프로젝트…", Some("CmdOrCtrl+Shift+N"))?,
            &item("open-folder", "폴더 열기…", Some("CmdOrCtrl+O"))?,
            &item("new-file", "새 파일", Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("save", "저장", Some("CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "설정…", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("종료"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "편집",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("실행 취소"))?,
            &PredefinedMenuItem::redo(app, Some("다시 실행"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("잘라내기"))?,
            &PredefinedMenuItem::copy(app, Some("복사"))?,
            &PredefinedMenuItem::paste(app, Some("붙여넣기"))?,
            &PredefinedMenuItem::select_all(app, Some("모두 선택"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "보기",
        true,
        &[
            &item("toggle-theme", "테마 전환 (다크/라이트)", Some("CmdOrCtrl+Shift+L"))?,
            &item("refresh-preview", "미리보기 새로고침", Some("F5"))?,
            &item("history", "변경 기록", Some("CmdOrCtrl+H"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("zoom-in", "확대", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "축소", Some("CmdOrCtrl+-"))?,
            &item("zoom-reset", "원래 크기", Some("CmdOrCtrl+0"))?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "도움말",
        true,
        &[
            &item("setup", "설정 도우미 (API 키)…", None)?,
            &item("check-updates", "업데이트 확인", None)?,
            &MenuItem::with_id(app, "version", &version, false, None::<&str>)?,
        ],
    )?;
    Menu::with_items(app, &[&file, &edit, &view, &help])
}

// ───────── 시작 ─────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let config_dir = paths.app_config_dir()?;
            let data_dir = paths.app_data_dir()?;
            let settings_path = config_dir.join("settings.json");
            let legacy = paths.data_dir().ok().map(|d| d.join("Code AI").join("settings.json"));
            let settings = Settings::load(&settings_path, legacy);

            let sites_dir = data_dir.join("sites");
            let preview = preview::PreviewServer::start(sites_dir.clone()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            let bundled = paths.resource_dir().map(|d| d.join("templates")).ok().filter(|p| p.is_dir());
            let templates_dir =
                bundled.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("shared").join("templates"));

            let last = settings.last_project.clone().map(PathBuf::from).filter(|p| p.is_dir());
            app.manage(AppState {
                settings: Mutex::new(settings),
                settings_path,
                project: Mutex::new(None),
                watcher: Mutex::new(None),
                snapshots: Mutex::new(HashMap::new()),
                preview,
                sites_dir,
                templates_dir,
                handoff: Mutex::new(None),
            });

            // codeai:// 링크: 설치본은 설치할 때 등록되고, 개발 중에는 여기서 등록한다.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(all(desktop, debug_assertions))]
                let _ = app.deep_link().register_all();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    handle_urls(&handle, &urls);
                }
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| handle_urls(&h, &event.urls()));
            }
            if let Some(p) = last {
                let state = handle.state::<AppState>();
                set_project(&handle, &state, Some(p));
            }

            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().as_ref());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            api_key_get,
            api_key_store,
            preview_base,
            project_current,
            project_set,
            project_default_dir,
            project_create,
            templates_list,
            fs_tree,
            fs_read,
            fs_write,
            fs_create_file,
            fs_create_folder,
            fs_delete,
            fs_exists,
            reveal_path,
            collect_files,
            ai_write_file,
            ai_finish,
            history_list,
            history_restore,
            deploy_local,
            take_handoff,
        ])
        .run(tauri::generate_context!())
        .expect("Code AI를 시작하지 못했습니다");
}
