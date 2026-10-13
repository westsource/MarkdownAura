//! The invoke surface (IMPL.md §3). Every command is `async` and every non-trivial one hops to
//! a blocking thread, so no command can stall the UI thread — the budgets in §9 assume that.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use serde::Serialize;
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
        crate::diag_warn!("ipc", "asset scope not widened", {
            "dir": dir.display().to_string(),
            "err": err.to_string()
        });
        // Debug builds keep the stderr mirror; the release binary has no console to print to.
        #[cfg(debug_assertions)]
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

// ---------------------------------------------------------------- links

/// What a link in a rendered document points at (SPEC §13).
///
/// This is the one place that decision is made: a URL with a scheme is the browser's, `#id` is a
/// scroll inside the document being read, and everything else is a path on this machine. *Whether* a
/// path is markdown — and so a tab of this window rather than a file in the file manager — is
/// deliberately not answered here: `MD_EXTENSIONS` in `src/ipc.ts` is the one definition of that, and
/// Rust keeps no second copy of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkTarget {
    /// A URL with a scheme (`http:`, `https:`, `mailto:`) — the default application's, never this
    /// webview's. It goes to the opener plugin, whose capability allows those three schemes and
    /// refuses every other one; a refusal is shown to the reader as the URL itself.
    External { url: String },
    /// `#fn-1`: a scroll, not a file. The ids a document really links itself with are the footnote
    /// refs and their `↩` back-refs (`markdown.rs` writes both), which are element ids in the render.
    Anchor { id: String },
    /// A path, absolute or resolved against the folder of the document the link was written in.
    /// `exists` is what turns a click on a destination that is not on disk into a toast rather than a
    /// failing open.
    Local { path: String, exists: bool },
}

/// `C:` — the shape `has_scheme` special-cases, and the shape that follows a `file:` URL's third
/// slash.
fn is_drive_letter(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic()) && chars.next() == Some(':')
}

