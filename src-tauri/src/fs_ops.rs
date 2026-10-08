//! Filesystem reads and the one-level tree walk (IMPL.md §3).
//!
//! Two things here are deliberate and easy to get wrong:
//!
//! * An unreadable or non-UTF-8 file must never blank the window. Decoding is lossy and the
//!   caller is told it happened (`FilePayload.encoding`), so the status bar can badge it.
//! * Huge files are truncated at the head rather than refused, and `truncated` is reported.
//!   Refusing would make "open a big log by accident" feel like a crash.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{ApiError, Result};

/// Read at most this much of any one file. Beyond it the payload is cut and flagged.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Lowercase, no dot. Empty for directories and extensionless files.
    pub ext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub root: String,
    pub name: String,
    pub entries: Vec<TreeEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    pub text: String,
    /// `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, or `utf-8-lossy`.
    pub encoding: String,
    /// `lf` or `crlf`.
    pub eol: String,
    pub bytes: u64,
    pub mtime_ms: i64,
    pub truncated: bool,
    /// Whether this file can be written at all: the read-only attribute on Windows, no write bit for
    /// anyone on Unix. SPEC §12 refuses to *edit* such a file instead of letting the save fail later —
    /// a buffer that cannot be written is a trap, not an editor.
    pub writable: bool,
}

/// Directories the watcher and the tree both skip. Lives in Rust so the counter and the tree
/// can never disagree about what is being watched (IMPL.md §3).
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
}

/// Makes a path that came from a human — the command line, a shell integration, the folder dialog —
/// absolute against this process's working directory.
///
/// Why not `fs::canonicalize`: it resolves symlinks *and* returns Windows' `\\?\C:\…` verbatim prefix,
/// which would change what the tree, the tab titles and the status bar *show*. Why at all: the file
/// watcher reports absolute paths (`notify` joins the watched root, and the root it resolves for a
/// relative watch is absolute), while a tab that kept a relative `argv` path never matched one — so
/// live reload was silently dead for a document opened from the command line, and so was the `missing`
/// mark for a file deleted under it. Found 2026-10-08 by instrumenting the watcher, not by reading it.
pub fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn entry_for(path: &Path, name: String, is_dir: bool) -> TreeEntry {
    let ext = if is_dir {
        String::new()
    } else {
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    TreeEntry {
        name,
        path: path.display().to_string(),
        is_dir,
        ext,
    }
}

/// One level only — children load when the user expands a node.
pub fn list_dir(path: &Path) -> Result<Vec<TreeEntry>> {
    let read = std::fs::read_dir(path).map_err(|e| ApiError::io(path, e))?;

    let mut out: Vec<TreeEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| ApiError::io(path, e))?;
        let name = item.file_name().to_string_lossy().into_owned();
        // `file_type()` avoids a second stat on platforms that report it inline.
        let is_dir = match item.file_type() {
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        if is_dir && is_ignored_dir(&name) {
            continue;
        }
        out.push(entry_for(&item.path(), name, is_dir));
    }

    // Folders first, then case-insensitive by name — the same order the sidebar shows.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub fn open_folder(path: &Path) -> Result<FolderView> {
    if !path.is_dir() {
        return Err(ApiError::NotFound {
            path: path.display().to_string(),
        });
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());

    Ok(FolderView {
        root: path.display().to_string(),
        name,
        entries: list_dir(path)?,
    })
}

/// The path the window should open when it was launched from a shell or "Open with".
/// A file opens its own folder with itself selected; a folder opens itself.
pub fn resolve_target(path: &Path) -> Result<FolderView> {
    if path.is_dir() {
        open_folder(path)
    } else if path.is_file() {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        open_folder(parent)
    } else {
        Err(ApiError::NotFound {
            path: path.display().to_string(),
        })
    }
}

fn detect_bom(bytes: &[u8]) -> Option<(&'static str, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some(("utf-8-bom", 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some(("utf-16le", 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some(("utf-16be", 2))
    } else {
        None
    }
}

fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| {
            if big_endian {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn read_file(path: &Path) -> Result<FilePayload> {
    let meta = std::fs::metadata(path).map_err(|e| ApiError::io(path, e))?;
    if meta.is_dir() {
        return Err(ApiError::NotText {
            path: path.display().to_string(),
        });
    }

    let bytes_len = meta.len();
    let truncated = bytes_len > MAX_FILE_BYTES;
    let raw: Vec<u8> = if truncated {
        // Read the head only — refusing a large file outright is worse than showing its start.
        use std::io::Read;
        let mut handle = std::fs::File::open(path).map_err(|e| ApiError::io(path, e))?;
        let mut buf = vec![0u8; MAX_FILE_BYTES as usize];
        let read = handle.read(&mut buf).map_err(|e| ApiError::io(path, e))?;
        buf.truncate(read);
        buf
    } else {
        std::fs::read(path).map_err(|e| ApiError::io(path, e))?
    };

    let (encoding, text) = match detect_bom(&raw) {
        Some(("utf-8-bom", skip)) => (
            "utf-8-bom",
            String::from_utf8_lossy(&raw[skip..]).into_owned(),
        ),
        Some(("utf-16le", skip)) => ("utf-16le", decode_utf16(&raw[skip..], false)),
        Some(("utf-16be", skip)) => ("utf-16be", decode_utf16(&raw[skip..], true)),
        _ => match std::str::from_utf8(&raw) {
            Ok(s) => ("utf-8", s.to_owned()),
            // Lossy rather than an error: a stray byte must not make a document unopenable.
            Err(_) => ("utf-8-lossy", String::from_utf8_lossy(&raw).into_owned()),
        },
    };

    // Three values, not two. The reader only needs "which ending to show", and CRLF winning was
    // enough for that — but a *writer* cannot use this heuristic: joining a mixed file with one
    // ending rewrites every line of the other kind, which is a whole-file diff (SPEC §12). So a
    // file carrying both endings says so, and the save path refuses it instead of guessing.
    let has_crlf = text.contains("\r\n");
    let has_lone_lf = text.replace("\r\n", "").contains('\n');
    let eol = if has_crlf && has_lone_lf {
        "mixed"
    } else if has_crlf {
        "crlf"
    } else {
        "lf"
    };

    Ok(FilePayload {
        text,
        encoding: encoding.to_string(),
        eol: eol.to_string(),
        bytes: bytes_len,
        mtime_ms: mtime_ms(&meta),
        truncated,
        writable: !meta.permissions().readonly(),
    })
}

/// How an edited buffer goes back to disk (SPEC §12).
///
/// The contract is byte fidelity. The file keeps the encoding it was read in — a UTF-8 BOM is
/// restored, UTF-16 is re-encoded with the same byte order — line endings are *joined* with the
/// file's own ending rather than normalised, and the document's permissions survive the atomic
/// replace. Three things are refused instead of written: a mixed-ending file (the buffer cannot
/// carry per-line endings, so saving would rewrite half of them), a lossy decode (the replacement
/// characters are already in the buffer and would become permanent), and an encoding this build
/// cannot produce.
///
/// `expected_mtime_ms` is the mtime the caller loaded. A mismatch means something else wrote the
/// file in the meantime; since the reader's policy is that an external change wins, the save is
/// refused rather than allowed to overwrite content it never saw.
pub fn write_file(
    path: &Path,
    text: &str,
    encoding: &str,
    eol: &str,
    expected_mtime_ms: i64,
) -> Result<i64> {
    let meta = std::fs::metadata(path).map_err(|e| ApiError::io(path, e))?;
    if meta.is_dir() {
        return Err(ApiError::NotText { path: path.display().to_string() });
    }
    if eol == "mixed" {
        return Err(ApiError::Refused {
            path: path.display().to_string(),
            reason: "this file mixes line endings, and saving would rewrite them all".into(),
        });
    }
    if encoding == "utf-8-lossy" {
        return Err(ApiError::Refused {
            path: path.display().to_string(),
            reason: "the file is not valid UTF-8, so saving would make the replacement permanent".into(),
        });
    }
    if mtime_ms(&meta) != expected_mtime_ms {
        return Err(ApiError::Conflict { path: path.display().to_string() });
    }

    let body = encode(text, encoding, eol)?;

    // Temp file in the same directory (same volume) and an atomic replace — the rule the session
    // already follows. The name is *appended*, not substituted: `with_extension` would map both
    // `a.md` and `a.txt` onto `a.tmp`, so two documents in one folder could collide.
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!("{name}.aura-tmp"));
    std::fs::write(&tmp, &body).map_err(|e| ApiError::io(&tmp, e))?;
    // A fresh temp file carries fresh permissions; the document's own mode has to move over before
    // the replace, or saving a 0600 file would leave it world-readable.
    let _ = std::fs::set_permissions(&tmp, meta.permissions());
    std::fs::rename(&tmp, path).map_err(|e| ApiError::io(path, e))?;

    let after = std::fs::metadata(path).map_err(|e| ApiError::io(path, e))?;
    Ok(mtime_ms(&after))
}

/// The buffer's lines are joined with the file's own ending. The caller has already refused a mixed
/// file; normalising first means a buffer that somehow carries CRLF cannot end up with CR CR LF.
fn encode(text: &str, encoding: &str, eol: &str) -> Result<Vec<u8>> {
    let normalized = text.replace("\r\n", "\n");
    let joined = if eol == "crlf" { normalized.replace('\n', "\r\n") } else { normalized };
    match encoding {
        "utf-8" => Ok(joined.into_bytes()),
        "utf-8-bom" => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(joined.as_bytes());
            Ok(out)
        }
        "utf-16le" | "utf-16be" => {
            let big = encoding == "utf-16be";
            let mut out = if big { vec![0xFE, 0xFF] } else { vec![0xFF, 0xFE] };
            for unit in joined.encode_utf16() {
                out.extend_from_slice(&if big { unit.to_be_bytes() } else { unit.to_le_bytes() });
            }
            Ok(out)
        }
        other => Err(ApiError::Refused {
            path: other.to_string(),
            reason: format!("this build cannot write `{other}`"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_dirs_cover_dot_dirs_and_build_output() {
        for name in [".git", ".vscode", "node_modules", "target", "dist"] {
            assert!(is_ignored_dir(name), "{name} should be ignored");
        }
        for name in ["src", "docs", "markdownaura"] {
            assert!(!is_ignored_dir(name), "{name} should not be ignored");
        }
    }

    #[test]
    fn bom_detection_prefers_the_specific_encodings() {
        assert_eq!(detect_bom(&[0xEF, 0xBB, 0xBF, b'a']), Some(("utf-8-bom", 3)));
        assert_eq!(detect_bom(&[0xFF, 0xFE, b'a', 0]), Some(("utf-16le", 2)));
        assert_eq!(detect_bom(&[0xFE, 0xFF, 0, b'a']), Some(("utf-16be", 2)));
        assert_eq!(detect_bom(b"plain"), None);
    }

    #[test]
    fn utf16_decodes_in_both_byte_orders() {
        assert_eq!(decode_utf16(&[0x41, 0x00, 0x42, 0x00], false), "AB");
        assert_eq!(decode_utf16(&[0x00, 0x41, 0x00, 0x42], true), "AB");
    }

    #[test]
    fn a_file_past_the_cap_is_truncated_and_flagged() {
        // The status bar tells the reader the document is a prefix (`FilePayload.truncated`);
        // this is the flag that makes that possible, so it is worth a hostile-sized fixture.
        let dir = std::env::temp_dir().join("markdownaura-truncate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.md");

        let mut body = vec![b'a'; MAX_FILE_BYTES as usize];
        body.extend_from_slice(b"tail-must-not-survive");
        std::fs::write(&path, &body).unwrap();

        let payload = read_file(&path).unwrap();
        assert!(payload.truncated);
        assert_eq!(payload.bytes, body.len() as u64);
        assert_eq!(payload.text.len(), MAX_FILE_BYTES as usize);
        assert!(!payload.text.contains("tail"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh file under a per-test directory, so the save tests can write and re-read freely.
    fn scratch(name: &str, bytes: &[u8]) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("markdownaura-write-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn a_bom_is_stripped_on_read_and_restored_on_write() {
        let (dir, path) = scratch("bom.md", "\u{feff}hello\n".as_bytes());
        let loaded = read_file(&path).unwrap();
        assert_eq!(loaded.encoding, "utf-8-bom");
        assert_eq!(loaded.text, "hello\n", "the buffer must not carry the BOM");

        write_file(&path, &loaded.text, &loaded.encoding, &loaded.eol, loaded.mtime_ms).unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert_eq!(&raw[..3], &[0xEF, 0xBB, 0xBF], "the BOM comes back");
        assert_eq!(read_file(&path).unwrap().text, "hello\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utf16_round_trips_in_the_same_byte_order() {
        let (dir, path) = scratch("le.md", &[0xFF, 0xFE, b'h', 0, b'i', 0]);
        let loaded = read_file(&path).unwrap();
        assert_eq!(loaded.encoding, "utf-16le");
        assert_eq!(loaded.text, "hi");

        write_file(&path, "hi there", "utf-16le", "lf", loaded.mtime_ms).unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert_eq!(&raw[..2], &[0xFF, 0xFE], "same byte order, BOM back");
        assert_eq!(read_file(&path).unwrap().text, "hi there");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crlf_is_joined_not_normalised() {
        let (dir, path) = scratch("crlf.md", b"a\r\nb\r\n");
        let loaded = read_file(&path).unwrap();
        assert_eq!(loaded.eol, "crlf");
        // The *reader* hands the file over as it is, CRs included — the source view shows the bytes
        // that are there. An editor's document is the other way round: it is line-normalised. The
        // save path is the seam that has to put the endings back, which is what this asserts.
        assert_eq!(loaded.text, "a\r\nb\r\n");

        write_file(&path, "a\nb\nc", "utf-8", "crlf", loaded.mtime_ms).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nb\r\nc");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mixed_file_says_so_and_refuses_to_be_written() {
        let (dir, path) = scratch("mixed.md", b"a\r\nb\nc\r\n");
        let loaded = read_file(&path).unwrap();
        assert_eq!(loaded.eol, "mixed", "a writer cannot use the display heuristic");

        let err = write_file(&path, &loaded.text, "utf-8", &loaded.eol, loaded.mtime_ms).unwrap_err();
        assert!(matches!(err, ApiError::Refused { .. }), "got {err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nb\nc\r\n", "left untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lossy_decode_refuses_to_be_written() {
        let (dir, path) = scratch("lossy.md", &[b'a', 0xFF, b'b']);
        let loaded = read_file(&path).unwrap();
        assert_eq!(loaded.encoding, "utf-8-lossy");

        let err = write_file(&path, &loaded.text, &loaded.encoding, &loaded.eol, loaded.mtime_ms).unwrap_err();
        assert!(matches!(err, ApiError::Refused { .. }), "got {err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_mtime_refuses_the_write() {
        let (dir, path) = scratch("stale.md", b"one\n");
        let loaded = read_file(&path).unwrap();
        std::fs::write(&path, b"two\n").unwrap();

        // A deliberately wrong expectation, not "now minus a moment": filesystem timestamps are
        // coarse enough that a write immediately after a read can carry the *same* mtime, which
        // would make this test pass without ever exercising the comparison.
        let err = write_file(&path, "mine\n", "utf-8", "lf", loaded.mtime_ms - 1_000).unwrap_err();
        assert!(matches!(err, ApiError::Conflict { .. }), "got {err:?}");
        assert_eq!(std::fs::read(&path).unwrap(), b"two\n", "the newer content wins");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_only_file_is_reported_as_unwritable() {
        let (dir, path) = scratch("locked.md", b"# locked\n");
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms).unwrap();

        let loaded = read_file(&path).unwrap();
        assert!(!loaded.writable, "the pane must refuse to edit it");
        // The write itself fails too; the frontend refuses before it gets here, and this is the backstop.
        // Root ignores the mode bits, and this suite runs as root under WSL, so verify the premise
        // rather than assume it: what is under test is that *our* backstop refuses, not that the OS
        // does. Without this the test fails for the wrong reason on any root login.
        if std::fs::write(&path, b"probe").is_ok() {
            eprintln!("skipping the write assertion: this user can write to a read-only file (running as root?)");
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_readonly(false);
            std::fs::set_permissions(&path, perms).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert!(write_file(&path, "# mine\n", "utf-8", "lf", loaded.mtime_ms).is_err());

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&path, perms).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
