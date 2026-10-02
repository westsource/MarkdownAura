//! Filesystem reads and the one-level tree walk (IMPL.md §3).
//!
//! Two things here are deliberate and easy to get wrong:
//!
//! * An unreadable or non-UTF-8 file must never blank the window. Decoding is lossy and the
//!   caller is told it happened (`FilePayload.encoding`), so the status bar can badge it.
//! * Huge files are truncated at the head rather than refused, and `truncated` is reported.
//!   Refusing would make "open a big log by accident" feel like a crash.

use std::path::Path;

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
}

/// Directories the watcher and the tree both skip. Lives in Rust so the counter and the tree
/// can never disagree about what is being watched (IMPL.md §3).
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
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

    // CRLF wins if it appears at all; a file that mixes endings still renders with one eol.
    let eol = if text.contains("\r\n") { "crlf" } else { "lf" };

    Ok(FilePayload {
        text,
        encoding: encoding.to_string(),
        eol: eol.to_string(),
        bytes: bytes_len,
        mtime_ms: mtime_ms(&meta),
        truncated,
    })
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
}
