//! A no-op C preprocessor, installed under the name `gcc` because that is the literal name GNU
//! windres looks for when it preprocesses a `.rc` file.
//!
//! Why this exists: this machine has no C compiler at all. The Rust GNU toolchain's bundled
//! `x86_64-w64-mingw32-gcc.exe` is a linker-only shim (its own GCC-WARNING.txt says so, and it
//! fails with `cannot execute 'cc1'`), and there is no system cpp/gcc/clang. windres therefore
//! cannot preprocess, and `tauri-winres` panics with `windres: preprocessing failed`, which stops
//! the whole Tauri build before our code is compiled.
//!
//! Why a passthrough is *correct* here rather than a hack that happens to work: the resource
//! script `tauri-winres` generates contains no `#include`, no `#define`, and no macros — only
//! `#pragma code_page(...)`, which is a windres directive rather than a C one, and which windres
//! handles after preprocessing. So the preprocessor's job on this input is to copy bytes, and
//! that is exactly what this does. It does not pretend to evaluate anything.
//!
//! Build (no cargo project needed):
//!
//!     rustc -O tools/rc-preprocessor.rs -o "$HOME/.cargo/bin/gcc.exe"
//!
//! **Remove `~/.cargo/bin/gcc.exe` before installing a real C toolchain.** A fake `gcc` earlier
//! on PATH than a real one will silently break C builds, and the failure will look like anything
//! but "there is a stub named gcc on your PATH".

use std::io::{self, Read, Write};
use std::path::Path;

fn main() {
    // windres invokes `<preprocessor> <flags...> <input.rc>` and reads stdout. The flags mean
    // nothing to us; the input is the last argument that names a file that actually exists.
    let input = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).is_file())
        .last();

    let text = match input {
        Some(path) => std::fs::read_to_string(&path).unwrap_or_default(),
        // Under --use-temp-file windres pipes the source in instead of naming it.
        None => {
            let mut buffer = String::new();
            let _ = io::stdin().read_to_string(&mut buffer);
            buffer
        }
    };

    let mut out = io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}
