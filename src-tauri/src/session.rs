//! Session persistence (IMPL.md §6).
//!
//! Three rules here are the difference between "restores my tabs" and "ate my tabs":
//!
//! * The write is atomic — temp file, then rename. A crash mid-write must never cost the
//!   previous session.
//! * An unknown `version` means "start clean", never "migrate and hope".
//! * A path that no longer exists is still restored. The frontend turns it into a `missing`
//!   tab; dropping it silently is how people lose work they had open.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, Result};

pub const SESSION_VERSION: u32 = 1;

/// Mirrors the frontend's caps: the in-memory list and the on-disk list must be the same size
/// or tabs vanish on restart for no visible reason.
pub const RECENT_CAP: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub w: f64,
    pub h: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidebarState {
    pub open: bool,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FindState {
    pub q: String,
    #[serde(rename = "case")]
    pub case_sensitive: bool,
    pub hit: usize,
}

impl Default for FindState {
    fn default() -> Self {
        Self {
            q: String::new(),
            case_sensitive: false,
            hit: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub file: String,
    pub view: String,
    pub scroll: f64,
    pub preview: bool,
    #[serde(default)]
    pub find: FindState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    pub window: WindowRect,
    pub theme: String,
    pub zoom: f64,
    /// Reading size in px, written to the `--doc-size` token. Kept separate from `zoom`, which
    /// is the status bar's multiplier; the two multiply in prose.css and neither overrides the
    /// other (SPEC §3).
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default)]
    pub reduce_motion: bool,
    /// UI language: `system`, `en` or `zh-CN` (SPEC §10). Defaulted so session files written
    /// before i18n existed still load; the frontend resolves `system` itself.
    #[serde(default = "default_lang")]
    pub lang: String,
    /// Reading-width preset name (`narrow`/`comfortable`/`wide`/`xwide`/`full`, SPEC §8). Stored by
    /// name so the preset table in `src/measure.ts` stays the single definition; the frontend
    /// sanitises an unknown value.
    #[serde(default = "default_measure")]
    pub measure: String,
    pub sidebar: SidebarState,
    pub outline_open: bool,
    /// Outline width in px (SPEC §3), written to `--w-outline`.
    #[serde(default = "default_outline_width")]
    pub outline_width: f64,
    /// Explorer shows markdown files only (SPEC §3). Carried here only so a round trip through this
    /// struct does not drop it — the rule itself lives in `src/ipc.ts`, and the tree applies it.
    #[serde(default = "default_md_only")]
    pub md_only: bool,
    pub active_tab: usize,
    pub tabs: Vec<TabState>,
    pub recent: Vec<String>,
}

fn default_font_size() -> f64 {
    15.0
}

fn default_lang() -> String {
    "system".into()
}

fn default_measure() -> String {
    "comfortable".into()
}

fn default_outline_width() -> f64 {
    200.0
}

/// The explorer's markdown-only toggle ships **on** (SPEC §3): a folder of images should not bury the
/// documents. Defaulted so a session written before the toggle existed opens like a fresh one.
fn default_md_only() -> bool {
    true
}

impl Default for Session {
    fn default() -> Self {
        Self {
            version: SESSION_VERSION,
            window: WindowRect {
                w: 1200.0,
                h: 800.0,
                x: None,
                y: None,
                maximized: false,
            },
            theme: "system".into(),
            zoom: 100.0,
            font_size: default_font_size(),
            reduce_motion: false,
            lang: default_lang(),
            measure: default_measure(),
            sidebar: SidebarState {
                open: true,
                width: 224.0,
            },
            outline_open: true,
            outline_width: default_outline_width(),
            md_only: default_md_only(),
            active_tab: 0,
            tabs: Vec::new(),
            recent: Vec::new(),
        }
    }
}

/// `%APPDATA%/MarkdownAura` on Windows, `~/.config/markdownaura` elsewhere.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("MarkdownAura")
}

pub fn session_path() -> PathBuf {
    data_dir().join("session.json")
}