/// A `file:` URL as the path it is: `file:///C:/docs/a.md`, `file:///home/a.md`,
/// `file://server/share/a.md`.
///
/// It arrives more often than its rarity in hand-written markdown suggests, because a copied browser
/// address bar is one. The scheme and the *authority* come off; the `/` in front of a drive letter
/// is the URL's separator rather than part of the path (`Path::new("/C:/docs")` is rooted on the
/// current drive, which is not the file the author meant); and a host, when there is one, is a UNC
/// share — which is also what a leading `//` means on Unix.
fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let path = percent_decode(path);
    let path = match path.strip_prefix('/') {
        Some(tail) if cfg!(windows) && is_drive_letter(tail) => Cow::Borrowed(tail),
        _ => path,
    };
    Some(if authority.is_empty() {
        PathBuf::from(path.as_ref())
    } else {
        // A share is spelled with the platform's own separator: `//host/share/a.md` is the URL's
        // form, and Rust keeps a path prefix exactly as it was parsed, so normalizing the components
        // would leave the mixed `//host/share\a.md` — a path Windows accepts, and one nobody writes.
        let unc = format!("//{authority}{}", path.as_ref());
        PathBuf::from(if cfg!(windows) { unc.replace('/', r"\") } else { unc })
    })
}

/// Classifies one markdown link destination (SPEC §13). `dir` is the folder of the document the link
/// was written in, which is what a relative destination is relative to.
///
/// `None` is a destination that says nothing (`[x]()`): a link with nowhere to go, not an error.
fn classify_link(dest: &str, dir: &Path) -> Option<LinkTarget> {
    let dest = dest.trim();
    // `#` ends the target and starts the fragment, and a literal `#` in a file name is written `%23`
    // — so splitting first is the URL rule rather than an approximation of it. What is decoded is
    // each half on its own, after the split, for the same reason.
    let (target, fragment) = dest.split_once('#').unwrap_or((dest, ""));
    if target.is_empty() {
        let id = percent_decode(fragment).into_owned();
        return (!id.is_empty()).then_some(LinkTarget::Anchor { id });
    }
    if let Some(path) = file_url_path(target) {
        let path = normalize(path);
        return Some(LinkTarget::Local {
            exists: path.exists(),
            path: path.display().to_string(),
        });
    }
    // Decoded *before* the scheme is read, and that order is the whole point: `E:%5Cdocs%5Ca.md` is a
    // markdown destination for an absolute Windows path (a backslash in a destination may only be
    // written encoded), and a scheme read off the raw text sees one letter and a colon and sends the
    // path to the browser. What the browser gets is still the destination as written.
    let decoded = percent_decode(target);
    // `//host/a.md` is protocol-relative, i.e. a URL; `has_scheme` knows that `C:\a.md` is not one.
    // The fragment rides along: for a URL it is the browser's to resolve.
    if decoded.starts_with("//") || has_scheme(&decoded) {
        return Some(LinkTarget::External { url: dest.to_string() });
    }
    let path = normalize(dir.join(Path::new(decoded.as_ref())));
    Some(LinkTarget::Local {
        exists: path.exists(),
        path: path.display().to_string(),
    })
}

/// Classifies a link destination from a rendered document (SPEC §13): what a click on it should open,
/// and where. The frontend makes the click; the arithmetic — a `#` fragment, percent-encoding, a
/// Windows drive letter that reads as a scheme — lives here for the same reason `resolve_target`'s
/// does.
///
/// `doc` is the document the link lives in, and only its folder is used: a relative destination is
/// relative to the file that contains it.
#[tauri::command]
pub async fn link_target(dest: String, doc: PathBuf) -> Result<Option<LinkTarget>> {
    blocking(move || {
        let dir = doc.parent().unwrap_or(Path::new("")).to_path_buf();
        Ok(classify_link(&dest, &dir))
    })
    .await
}

// ---------------------------------------------------------------- tree

#[tauri::command]
pub async fn open_folder(app: AppHandle, path: PathBuf) -> Result<fs_ops::FolderView> {
    // Absolute before anything else looks at it: the tree, the tab paths and the watcher have to agree
    // on one form, and the watcher reports absolute paths (`fs_ops::absolute`).
    let path = fs_ops::absolute(&path);
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
///
/// `math` is the reader's setting (SPEC §10), passed per call rather than stored here: the render is
/// a pure function of its inputs, and the setting can change between two renders of one document.
#[tauri::command]
pub async fn render_text(
    app: AppHandle,
    text: String,
    path: Option<PathBuf>,
    math: bool,
) -> Result<markdown::RenderedDoc> {
    blocking(move || {
        let doc = match (app.get_webview_window("main"), path.as_deref().and_then(Path::parent)) {
            (Some(webview), Some(dir)) => {
                allow_folder(&app, dir);
                markdown::render_with(&text, &image_resolver(&webview, dir), math)
            }
            // No file behind the text: nothing to resolve a relative image against, so the
            // destinations stay as they were written.
            _ => markdown::render_with(&text, &|_| None, math),
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
pub async fn render_doc(app: AppHandle, path: PathBuf, math: bool) -> Result<markdown::RenderedDoc> {
    blocking(move || {
        let payload = fs_ops::read_file(&path)?;
        // The document's own folder becomes readable here, not only when a folder is opened: a
        // document reached from the "Open markdown" dialog, the recent list or "Open with" lives
        // wherever it lives, and its images have to load regardless of what the tree shows.
        let mut doc = match app.get_webview_window("main") {
            Some(webview) => {
                let dir = path.parent().unwrap_or(Path::new(""));
                allow_folder(&app, dir);
                markdown::render_with(&payload.text, &image_resolver(&webview, dir), math)
            }
            None => markdown::render_with(&payload.text, &|_| None, math),
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

// ---------------------------------------------------------------- diagnostics

/// The front end's error reporter (IMPL.md §13.7). Enforcement lives here, not only in TS: an
/// unknown level becomes `info`, `module` and `message` are clipped, and the whole call is a no-op
/// when logging is `off`. Never the arguments — `save_doc`'s carry the document.
#[tauri::command]
pub async fn log_event(
    level: String,
    module: String,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<()> {
    blocking(move || {
        crate::diag::log_event(&level, &clip(&module, 32), &clip(&message, 200), data);
        Ok(())
    })
    .await
}

/// Pure in-memory set, so it does not hop threads: the caller wants the new level to apply before
/// its next line, and persistence is the front end's session save.
#[tauri::command]
pub fn set_log_level(level: String) -> String {
    crate::diag::set_level(&level)
}

/// Re-opens the logger at `dir` (`""` = the platform default) and returns the path now in effect.
/// If the new directory cannot be created the logger keeps writing where it was, and the caller
/// still gets a usable path back.
#[tauri::command]
pub async fn set_log_dir(dir: String) -> String {
    blocking(move || {
        Ok(crate::diag::set_dir(Some(&dir))
            .map(|path| path.display().to_string())
            .unwrap_or_else(|err| {
                crate::diag_warn!("diag", "log dir change failed", {"err": err.to_string()});
                crate::diag::dir().display().to_string()
            }))
    })
    .await
    .unwrap_or_else(|_| crate::diag::dir().display().to_string())
}

#[tauri::command]
pub async fn diag_status() -> Result<crate::diag::DiagStatus> {
    blocking(|| Ok(crate::diag::status())).await
}

/// Opens the log directory itself. `reveal_in_explorer` selects a file, and there is no file to
/// select here.
#[tauri::command]
pub async fn open_log_folder() -> Result<()> {
    blocking(move || {
        let dir = crate::diag::dir();
        #[cfg(windows)]
        let mut command = std::process::Command::new("explorer");
        #[cfg(not(windows))]
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&dir).spawn().map_err(|e| ApiError::io(&dir, e))?;
        Ok(())
    })
    .await
}

/// Clip by characters, not bytes: a message is shown to a human, and splitting a UTF-8 sequence
/// would be worse than cutting it short.
fn clip(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
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

    // ------------------------------------------------------------ links

    fn link(dest: &str) -> Option<LinkTarget> {
        classify_link(dest, &dir())
    }

    /// A local destination that is not on disk — what every case below expects unless it writes a
    /// real file.
    fn local(path: &str) -> Option<LinkTarget> {
        Some(LinkTarget::Local {
            path: path.to_string(),
            exists: false,
        })
    }

    #[test]
    fn a_url_is_the_browsers_business() {
        assert_eq!(
            link("https://example.com/a.md"),
            Some(LinkTarget::External {
                url: "https://example.com/a.md".into()
            })
        );
        assert_eq!(
            link("mailto:someone@example.com"),
            Some(LinkTarget::External {
                url: "mailto:someone@example.com".into()
            })
        );
        // A fragment of a URL is the browser's to resolve, so it stays on the URL. A destination
        // ending in `.md` is the case that would otherwise be read as a local document.
        assert_eq!(
            link("https://example.com/a#b"),
            Some(LinkTarget::External {
                url: "https://example.com/a#b".into()
            })
        );
        // Protocol-relative is still a URL, the same rule the image resolver keeps.
        assert_eq!(
            link("//example.com/a.md"),
            Some(LinkTarget::External {
                url: "//example.com/a.md".into()
            })
        );
    }

    #[test]
    fn a_local_link_resolves_against_the_documents_folder() {
        assert_eq!(link("other.md"), local(&under(&dir(), &["other.md"])));
        assert_eq!(link("./sub/a.md"), local(&under(&dir(), &["sub", "a.md"])));
        assert_eq!(
            link("../sibling.md"),
            local(&under(dir().parent().unwrap(), &["sibling.md"]))
        );
        assert_eq!(link("images/a%20b.png"), local(&under(&dir(), &["images", "a b.png"])));
        assert_eq!(link("图 1.md"), local(&under(&dir(), &["图 1.md"])));
        // A one-letter prefix with a separator after it is a drive letter, not a scheme — in a link
        // as in an image.
        let drive = if cfg!(windows) {
            r"C:\docs\a.md".to_string()
        } else {
            under(&dir(), &[r"C:\docs\a.md"])
        };
        assert_eq!(link(r"C:\docs\a.md"), local(&drive));
        // The form markdown actually carries an absolute Windows path in: a `\` may only be written
        // encoded, and `E:` must be read as a drive letter rather than as a scheme.
        let encoded_expected = if cfg!(windows) {
            r"E:\docs\a.md".to_string()
        } else {
            under(&dir(), &[r"E:\docs\a.md"])
        };
        assert_eq!(link("E:%5Cdocs%5Ca.md"), local(&encoded_expected));
    }

    #[test]
    fn a_fragment_is_a_scroll_in_the_document_being_read() {
        // What a document really links itself with: the footnote refs and their `↩` back-refs, which
        // are element ids in the render (`markdown.rs` writes both).
        assert_eq!(link("#fn-1"), Some(LinkTarget::Anchor { id: "fn-1".into() }));
        assert_eq!(link("#fnref-2"), Some(LinkTarget::Anchor { id: "fnref-2".into() }));
        // An author's `#heading` names an id the renderer never assigns, but the click is still this
        // document's business rather than a file's.
        assert_eq!(link("#配置"), Some(LinkTarget::Anchor { id: "配置".into() }));
        // A fragment on a link to *another* document: the file is what opens, and the fragment is not
        // ours to resolve — heading ids are assigned per render (`h0`, `h1`, …).
        assert_eq!(link("other.md#top"), local(&under(&dir(), &["other.md"])));
        // A destination that says nothing is not a link.
        for empty in ["", "  ", "#", " # "] {
            assert_eq!(link(empty), None, "{empty:?} says nothing");
        }
    }

    #[test]
    fn a_file_url_is_the_path_it_names() {
        // A host is the authority, and on Windows that is a UNC share. On Unix the same string is a
        // legal path and `normalize` collapses the leading `//` into one separator — which is what
        // reassembling a path from its components does there, and what the POSIX rule for a leading
        // double slash allows.
        assert_eq!(
            link("file://server/share/a.md"),
            local(if cfg!(windows) {
                r"\\server\share\a.md"
            } else {
                "/server/share/a.md"
            })
        );
        // The third slash is the URL's, not the path's: what follows it is a drive letter, and
        // `C:\docs` is a different file from a `/C:/docs` rooted on the current drive.
        assert_eq!(
            link("file:///C:/docs/a.md"),
            local(if cfg!(windows) { r"C:\docs\a.md" } else { "/C:/docs/a.md" })
        );
        // Off the drive letter the root survives, and percent-encoding decodes as it does everywhere.
        if !cfg!(windows) {
            assert_eq!(link("file:///home/a%20b.md"), local("/home/a b.md"));
        }
    }

    #[test]
    fn a_destination_that_is_on_disk_says_so() {
        // The one thing the frontend branches on: a link to a file that is not there becomes a toast
        // instead of a failing open.
        let base = std::env::temp_dir().join("markdownaura-link-target");
        std::fs::create_dir_all(&base).unwrap();
        let real = base.join("real.md");
        std::fs::write(&real, "# real\n").unwrap();

        assert_eq!(
            classify_link("real.md", &base),
            Some(LinkTarget::Local {
                path: real.display().to_string(),
                exists: true
            })
        );
        assert_eq!(
            classify_link("gone.md", &base),
            local(&base.join("gone.md").display().to_string())
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
