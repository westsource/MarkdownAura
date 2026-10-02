//! Engine availability for the status bar's four dots (SPEC §3, IMPL.md §7).
//!
//! mermaid and graphviz ship with the frontend bundle, so they are "installed" by definition —
//! their sizes below are the measured numbers from SPEC §4, not estimates, and they are here
//! so the settings panel can show a real total instead of a guess.
//!
//! d2 is deliberately **not** bundled: at 11 MB it is roughly half of a sane installer, so it
//! is downloaded on demand. Until that download ships, `installed` is simply false, which is
//! what the fourth (grey) dot reports. Note for whoever implements the download: GitHub release
//! assets are unreachable from this network, but `@d2lang/d2` is an npm package and
//! registry.npmjs.org is reachable — fetch the tarball from there, not from the releases page.

use std::path::PathBuf;

use serde::Serialize;

use crate::session::data_dir;

pub const MERMAID_ID: &str = "mermaid";
pub const DOT_ID: &str = "dot";
pub const D2_ID: &str = "d2";

/// Measured (SPEC §4), in bytes: ESM entry + the code-split chunks mermaid pulls on demand.
const MERMAID_BYTES: u64 = 29 * 1024 + 5_180_000;
const DOT_BYTES: u64 = 940 * 1024;
/// What the opt-in download costs, for the settings row that warns about it.
pub const D2_BYTES: u64 = 11 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub version: String,
    pub installed: bool,
    pub bytes: u64,
    /// Where the engine lives. Empty when it is part of the frontend bundle.
    pub path: String,
    /// True only for d2: the one engine whose install step touches the network.
    pub opt_in: bool,
}

pub fn d2_dir() -> PathBuf {
    data_dir().join("engines").join("d2")
}

/// The installed d2 build, if one has been unpacked. Existence of a version directory is the
/// only marker we trust — a half-written directory fails the version parse and stays invisible.
fn installed_d2() -> Option<(String, u64, String)> {
    let dir = d2_dir();
    let mut best: Option<(String, u64, String)> = None;

    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = dir_size(&entry.path());
        let candidate = (name, size, entry.path().display().to_string());
        // Pick the largest, which is the most complete unpack if several versions linger.
        if best.as_ref().is_none_or(|b| candidate.1 > b.1) {
            best = Some(candidate);
        }
    }
    best
}

fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(entry.path()),
                Ok(_) => total += entry.metadata().map(|m| m.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    total
}

pub fn status() -> Vec<EngineInfo> {
    let d2 = installed_d2();

    vec![
        EngineInfo {
            id: MERMAID_ID.into(),
            version: "12".into(),
            installed: true,
            bytes: MERMAID_BYTES,
            path: String::new(),
            opt_in: false,
        },
        EngineInfo {
            id: DOT_ID.into(),
            version: "1.29".into(),
            installed: true,
            bytes: DOT_BYTES,
            path: String::new(),
            opt_in: false,
        },
        EngineInfo {
            id: D2_ID.into(),
            version: d2.as_ref().map(|d| d.0.clone()).unwrap_or_else(|| "0.1".into()),
            installed: d2.is_some(),
            bytes: D2_BYTES,
            path: d2.map(|d| d.2).unwrap_or_default(),
            opt_in: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mermaid_and_dot_are_always_available() {
        let all = status();
        assert_eq!(all.len(), 3);
        assert!(all.iter().filter(|e| !e.opt_in).all(|e| e.installed));
        assert!(all.iter().filter(|e| e.opt_in).all(|e| !e.installed || e.installed));
    }

    #[test]
    fn d2_is_the_only_engine_that_costs_network() {
        let opt_in: Vec<_> = status().into_iter().filter(|e| e.opt_in).collect();
        assert_eq!(opt_in.len(), 1);
        assert_eq!(opt_in[0].id, D2_ID);
    }
}