/// `Ok(None)` means "nothing to restore" — missing, unreadable, or a version we do not know.
/// None of those are errors: none of them should stop the app from starting.
pub fn load_from(path: &Path) -> Option<Session> {
    let text = std::fs::read_to_string(path).ok()?;
    let session: Session = serde_json::from_str(&text).ok()?;
    if session.version != SESSION_VERSION {
        return None;
    }
    Some(session)
}

pub fn load() -> Option<Session> {
    load_from(&session_path())
}

pub fn save_to(path: &Path, session: &Session) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ApiError::io(parent, e))?;
    }

    let body = serde_json::to_vec_pretty(session).map_err(|e| ApiError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;

    // Temp file in the same directory (same volume), then an atomic replace. Writing straight
    // over the real file leaves a truncated session behind if we die mid-write.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| ApiError::io(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| ApiError::io(path, e))?;
    Ok(())
}

pub fn save(session: &Session) -> Result<()> {
    save_to(&session_path(), session)
}

/// Keeps `recent` bounded and most-recent-first, de-duplicated. Called on both sides of the
/// boundary so the caps cannot drift apart.
pub fn push_recent(recent: &mut Vec<String>, entry: &str) {
    recent.retain(|e| !e.eq_ignore_ascii_case(entry));
    recent.insert(0, entry.to_string());
    recent.truncate(RECENT_CAP);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("markdownaura-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("session.json")
    }

    #[test]
    fn round_trips() {
        let path = tmp("roundtrip");
        let mut session = Session::default();
        session.theme = "dark".into();
        // Away from the default, so a field the round trip quietly drops fails this test. `true` would
        // compare equal to the default and hide exactly that bug.
        session.md_only = false;
        session.tabs.push(TabState {
            file: "E:\\notes\\README.md".into(),
            view: "split".into(),
            scroll: 420.0,
            preview: false,
            find: FindState::default(),
        });

        save_to(&path, &session).unwrap();
        let back = load_from(&path).expect("session should load");
        assert_eq!(back, session);
    }

    /// The toggle's shipped default is *on* and the field is optional, so a session written before it
    /// existed must not come back listing every file. A bare `#[serde(default)]` would flip that
    /// silently (a missing `bool` is `false`), which is why the default is a named function.
    #[test]
    fn a_session_without_the_toggle_opens_with_it_on() {
        let path = tmp("mdonly-default");
        let mut session = Session::default();
        session.md_only = false;
        save_to(&path, &session).unwrap();

        // Remove the field, the way a session file written before the toggle existed would not have it.
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(
            value.as_object_mut().unwrap().remove("mdOnly").is_some(),
            "the saved session should have carried mdOnly at all"
        );
        std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();

        let back = load_from(&path).expect("session should load");
        assert!(back.md_only, "a session from before the toggle must open in markdown-only mode");
    }

    #[test]
    fn unknown_version_starts_clean_instead_of_migrating() {
        let path = tmp("version");
        let mut session = Session::default();
        session.version = SESSION_VERSION + 1;
        save_to(&path, &session).unwrap();
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn corrupt_file_is_not_fatal() {
        let path = tmp("corrupt");
        std::fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn missing_file_is_not_fatal() {
        let path = tmp("missing").join("nope.json");
        assert!(load_from(&path).is_none());
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let path = tmp("atomic");
        save_to(&path, &Session::default()).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn recent_is_capped_deduplicated_and_most_recent_first() {
        let mut recent = Vec::new();
        for i in 0..(RECENT_CAP + 5) {
            push_recent(&mut recent, &format!("p{i}"));
        }
        assert_eq!(recent.len(), RECENT_CAP);
        assert_eq!(recent[0], format!("p{}", RECENT_CAP + 4));

        push_recent(&mut recent, "p5");
        assert_eq!(recent[0], "p5");
        assert_eq!(recent.iter().filter(|e| *e == "p5").count(), 1);
    }
}
