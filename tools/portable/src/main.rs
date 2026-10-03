//! Single-file portable launcher (IMPL.md §8, §12).
//!
//! `MarkdownAura.exe` needs `WebView2Loader.dll` beside it — the exe imports it, and on this toolchain
//! that link cannot be made static (the loader's objects are MSVC-compiled; see IMPL.md §8). So the
//! portable edition is this launcher with both files compiled into it: it writes them into a per-version
//! directory under `%LOCALAPPDATA%\MarkdownAura\portable\`, then starts the app with the arguments it was
//! given. One file to hand someone, and the app it starts is byte-for-byte the one that shipped.
//!
//! Why `include_bytes!` rather than appending the payload to the launcher and parsing offsets at runtime:
//! there is no custom container format to get wrong, and the payload cannot drift from the launcher —
//! `tools/make-portable.mjs` sets the three environment variables below from what the build produced, so
//! a launcher built against a stale payload is impossible.
//!
//! Nothing is written outside that directory, and a launch whose files are already unpacked only reads
//! them to confirm they match.
#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const APP: &[u8] = include_bytes!(env!("MARKDOWNAURA_PORTABLE_APP"));
const LOADER: &[u8] = include_bytes!(env!("MARKDOWNAURA_PORTABLE_LOADER"));
const VERSION: &str = env!("MARKDOWNAURA_PORTABLE_VERSION");

fn main() {
    if let Err(err) = run() {
        fatal(&err);
    }
}

fn run() -> Result<(), String> {
    let dir = unpack_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let app = dir.join("markdownaura.exe");
    let loader = dir.join("WebView2Loader.dll");
    write_if_changed(&app, APP)?;
    write_if_changed(&loader, LOADER)?;

    // Everything after the launcher's own name is the app's: a file to open, a folder, a switch.
    let args: Vec<String> = env::args().skip(1).collect();
    Command::new(&app)
        .args(&args)
        .spawn()
        .map_err(|e| format!("starting {}: {e}", app.display()))?;
    Ok(())
}

/// Per version, so two editions can coexist and an older unpack is never overwritten mid-launch.
fn unpack_dir() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not set, so there is nowhere to unpack to".to_string())?;
    Ok(base.join("MarkdownAura").join("portable").join(VERSION))
}

/// Writes the file only when its contents differ. The comparison is a full read, deliberately: a size
/// check alone would keep a stale copy when two builds happen to be the same length, which is exactly
/// what a rebuilt-but-unbumped version looks like.
fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Ok(existing) = fs::read(path) {
        if existing == bytes {
            return Ok(());
        }
    }
    fs::write(path, bytes).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// A GUI binary has no console, so a failure has to be a message box — otherwise the window simply never
/// appears and nothing explains why.
fn fatal(message: &str) -> ! {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    const MB_ICONERROR: u32 = 0x10;

    let text = wide(&format!("MarkdownAura could not start.\n\n{message}"));
    let caption = wide("MarkdownAura");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_ICONERROR);
    }
    std::process::exit(1);
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
