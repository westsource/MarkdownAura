//! The invoke surface (IMPL.md §3). Every command is `async` and every non-trivial one hops to
//! a blocking thread, so no command can stall the UI thread — the budgets in §9 assume that.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State, WebviewWindow};

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

// ---------------------------------------------------------------- images

/// Makes `dir` readable back over the asset protocol.
///
/// The protocol starts with an empty scope and serves nothing else, so this is the one thing
/// standing between a document and every image it references. Called for the folders the app is
/// asked to work with — the opened root and the folder of every document it renders. Repeating a
/// folder is a no-op (the scope is a set of patterns); a scope that refuses to widen is logged, not
/// fatal, because a missing image must not take the document with it.
fn allow_folder<R: tauri::Runtime>(app: &AppHandle<R>, dir: &Path) {
    if let Err(err) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("asset scope not widened for {}: {err}", dir.display());
    }
}

/// RFC 3986 `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`: the destinations this must not
/// touch are `http:`, `https:`, `data:` and friends.
///
/// `C:\img\a.png` matches that grammar — one letter and a colon *is* a scheme by the letter of it —
/// so it is special-cased: the URL standard calls a one-letter scheme followed by a separator a
/// Windows drive letter, and no real scheme is one letter long. Without this, an absolute Windows
/// path is left alone and stays a broken image.
fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else {
        return false;
    };
    let scheme = &dest[..colon];
    let mut chars = scheme.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return false;
    }
    if scheme.len() == 1 && matches!(dest.as_bytes().get(colon + 1), None | Some(b'\\') | Some(b'/')) {
        return false;
    }
    true
}

/// `%20` -> ` `, `%E4%B8%AD` -> `中`.
///
/// A markdown destination is a URL, and a space in a filename may only appear in one encoded:
/// a browser decodes it before it looks for the file, so this has to as well. A malformed escape,
/// or a sequence that is not UTF-8, keeps the bytes the author wrote rather than guessing.
fn percent_decode(dest: &str) -> Cow<'_, str> {
    if !dest.contains('%') {
        return Cow::Borrowed(dest);
    }
    let bytes = dest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |index: usize| -> Option<u8> {
            bytes.get(index).and_then(|b| (*b as char).to_digit(16)).map(|d| d as u8)
        };
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (hex(i + 1), hex(i + 2)) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_or(Cow::Borrowed(dest), Cow::Owned)
}

/// Resolves `.` and `..` lexically — no filesystem access.
///
/// This is not an optimisation, it is required: the asset protocol refuses any URL whose path still
/// contains a `..` (`SafePathBuf`), and `fs::canonicalize` is not a substitute — it fails for a file
/// that does not exist, and on Windows it answers with the `\\?\` verbatim form, which is not the
/// form the scope holds.
fn normalize(path: PathBuf) -> PathBuf {
    use std::path::Component;

    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            // A `..` that walks past the root keeps the root: there is nothing above it to go to.
            Component::ParentDir => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    out
}

/// The file a markdown image destination points at, or `None` when the destination is not a local
/// path at all (`http:`, `data:`, protocol-relative, empty) and must be left to the CSP.
///
/// `dir` is the document's folder. A destination that resolves outside it is returned anyway: the
/// scope, not this function, is the authority on what may be read, and a silently dropped image is
/// worse than one the protocol refuses.
fn local_image_path(dest: &str, dir: &Path) -> Option<PathBuf> {
    let dest = dest.trim();
    if dest.is_empty() || dest.starts_with("//") || has_scheme(dest) {
        return None;
    }
    let decoded = percent_decode(dest);
    Some(normalize(dir.join(Path::new(decoded.as_ref()))))
}

/// Turns a markdown image destination into a URL this webview can load, or `None` to leave the
/// author's destination alone.
///
/// A relative `src` resolves against the app's own origin in a webview, never against the folder
/// the document came from — so every local image is a broken icon until it is rewritten into an
/// asset-protocol URL, which is the only origin the CSP lets an image through.
fn image_resolver<'a, R: tauri::Runtime>(
    webview: &'a WebviewWindow<R>,
    dir: &Path,
) -> impl Fn(&str) -> Option<String> + 'a {
    let dir = dir.to_path_buf();
    move |dest: &str| webview.convert_file_src(local_image_path(dest, &dir)?, None).ok()
}

// ---------------------------------------------------------------- tree

