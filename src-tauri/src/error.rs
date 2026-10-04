//! The one error type that crosses the IPC boundary.
//!
//! It is a tagged enum rather than a string on purpose (IMPL.md §3): the UI has to tell "the
//! file was deleted" (silent — the tab goes `missing`) apart from "permission denied" (a toast)
//! apart from "this is not UTF-8" (render lossily and badge the status bar). A `String` would
//! collapse all three into something the frontend can only display.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiError {
    #[error("not found: {path}")]
    NotFound { path: String },

    #[error("permission denied: {path}")]
    Denied { path: String },

    #[error("io error on {path}: {message}")]
    Io { path: String, message: String },

    #[error("not a text file: {path}")]
    NotText { path: String },

    /// The file changed on disk since the caller loaded it, so the write was refused rather than
    /// allowed to overwrite content it never saw (SPEC §12: an external change wins).
    #[error("the file changed on disk: {path}")]
    Conflict { path: String },

    /// A write that would corrupt the file: a mixed-ending document, a lossy decode, an encoding
    /// this build cannot produce. Refusing is the whole point — the reader only *badges* these.
    #[error("refused to write {path}: {reason}")]
    Refused { path: String, reason: String },
}

impl ApiError {
    /// Map a `std::io::Error` from an operation on `path` onto the variant the UI needs.
    pub fn io(path: &Path, err: std::io::Error) -> Self {
        let path = path.display().to_string();
        match err.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound { path },
            std::io::ErrorKind::PermissionDenied => ApiError::Denied { path },
            _ => ApiError::Io {
                path,
                message: err.to_string(),
            },
        }
    }

    pub fn io_plain(path: &Path, kind: std::io::ErrorKind, message: impl Into<String>) -> Self {
        let path = path.display().to_string();
        match kind {
            std::io::ErrorKind::NotFound => ApiError::NotFound { path },
            std::io::ErrorKind::PermissionDenied => ApiError::Denied { path },
            _ => ApiError::Io {
                path,
                message: message.into(),
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;
