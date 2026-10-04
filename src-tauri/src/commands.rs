//! The invoke surface (IMPL.md §3). Every command is `async` and every non-trivial one hops to
//! a blocking thread, so no command can stall the UI thread — the budgets in §9 assume that.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::error::{ApiError, Result};
use crate::watcher::WatcherStatus;
use crate::{engines, fs_ops, markdown, session, watcher::FsWatcher, AppState, StartupInfo, WatcherState};

/// Runs blocking work off the UI thread. A poisoned or cancelled task is reported as an I/O
/// error rather than panicking, because a failed render must degrade, not abort the app.
async fn blocking<F, T>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| ApiError::io_plain(Path::new("<task>"), std::io::ErrorKind::Other, e.to_string()))?
}

fn lock_failed(what: &str) -> ApiError {
    ApiError::Io {
        path: format!("<{what}>"),
        message: format!("{what} is unavailable"),
    }
}

// ---------------------------------------------------------------- tree

#[tauri::command]
pub async fn open_folder(app: AppHandle, path: PathBuf) -> Result<fs_ops::FolderView> {
    let view = blocking({
        let path = path.clone();
        move || fs_ops::open_folder(&path)
    })
    .await?;

    // Local images inside the document resolve through the asset protocol, and the scope has to
    // be widened to the folder the user actually opened. Without this, every relative image in
    // every document is a broken icon.
    if let Err(err) = app.asset_protocol_scope().allow_directory(&path, true) {
        eprintln!("asset scope not widened for {}: {err}", path.display());
    }

    Ok(view)
}

#[tauri::command]
pub async fn read_dir(path: PathBuf) -> Result<Vec<fs_ops::TreeEntry>> {
    blocking(move || fs_ops::list_dir(&path)).await
}

/// Turns a path from the CLI or from a shell integration into the folder the window should show:
/// a file resolves to its own folder, a folder to itself.
///
/// This lives in Rust rather than the frontend because the alternative is hand-rolling separator
/// arithmetic in TypeScript, and `C:\file.md` minus its last segment is `C:` — not `C:\`.
#[tauri::command]
pub async fn resolve_target(path: PathBuf) -> Result<fs_ops::FolderView> {
    blocking(move || fs_ops::resolve_target(&path)).await
}

#[tauri::command]
pub async fn read_file(path: PathBuf) -> Result<fs_ops::FilePayload> {
    blocking(move || fs_ops::read_file(&path)).await
}

/// Writes an edited buffer back (SPEC §12). The mtime check is the safety net under the reader's
/// reload policy: an external change wins, so a save that would overwrite content the buffer never
/// saw is refused instead of applied.
#[tauri::command]
pub async fn save_doc(
    path: PathBuf,
    text: String,
    encoding: String,
    eol: String,
    expected_mtime_ms: i64,
) -> Result<i64> {
    blocking(move || fs_ops::write_file(&path, &text, &encoding, &eol, expected_mtime_ms)).await
}

/// Renders markdown that has no file behind it — the live preview of an edited buffer (SPEC §12).
///
/// Same shape as `render_doc` so the frontend's diagram pipeline cannot tell the two apart. A buffer
/// is neither decoded nor cut, so `encoding` and `truncated` come back empty/false; the caller
/// already holds both facts on the tab, and the frontend overrides them from there.
#[tauri::command]
pub async fn render_text(text: String) -> Result<markdown::RenderedDoc> {
    blocking(move || Ok(markdown::render(&text))).await
}

/// Renders for the preview/split views. The frontend never sees raw markdown for these — the
/// source view is the one place that asks for the text.
///
/// `html` dominates the response (2–3x the source size); see IMPL.md §4 "Payload" before
/// changing this signature or reaching for the raw byte channel.
#[tauri::command]
pub async fn render_doc(path: PathBuf) -> Result<markdown::RenderedDoc> {
    blocking(move || {
        let payload = fs_ops::read_file(&path)?;
        let mut doc = markdown::render(&payload.text);
        // The decode result rides with the render so the status bar can badge a lossy read
        // without the frontend making a second trip for the same file. Truncation does too:
        // a prefix must never be shown as if it were the whole document.
        doc.encoding = payload.encoding;
        doc.truncated = payload.truncated;
        Ok(doc)
    })
    .await
}

