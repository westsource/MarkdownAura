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
    // An update taken from inside the app installs through the NSIS installer, which lands in the per-user
    // install directory — not here. If that copy is *newer* than the one baked into this launcher, run it:
    // otherwise clicking this file again would silently start the version it shipped with, which is exactly
    // the bug this branch exists for. When the installed copy is the same version or older, the launcher
    // does what a portable build should and runs its own payload.
    if let Some(installed) = newer_installed_copy() {
        return spawn(&installed, &args_tail());
    }

    let dir = unpack_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let app = dir.join("markdownaura.exe");
    let loader = dir.join("WebView2Loader.dll");
    write_if_changed(&app, APP)?;
    write_if_changed(&loader, LOADER)?;
    spawn(&app, &args_tail())
}

/// Everything after the launcher's own name is the app's: a file to open, a folder, a switch.
fn args_tail() -> Vec<String> {
    env::args().skip(1).collect()
}

fn spawn(exe: &Path, args: &[String]) -> Result<(), String> {
    Command::new(exe)
        .args(args)
        .spawn()
        .map_err(|e| format!("starting {}: {e}", exe.display()))?;
    Ok(())
}

/// Per version, so two editions can coexist and an older unpack is never overwritten mid-launch.
fn unpack_dir() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "LOCALAPPDATA is not set, so there is nowhere to unpack to".to_string())?;
    Ok(base.join("MarkdownAura").join("portable").join(VERSION))
}

/// The per-user install the updater writes to, when it exists and is newer than this launcher's payload.
/// Compared through the PE version resource, which is the only place that answer lives reliably — file
/// name, size and timestamps all lie across builds.
fn newer_installed_copy() -> Option<PathBuf> {
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let installed = base.join("MarkdownAura").join("markdownaura.exe");
    if !installed.is_file() {
        return None;
    }
    let theirs = file_version(&installed)?;
    let ours = parse_version(VERSION)?;
    (theirs > ours).then_some(installed)
}

/// `0.1.1` (and anything with fewer than four parts) to the four `u16`s a `VS_FIXEDFILEINFO` carries.
fn parse_version(version: &str) -> Option<[u16; 4]> {
    let mut parts = [0u16; 4];
    for (index, part) in version.split('.').take(4).enumerate() {
        parts[index] = part.trim().parse().ok()?;
    }
    Some(parts)
}

const VS_FIXEDFILEINFO_SIGNATURE: u32 = 0xfeef04bd;

/// The four version words from a PE's version resource, or `None` when it has none.
fn file_version(path: &Path) -> Option<[u16; 4]> {
    // `version.dll` ships no import library with this MinGW toolchain — `#[link(name = "version")]` fails
    // with `ld: cannot find -lversion` — so its three functions are resolved from the DLL by hand. They are
    // stable Win32 API, and this keeps the launcher free of dependencies.
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut core::ffi::c_void;
        fn GetProcAddress(module: *mut core::ffi::c_void, name: *const u8) -> *mut core::ffi::c_void;
    }
    type SizeFn = unsafe extern "system" fn(*const u16, *mut u32) -> u32;
    type InfoFn = unsafe extern "system" fn(*const u16, u32, u32, *mut core::ffi::c_void) -> i32;
    type QueryFn = unsafe extern "system" fn(
        *const core::ffi::c_void,
        *const u16,
        *mut *mut core::ffi::c_void,
        *mut u32,
    ) -> i32;

    let module = unsafe { LoadLibraryW(wide("version.dll").as_ptr()) };
    if module.is_null() {
        return None;
    }
    let resolve = |name: &[u8]| unsafe { GetProcAddress(module, name.as_ptr()) };
    let (size_ptr, info_ptr, query_ptr) = (
        resolve(b"GetFileVersionInfoSizeW\0"),
        resolve(b"GetFileVersionInfoW\0"),
        resolve(b"VerQueryValueW\0"),
    );
    if size_ptr.is_null() || info_ptr.is_null() || query_ptr.is_null() {
        return None;
    }
    let (size_of, info_of, query) = unsafe {
        (
            std::mem::transmute::<*mut core::ffi::c_void, SizeFn>(size_ptr),
            std::mem::transmute::<*mut core::ffi::c_void, InfoFn>(info_ptr),
            std::mem::transmute::<*mut core::ffi::c_void, QueryFn>(query_ptr),
        )
    };

    let file = wide(&path.to_string_lossy());
    let mut handle = 0u32;
    let size = unsafe { size_of(file.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }
    // `u32` elements, not bytes: `VerQueryValueW` hands back a `VS_FIXEDFILEINFO`, and a byte buffer has no
    // alignment promise.
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe { info_of(file.as_ptr(), 0, size, buffer.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let mut info: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    let root = wide("\\");
    if unsafe { query(buffer.as_ptr().cast(), root.as_ptr(), &mut info, &mut len) } == 0 {
        return None;
    }
    if info.is_null() || len < 16 {
        return None;
    }
    let words = unsafe { std::slice::from_raw_parts(info as *const u32, 4) };
    if words[0] != VS_FIXEDFILEINFO_SIGNATURE {
        return None;
    }
    let (ms, ls) = (words[2], words[3]);
    Some([
        (ms >> 16) as u16,
        (ms & 0xffff) as u16,
        (ls >> 16) as u16,
        (ls & 0xffff) as u16,
    ])
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
