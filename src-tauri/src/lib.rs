//! App assembly: state, plugins, the command surface, and CLI handling.

mod commands;
mod defaultapp;
mod engines;
mod error;
mod fs_ops;
mod markdown;
mod session;
mod watcher;

pub use error::ApiError;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use watcher::FsWatcher;

/// Emitted to the running window when a second launch hands over a path.
pub const OPEN_EVENT: &str = "app://open";

#[derive(Debug, Clone, Default)]
pub struct Startup {
    pub target: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupInfo {
    pub path: Option<String>,
}

pub struct AppState {
    pub startup: Mutex<Startup>,
}

/// The watcher is optional on purpose: if it cannot be created the app should still read
/// markdown, it just cannot promise live reload. `None` is a state, not a panic.
pub struct WatcherState(pub Mutex<Option<FsWatcher>>);

/// `markdownaura <folder|file>`. The first non-flag argument wins; unknown flags are ignored.
fn parse_args<I: Iterator<Item = String>>(args: I) -> Startup {
    let mut startup = Startup::default();
    for arg in args {
        match arg.as_str() {
            other if other.starts_with('-') => {
                // Unknown flags are ignored rather than fatal: a stray argument from a shell
                // integration must not stop the window from opening.
            }
            other if startup.target.is_none() => startup.target = Some(PathBuf::from(other)),
            _ => {}
        }
    }
    startup
}

pub fn run() {
    let startup = parse_args(std::env::args().skip(1));

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    {
        // Without this, "Open with MarkdownAura" on a .md starts a new window per file. The plugin
        // covers Windows, Linux and macOS: on Linux it goes through the session D-Bus (a Flatpak or
        // Snap package whose id differs from the app identifier has to set `DBUS_ID` — see the
        // plugin's README), so nothing extra is needed here.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let forwarded = parse_args(argv.into_iter().skip(1));
            if let Some(path) = forwarded.target {
                let _ = app.emit(OPEN_EVENT, path.display().to_string());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .manage(AppState {
            startup: Mutex::new(startup),
        })
        .manage(WatcherState(Mutex::new(None)))
        .setup(|app| {
            // The window is created here rather than in tauri.conf.json because one of its
            // settings cannot be static: on restricted sessions (remote desktop, some
            // sandboxes) the WebView2 browser process crashes at startup — one Crashpad dump per
            // launch, no webview2 process left alive, and a window that is a perfectly sized
            // empty shell. `--no-sandbox` fixes it there, and it is exactly the flag that must
            // never be a shipped default.
            //
            // So it is opt-in through the environment, and nothing else about the window differs
            // between the two paths. On a normal desktop the variable is unset and the sandbox
            // stays on.
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("MarkdownAura")
                .inner_size(1200.0, 800.0)
                .min_inner_size(720.0, 480.0)
                .center()
                .resizable(true)
                .decorations(false);
            // `drag_and_drop` is a Windows-only builder method — tauri gates it `#[cfg(windows)]`,
            // and it is a different switch from `disable_drag_drop_handler`. Elsewhere the handler
            // is what decides whether the WebView sees HTML5 drop events, and it is on by default,
            // so the frontend listens to Tauri's drag events on every platform (main.ts).
            #[cfg(windows)]
            {
                window = window.drag_and_drop(true);
            }

            if let Ok(args) = std::env::var("MARKDOWNAURA_BROWSER_ARGS") {
                eprintln!("MarkdownAura: applying MARKDOWNAURA_BROWSER_ARGS: {args}");
                window = window.additional_browser_args(&args);
            }
            window.build()?;

            let handle = app.handle().clone();
            let watcher = match FsWatcher::new(handle) {
                Ok(w) => Some(w),
                Err(err) => {
                    // Degrade, do not die: the window opens without live reload.
                    eprintln!("file watching is unavailable: {err}");
                    None
                }
            };
            *app.state::<WatcherState>().0.lock().expect("watcher lock") = watcher;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_folder,
            commands::read_dir,
            commands::resolve_target,
            commands::read_file,
            commands::save_doc,
            commands::render_doc,
            commands::render_text,
            commands::reveal_in_explorer,
            commands::watch_set,
            commands::watch_stop_all,
            commands::watcher_status,
            commands::session_load,
            commands::session_save,
            commands::engine_status,
            commands::startup_target,
            commands::note_recent,
            commands::data_directory,
            commands::default_app_status,
            commands::set_default_app,
        ])
        .run(tauri::generate_context!())
        .expect("MarkdownAura failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Startup {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn a_bare_path_is_the_target() {
        let s = args(&["E:\\notes"]);
        assert_eq!(s.target, Some(PathBuf::from("E:\\notes")));
    }

    #[test]
    fn unknown_flags_are_ignored_and_do_not_become_a_path() {
        // `--last` used to be a flag; session restore is unconditional now, so it is just an
        // unknown argument like any other.
        let s = args(&["--last", "E:\\notes\\README.md"]);
        assert_eq!(s.target, Some(PathBuf::from("E:\\notes\\README.md")));
        let s = args(&["--last"]);
        assert_eq!(s.target, None);
    }

    #[test]
    fn only_the_first_path_wins_and_unknown_flags_are_ignored() {
        let s = args(&["--wat", "one.md", "two.md"]);
        assert_eq!(s.target, Some(PathBuf::from("one.md")));
    }
}
