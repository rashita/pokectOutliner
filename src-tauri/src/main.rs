#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Documents(Mutex<HashMap<String, (PathBuf, String)>>);
#[derive(serde::Serialize)]
struct Document {
    path: Option<String>,
    text: String,
    folds: Vec<usize>,
}
fn fingerprint(text: &str) -> u64 {
    text.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    })
}
fn state_path(app: &tauri::AppHandle, path: &PathBuf) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("folds");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:x}.json", hash.finish())))
}
fn new_window(app: &tauri::AppHandle) -> Result<String, String> {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let label = format!("document-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Pocket Outliner")
        .inner_size(620.0, 740.0)
        .min_inner_size(320.0, 280.0)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}
#[tauri::command]
async fn create_document(app: tauri::AppHandle) -> Result<(), String> {
    new_window(&app).map(|_| ())
}
#[tauri::command]
fn load_document(
    app: tauri::AppHandle,
    window: WebviewWindow,
    docs: tauri::State<Documents>,
) -> Result<Document, String> {
    let guard = docs.0.lock().unwrap();
    if let Some((path, text)) = guard.get(window.label()) {
        let folds = state_path(&app, path)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<(u64, Vec<usize>)>(&s).ok())
            .filter(|(saved, _)| *saved == fingerprint(text))
            .map(|(_, folds)| folds)
            .unwrap_or_default();
        Ok(Document {
            path: Some(path.to_string_lossy().into()),
            text: text.clone(),
            folds,
        })
    } else {
        Ok(Document {
            path: None,
            text: String::new(),
            folds: vec![],
        })
    }
}
#[tauri::command]
async fn open_documents(app: tauri::AppHandle) -> Result<(), String> {
    let Some(files) = app
        .dialog()
        .file()
        .add_filter("Text", &["txt", "md", "markdown"])
        .blocking_pick_files()
    else {
        return Ok(());
    };
    for file in files {
        let path = file
            .into_path()
            .map_err(|e| e.to_string())?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let existing = app
            .state::<Documents>()
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, (p, _))| p == &path)
            .map(|(k, _)| k.clone());
        if let Some(label) = existing {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.set_focus();
                continue;
            }
        }
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // Hold the map lock until the new window is registered, before its load command can run.
        let docs = app.state::<Documents>();
        let mut guard = docs.0.lock().unwrap();
        let label = new_window(&app)?;
        guard.insert(label, (path, text));
    }
    Ok(())
}
#[tauri::command]
async fn save_document(
    app: tauri::AppHandle,
    window: WebviewWindow,
    text: String,
    save_as: bool,
    markdown: bool,
) -> Result<Option<String>, String> {
    let current = app
        .state::<Documents>()
        .0
        .lock()
        .unwrap()
        .get(window.label())
        .cloned();
    let path = if save_as || current.is_none() {
        let name = current
            .as_ref()
            .and_then(|(p, _)| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or(if markdown {
                "Untitled.md"
            } else {
                "Untitled.txt"
            });
        let Some(file) = app.dialog().file().set_file_name(name).blocking_save_file() else {
            return Ok(None);
        };
        file.into_path().map_err(|e| e.to_string())?
    } else {
        current.as_ref().unwrap().0.clone()
    };
    let path = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path
    };
    let docs = app.state::<Documents>();
    let mut guard = docs.0.lock().unwrap();
    if guard
        .iter()
        .any(|(label, (p, _))| label != window.label() && p == &path)
    {
        return Err("このファイルは別のウィンドウで開いています。".into());
    }
    if let Some((old_path, old_text)) = &current {
        if old_path == &path && fs::read_to_string(&path).map_err(|e| e.to_string())? != *old_text {
            return Err("外部でファイルが変更されています。「名前を付けて保存」で変更を別ファイルに保存してください。".into());
        }
    }
    let temporary = path.with_file_name(format!(
        ".pocket-{}-{}.tmp",
        std::process::id(),
        window.label()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(&path) {
            fs::set_permissions(&temporary, meta.permissions())?;
        }
        fs::rename(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    guard.insert(window.label().into(), (path.clone(), text));
    Ok(Some(path.to_string_lossy().into()))
}
#[tauri::command]
fn save_folds(
    app: tauri::AppHandle,
    window: WebviewWindow,
    text: String,
    folds: Vec<usize>,
    docs: tauri::State<Documents>,
) -> Result<(), String> {
    if let Some((path, _)) = docs.0.lock().unwrap().get(window.label()) {
        fs::write(
            state_path(&app, path)?,
            serde_json::to_vec(&(fingerprint(&text), folds)).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Documents::default())
        .invoke_handler(tauri::generate_handler![
            create_document,
            load_document,
            open_documents,
            save_document,
            save_folds
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window
                    .state::<Documents>()
                    .0
                    .lock()
                    .unwrap()
                    .remove(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not start Pocket Outliner")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let windows = app.webview_windows();
                if !windows.is_empty() {
                    api.prevent_exit();
                    for window in windows.values() {
                        let _ = window.close();
                    }
                }
            }
        });
}