#[tauri::command]
pub async fn open_folder(app: AppHandle, path: PathBuf) -> Result<fs_ops::FolderView> {
    let view = blocking({
        let path = path.clone();
        move || fs_ops::open_folder(&path)
    })
    .await?;

    // The folder the user opened is readable: a document in it may reference images beside it, and
    // a document in a subfolder may reach back up to a shared assets folder inside it.
    allow_folder(&app, &path);

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
pub async fn resolve_target(app: AppHandle, path: PathBuf) -> Result<fs_ops::FolderView> {
    let view = blocking({
        let path = path.clone();
        move || fs_ops::resolve_target(&path)
    })
    .await?;

    // Same rule as `open_folder`: this command adopts a folder too, and a document opened from
    // outside the tree ("Open with", a recent entry) must have its images load.
    allow_folder(&app, Path::new(&view.root));

    Ok(view)
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
///
/// `path` is the document the buffer belongs to, and it is not optional by accident: the buffer is
/// unsaved text, but its images are still the file's images, resolved against the file's folder.
#[tauri::command]
pub async fn render_text(
    app: AppHandle,
    text: String,
    path: Option<PathBuf>,
) -> Result<markdown::RenderedDoc> {
    blocking(move || {
        let doc = match (app.get_webview_window("main"), path.as_deref().and_then(Path::parent)) {
            (Some(webview), Some(dir)) => {
                allow_folder(&app, dir);
                markdown::render_with(&text, &image_resolver(&webview, dir))
            }
            // No file behind the text: nothing to resolve a relative image against, so the
            // destinations stay as they were written.
            _ => markdown::render(&text),
        };
        Ok(doc)
    })
    .await
}

/// Renders for the preview/split views. The frontend never sees raw markdown for these — the
/// source view is the one place that asks for the text.
///
/// `html` dominates the response (2–3x the source size); see IMPL.md §4 "Payload" before
/// changing this signature or reaching for the raw byte channel.
#[tauri::command]
pub async fn render_doc(app: AppHandle, path: PathBuf) -> Result<markdown::RenderedDoc> {
    blocking(move || {
        let payload = fs_ops::read_file(&path)?;
        // The document's own folder becomes readable here, not only when a folder is opened: a
        // document reached from the "Open markdown" dialog, the recent list or "Open with" lives
        // wherever it lives, and its images have to load regardless of what the tree shows.
        let mut doc = match app.get_webview_window("main") {
            Some(webview) => {
                let dir = path.parent().unwrap_or(Path::new(""));
                allow_folder(&app, dir);
                markdown::render_with(&payload.text, &image_resolver(&webview, dir))
            }
            None => markdown::render(&payload.text),
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\docs")
        } else {
            PathBuf::from("/docs")
        }
    }

    /// `join` one component at a time: a `/` inside a component would stay a `/`, and the resolver
    /// rebuilds the path from its components, so it always answers with the native separator.
    fn under(base: &Path, parts: &[&str]) -> String {
        parts
            .iter()
            .fold(base.to_path_buf(), |p, part| p.join(part))
            .display()
            .to_string()
    }

    fn resolved(dest: &str) -> String {
        local_image_path(dest, &dir()).map_or_else(|| "<left alone>".to_string(), |p| p.display().to_string())
    }

    #[test]
    fn a_relative_image_resolves_against_the_documents_folder() {
        assert_eq!(resolved("images/01-preview.png"), under(&dir(), &["images", "01-preview.png"]));
        assert_eq!(resolved("./images/a.png"), under(&dir(), &["images", "a.png"]));
        // A percent-encoded space is the only way a space can be written in a markdown destination,
        // and the file is named with a space.
        assert_eq!(resolved("images/a%20b.png"), under(&dir(), &["images", "a b.png"]));
        // Chinese filenames arrive as literal UTF-8, not encoded.
        assert_eq!(resolved("images/图 1.png"), under(&dir(), &["images", "图 1.png"]));
    }

    #[test]
    fn parent_segments_are_resolved_away() {
        // The asset protocol refuses any URL whose path still holds a `..`, so `../` has to be
        // gone before the URL exists.
        assert_eq!(
            resolved("../shared/a.png"),
            under(dir().parent().unwrap(), &["shared", "a.png"])
        );
        assert_eq!(resolved("a/b/../../c.png"), under(&dir(), &["c.png"]));
        // Above the root there is nothing to walk up to; the root survives.
        let deep = local_image_path("../../../../a.png", &dir()).expect("still a local path");
        assert!(!deep.components().any(|c| matches!(c, std::path::Component::ParentDir)));
    }

    #[test]
    fn destinations_that_are_not_local_files_are_left_alone() {
        for dest in [
            "https://example.com/a.png",
            "http://example.com/a.png",
            "data:image/png;base64,AAAA",
            "//example.com/a.png",
            "  ",
        ] {
            assert_eq!(resolved(dest), "<left alone>", "{dest} is not a local path");
        }
        // A one-letter "scheme" with a separator after it is a Windows drive letter, not a URL
        // scheme, so it resolves as the path it is. Off Windows the same two destinations are legal
        // *relative* paths — a directory really can be called `c:` there — so they resolve under the
        // document's folder; the point of the rule is that both platforms agree a path is a path.
        assert_eq!(
            resolved(r"C:\img\a.png"),
            if cfg!(windows) {
                r"C:\img\a.png".to_string()
            } else {
                under(&dir(), &[r"C:\img\a.png"])
            }
        );
        assert_eq!(
            resolved("c:/img/a.png"),
            if cfg!(windows) {
                r"c:\img\a.png".to_string()
            } else {
                under(&dir(), &["c:", "img", "a.png"])
            }
        );
    }

    /// The one thing the unit tests above cannot see: whether the URL that comes out is one the
    /// asset protocol will actually serve. It runs tauri's own `convert_file_src` and its own
    /// `Scope`, and replays what `protocol/asset.rs` does to a request — strip the origin,
    /// percent-decode, refuse a `..`, ask the scope. A wrong encoding, a surviving `..`, or a scope
    /// that was never widened to the document's folder all fail here, and each of them is a broken
    /// image on screen.
    #[test]
    fn the_url_points_back_at_the_file_the_scope_allows() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let webview =
            tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
                .build()
                .unwrap();

        let dir = std::env::temp_dir().join("markdownaura-asset-scope");
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images").join("01-preview.png"), b"png").unwrap();
        allow_folder(app.handle(), &dir);

        // `..` on the way in, a file that exists on the way out.
        let dest = format!("../{}/images/01-preview.png", dir.file_name().unwrap().to_string_lossy());
        let url = image_resolver(&webview, &dir)(&dest).expect("a local image gets a URL");

        let encoded = url.split("localhost/").nth(1).expect("an asset URL");
        let decoded = percent_decode(encoded).into_owned();
        let safe =
            tauri::path::SafePathBuf::new(decoded.clone().into()).expect("no `..` left in the URL");
        assert!(app.asset_protocol_scope().is_allowed(&safe), "scope refuses {decoded}");
    }
}
