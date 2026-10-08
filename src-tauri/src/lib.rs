//! App assembly: state, plugins, the command surface, and CLI handling.

mod commands;
mod defaultapp;
mod diag;
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
    // First statement, before any Tauri type exists: a panic inside plugin init or the window
    // build is exactly the kind of failure this has to capture (IMPL.md §13.2).
    diag::init();
    let startup = parse_args(std::env::args().skip(1));

    // The boot breadcrumb. Paths and counts only — argv is a document path at most (IMPL.md §13.9).
    crate::diag_info!("app", "start", {
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "log_dir": diag::dir().display().to_string(),
        "browser_args": std::env::var_os("MARKDOWNAURA_BROWSER_ARGS").is_some(),
        "argv": std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(),
    });

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
            // The single-instance plugin has already decided this process owns the window, so this
            // is the earliest safe point to record the run marker (IMPL.md §13.5).
            diag::mark_running();

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
                crate::diag_info!("app", "applying MARKDOWNAURA_BROWSER_ARGS", {"args": args});
                // Debug builds keep the stderr mirror: the console is the fast feedback loop there.
                #[cfg(debug_assertions)]
                eprintln!("MarkdownAura: applying MARKDOWNAURA_BROWSER_ARGS: {args}");
                window = window.additional_browser_args(&args);
            }
            window.build()?;

            let handle = app.handle().clone();
            let watcher = match FsWatcher::new(handle) {
                Ok(w) => Some(w),
                Err(err) => {
                    // Degrade, do not die: the window opens without live reload.
                    crate::diag_warn!("watcher", "file watching is unavailable", {"err": err.to_string()});
                    #[cfg(debug_assertions)]
                    eprintln!("file watching is unavailable: {err}");
                    None
                }
            };
            *app.state::<WatcherState>().0.lock().expect("watcher lock") = watcher;

            // Compiled in at every level and inert unless the variable is set — the acceptance
            // hooks for the whole section (IMPL.md §13.11).
            if let Ok(kind) = std::env::var("MARKDOWNAURA_SELFTEST") {
                spawn_selftest(app.handle().clone(), kind);
            }
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
            commands::log_event,
            commands::set_log_level,
            commands::set_log_dir,
            commands::diag_status,
            commands::open_log_folder,
        ])
        .build(tauri::generate_context!())
        .expect("MarkdownAura failed to start")
        .run(|_app, event| match event {
            // `code` is `None` when the window's close button asked and `Some` when the exit was
            // programmatic (a relaunch), which is the one fact that separates the two in the log.
            tauri::RunEvent::ExitRequested { code, .. } => {
                crate::diag_info!("app", "exit requested", {"code": code});
                diag::mark_clean_exit();
            }
            tauri::RunEvent::Exit => diag::mark_clean_exit(),
            _ => {}
        });
}

/// `MARKDOWNAURA_SELFTEST=panic|abort|jserror`: 1500 ms after `setup` finishes it does exactly
/// that. The `selfcheck` line is written first so an intentional crash is never mistaken for a
/// real one. The delay lets the window paint and the front end connect, so `jserror` has somewhere
/// to throw.
fn spawn_selftest(app: tauri::AppHandle, kind: String) {
    let _ = std::thread::Builder::new()
        .name("markdownaura-selftest".to_string())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            crate::diag_info!("selfcheck", "MARKDOWNAURA_SELFTEST", {"kind": kind});
            match kind.as_str() {
                "panic" => panic!("MARKDOWNAURA_SELFTEST"),
                "abort" => std::process::abort(),
                "jserror" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("setTimeout(()=>{throw new Error('MARKDOWNAURA_SELFTEST')},1500)");
                    }
                }
                _ => {}
            }
        });
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