#[tauri::command]
pub async fn reveal_in_explorer(path: PathBuf) -> Result<()> {
    blocking(move || {
        #[cfg(windows)]
        {
            std::process::Command::new("explorer")
                .arg(format!("/select,{}", path.display()))
                .spawn()
                .map_err(|e| ApiError::io(&path, e))?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let dir = path.parent().unwrap_or(&path).to_path_buf();
            std::process::Command::new("xdg-open")
                .arg(&dir)
                .spawn()
                .map_err(|e| ApiError::io(&dir, e))?;
            Ok(())
        }
    })
    .await
}

// ---------------------------------------------------------------- watching

#[tauri::command]
pub async fn watch_set(paths: Vec<PathBuf>, state: State<'_, WatcherState>) -> Result<WatcherStatus> {
    let mut guard = state.0.lock().map_err(|_| lock_failed("watcher"))?;
    guard
        .as_mut()
        .ok_or_else(|| lock_failed("watcher"))?
        .set_paths(paths)
}

#[tauri::command]
pub async fn watch_stop_all(state: State<'_, WatcherState>) -> Result<()> {
    let mut guard = state.0.lock().map_err(|_| lock_failed("watcher"))?;
    match guard.as_mut() {
        Some(w) => w.stop_all(),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn watcher_status(state: State<'_, WatcherState>) -> Result<WatcherStatus> {
    let guard = state.0.lock().map_err(|_| lock_failed("watcher"))?;
    Ok(guard.as_ref().map(FsWatcher::status).unwrap_or(WatcherStatus { watching: 0 }))
}

// ---------------------------------------------------------------- session

#[tauri::command]
pub async fn session_load() -> Result<Option<session::Session>> {
    blocking(|| Ok(session::load())).await
}

#[tauri::command]
pub async fn session_save(session: session::Session) -> Result<()> {
    blocking(move || session::save(&session)).await
}

// ---------------------------------------------------------------- engines

#[tauri::command]
pub async fn engine_status() -> Result<Vec<engines::EngineInfo>> {
    blocking(|| Ok(engines::status())).await
}

// ---------------------------------------------------------------- boot

/// What the window should open on first paint. A command rather than an event so the frontend
/// cannot miss it by mounting late.
#[tauri::command]
pub fn startup_target(state: State<'_, AppState>) -> StartupInfo {
    let guard = state.startup.lock().expect("startup lock");
    StartupInfo {
        path: guard.target.as_ref().map(|p| p.display().to_string()),
    }
}

/// Record the folder the user opened so `recent` has something to use — for the empty state's
/// links, `ctrl shift P`, and the folder `restoreSession` reopens on the next launch.
#[tauri::command]
pub async fn note_recent(entry: String) -> Result<Vec<String>> {
    blocking(move || {
        let mut current = session::load().unwrap_or_default();
        session::push_recent(&mut current.recent, &entry);
        session::save(&current)?;
        Ok(current.recent)
    })
    .await
}

/// Where the app keeps its state. The About sheet shows it and offers to open it — the frontend
/// cannot compute `%APPDATA%` itself, and this is the only reason it needs to know.
#[tauri::command]
pub fn data_directory() -> String {
    session::data_dir().display().to_string()
}

// ---------------------------------------------------------------- default handler

/// What the system currently opens `.md` with, and what this platform will let us do about it.
#[tauri::command]
pub fn default_app_status() -> crate::defaultapp::DefaultAppStatus {
    crate::defaultapp::status()
}

/// Linux: sets it. Windows: hands the choice to the user through the *Open with* dialog on `path`, or
/// the Default Apps page when there is no document open — because Windows will not let a process set it.
#[tauri::command]
pub async fn set_default_app(path: Option<PathBuf>) -> Result<String> {
    blocking(move || crate::defaultapp::set_default(path)).await
}
