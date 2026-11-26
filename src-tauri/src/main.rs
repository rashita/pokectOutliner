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
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
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
const COLOR_MODES: [(&str, &str, Option<Theme>); 3] = [
    ("theme-system", "Macのデフォルトに合わせる", None),
    ("theme-light", "ライトモード", Some(Theme::Light)),
    ("theme-dark", "ダークモード", Some(Theme::Dark)),
];

struct ColorMenu(Vec<CheckMenuItem<tauri::Wry>>);

fn color_mode_path(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("color-mode"))
}

fn color_menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::new(app, "カラーモード", true)?;
    let mut items = Vec::new();
    for (id, title, _) in COLOR_MODES {
        let item =
            CheckMenuItem::with_id(app, id, title, true, id == COLOR_MODES[0].0, None::<&str>)?;
        submenu.append(&item)?;
        items.push(item);
    }
    app.manage(ColorMenu(items));
    Ok(submenu)
}

fn apply_color_mode(app: &tauri::AppHandle, id: &str, theme: Option<Theme>) {
    app.set_theme(theme);
    let Some(menu) = app.try_state::<ColorMenu>() else {
        return;
    };
    for item in &menu.0 {
        if let Err(error) = item.set_checked(item.id().as_ref() == id) {
            eprintln!("Could not update the color mode menu: {error}");
        }
    }
}

fn save_color_mode(app: &tauri::AppHandle, id: &str) {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let path = color_mode_path(app)?;
        fs::create_dir_all(app.path().app_config_dir()?)?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, id)?;
        fs::rename(temporary, path)?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Could not save the color mode: {error}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Documents::default())
        .menu(|app| {
            let menu = Menu::default(app)?;
            for item in menu.items()? {
                if let Some(submenu) = item.as_submenu() {
                    match submenu.text()?.as_str() {
                        "File" => {
                            submenu.insert_items(
                                &[
                                    &MenuItem::with_id(
                                        app,
                                        "new-document",
                                        "新規ウィンドウ",
                                        true,
                                        Some("CmdOrCtrl+N"),
                                    )?,
                                    &MenuItem::with_id(
                                        app,
                                        "open-document",
                                        "開く…",
                                        true,
                                        Some("CmdOrCtrl+O"),
                                    )?,
                                    &PredefinedMenuItem::separator(app)?,
                                    &MenuItem::with_id(
                                        app,
                                        "save-document",
                                        "保存",
                                        true,
                                        Some("CmdOrCtrl+S"),
                                    )?,
                                    &MenuItem::with_id(
                                        app,
                                        "save-document-as",
                                        "名前を付けて保存…",
                                        true,
                                        Some("CmdOrCtrl+Shift+S"),
                                    )?,
                                    &PredefinedMenuItem::separator(app)?,
                                ],
                                0,
                            )?;
                        }
                        "View" => {
                            submenu.append_items(&[
                                &PredefinedMenuItem::separator(app)?,
                                &MenuItem::with_id(
                                    app,
                                    "zoom-row",
                                    "カーソル行にズーム",
                                    true,
                                    Some("CmdOrCtrl+Alt+Right"),
                                )?,
                                &MenuItem::with_id(
                                    app,
                                    "zoom-reset",
                                    "アウトライン全体を表示",
                                    true,
                                    Some("CmdOrCtrl+Alt+Left"),
                                )?,
                            ])?;
                            submenu.append(&color_menu(app)?)?;
                        }
                        "Help" => submenu.append(&MenuItem::with_id(
                            app,
                            "show-guide",
                            "操作ガイド",
                            true,
                            Some("CmdOrCtrl+Shift+Slash"),
                        )?)?,
                        _ => {}
                    }
                }
            }
            Ok(menu)
        })
        .setup(|app| {
            let saved = color_mode_path(app.handle())
                .ok()
                .and_then(|path| fs::read_to_string(path).ok());
            let selected = COLOR_MODES
                .iter()
                .find(|(id, _, _)| Some(*id) == saved.as_deref())
                .unwrap_or(&COLOR_MODES[0]);
            apply_color_mode(app.handle(), selected.0, selected.2);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if let Some((id, _, theme)) = COLOR_MODES.iter().find(|(id, _, _)| *id == action) {
                apply_color_mode(app, id, *theme);
                save_color_mode(app, id);
                return;
            }
            if matches!(
                action,
                "new-document"
                    | "open-document"
                    | "save-document"
                    | "save-document-as"
                    | "show-guide"
                    | "zoom-row"
                    | "zoom-reset"
            ) {
                for window in app.webview_windows().values() {
                    if window.is_focused().unwrap_or(false) {
                        let _ = window.emit("menu-action", action);
                        break;
                    }
                }
            }
        })
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
