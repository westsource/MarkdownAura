//! Engine availability for the status bar's three dots (SPEC §3, IMPL.md §7).
//!
//! **All three engines ship in the frontend bundle**: mermaid and graphviz as npm packages, d2 as the
//! browser build of `@d2lang/d2` (11.5 MB with its wasm inlined). So `installed` is `true` for all
//! three, there is no install step, and nothing in the app touches the network — the settings panel is
//! reporting a fixed bundle cost, not a download.
//!
//! The sizes below are the measured numbers from SPEC §4, not estimates; they are what the settings
//! panel totals with.

use serde::Serialize;

pub const MERMAID_ID: &str = "mermaid";
pub const DOT_ID: &str = "dot";
pub const D2_ID: &str = "d2";

/// Measured (SPEC §4), in bytes: ESM entry + the code-split chunks mermaid pulls on demand.
const MERMAID_BYTES: u64 = 29 * 1024 + 5_180_000;
const DOT_BYTES: u64 = 940 * 1024;
/// `@d2lang/d2/dist/browser/index.js` — the one file the frontend imports for d2, measured. Its wasm
/// is inlined in that file, which is why there is no second artifact to ship or fetch.
const D2_BYTES: u64 = 11_514_165;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub version: String,
    /// Always `true` today: all three engines are in the frontend bundle. Kept because it is the
    /// invariant the settings panel and the dots report, and a future native engine would falsify it.
    pub installed: bool,
    pub bytes: u64,
}

pub fn status() -> Vec<EngineInfo> {
    vec![
        EngineInfo {
            id: MERMAID_ID.into(),
            version: "12".into(),
            installed: true,
            bytes: MERMAID_BYTES,
        },
        EngineInfo {
            id: DOT_ID.into(),
            version: "1.29".into(),
            installed: true,
            bytes: DOT_BYTES,
        },
        EngineInfo {
            id: D2_ID.into(),
            version: "0.1.34".into(),
            installed: true,
            bytes: D2_BYTES,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_engine_ships_in_the_bundle() {
        let all = status();
        assert_eq!(all.len(), 3);
        assert!(
            all.iter().all(|e| e.installed),
            "no engine is an opt-in install any more — d2 is bundled like the other two"
        );
    }

    #[test]
    fn d2_reports_the_version_that_is_pinned() {
        let d2 = status().into_iter().find(|e| e.id == D2_ID).expect("a d2 row");
        assert_eq!(d2.version, "0.1.34");
        assert_eq!(d2.bytes, D2_BYTES);
    }
}
