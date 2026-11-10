// 변경 기록 / 되돌리기 (1.x와 같은 형식이라 예전 기록도 그대로 보인다)
// <project>/.codeai/history/<id>/meta.json + files/<원래 경로>
// 스냅샷은 "변경 직전"의 파일 상태를 저장한다.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub existed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    pub time: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub files: Vec<FileEntry>,
}

fn history_dir(root: &Path) -> PathBuf {
    root.join(".codeai").join("history")
}

// 1970-01-01부터의 일수 → (년, 월, 일)  (UTC)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (id, ISO 시간). id는 1.x처럼 시간순으로 정렬되는 모양.
fn new_id() -> (String, String) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs() as i64;
    let ms = now.subsec_millis();
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let sod = secs.rem_euclid(86400);
    let (h, mi, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let rand = format!("{:04x}", (now.subsec_nanos() ^ std::process::id()) & 0xffff);
    let id = format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{ms:03}-{rand}");
    let iso = format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z");
    (id, iso)
}

pub struct Snapshot {
    root: PathBuf,
    dir: PathBuf,
    pub meta: Meta,
    saved: HashSet<String>,
    pub created: bool,
}

impl Snapshot {
    pub fn new(root: &Path, prompt: &str, kind: &str) -> Snapshot {
        let (id, time) = new_id();
        Snapshot {
            root: root.to_path_buf(),
            dir: history_dir(root).join(&id),
            meta: Meta { id, time, prompt: prompt.to_string(), kind: kind.to_string(), files: vec![] },
            saved: HashSet::new(),
            created: false,
        }
    }

    /// 파일을 바꾸기 직전에 부른다. 같은 파일은 한 스냅샷에 한 번만 저장한다.
    pub fn capture(&mut self, rel: &str) -> std::io::Result<()> {
        if !self.saved.insert(rel.to_string()) {
            return Ok(());
        }
        if !self.created {
            fs::create_dir_all(self.dir.join("files"))?;
            self.created = true;
        }
        let abs = self.root.join(rel);
        let mut existed = false;
        if abs.is_file() {
            let dest = self.dir.join("files").join(rel);
            if let Some(p) = dest.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(&abs, &dest)?;
            existed = true;
        }
        self.meta.files.push(FileEntry { path: rel.to_string(), existed });
        fs::write(self.dir.join("meta.json"), serde_json::to_string_pretty(&self.meta).unwrap_or_default())
    }
}

pub fn list(root: &Path) -> Vec<Meta> {
    let mut out: Vec<Meta> = fs::read_dir(history_dir(root))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| fs::read_to_string(e.path().join("meta.json")).ok())
                .filter_map(|t| serde_json::from_str::<Meta>(&t).ok())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

/// 스냅샷 복구. 복구 직전 상태도 새 스냅샷으로 남겨서 복구도 되돌릴 수 있게 한다.
/// `resolve`는 프로젝트 밖 경로를 막는 함수.
pub fn restore(
    root: &Path,
    id: &str,
    resolve: impl Fn(&str) -> Result<PathBuf, String>,
) -> Result<serde_json::Value, String> {
    let id = Path::new(id).file_name().and_then(|s| s.to_str()).ok_or("잘못된 기록입니다.")?;
    let dir = history_dir(root).join(id);
    let meta: Meta = fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("변경 기록을 읽을 수 없습니다.")?;
    let label = if meta.prompt.is_empty() { "되돌리기".to_string() } else { format!("되돌리기: {}", meta.prompt) };
    let mut backup = Snapshot::new(root, &label, "restore");
    let mut changed = vec![];
    let root_abs = root.to_path_buf();
    for f in &meta.files {
        let abs = resolve(&f.path)?;
        backup.capture(&f.path).map_err(|e| e.to_string())?;
        if f.existed {
            if let Some(p) = abs.parent() {
                fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            fs::copy(dir.join("files").join(&f.path), &abs).map_err(|e| e.to_string())?;
        } else {
            let _ = fs::remove_file(&abs);
            // 비게 된 상위 폴더 정리
            let mut d = abs.parent().map(Path::to_path_buf);
            while let Some(p) = d {
                if p == root_abs || !p.starts_with(&root_abs) || fs::remove_dir(&p).is_err() {
                    break;
                }
                d = p.parent().map(Path::to_path_buf);
            }
        }
        changed.push(f.path.clone());
    }
    Ok(serde_json::json!({
        "changed": changed,
        "backupId": if backup.created { Some(backup.meta.id.clone()) } else { None },
    }))
}
