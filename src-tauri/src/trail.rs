//! The reading trail (SPEC §6, §7): what was opened, and where the reader stopped.
//!
//! Four rules, each of which is a bug this file exists to not have:
//!
//! * **Its own file, next to `session.json`, never inside it.** That file is rewritten on a 500 ms
//!   debounce and an unknown `version` there means "start clean, do not migrate" (`session.rs`). An
//!   append-only list with a 90-day window in the same document would both grow every state write and
//!   make that rule dangerous — a trail schema change would look like a session schema change.
//! * **The write is atomic** (temp file, then rename), for the same reason the session's is: a crash
//!   mid-write must not cost the list.
//! * **A path that is gone stays in the list.** The reader sees it struck through and decides; dropping
//!   it silently is the one thing a history must not do (`session.rs` restores missing tabs for the
//!   same reason).
//! * **Bounded on both axes**: `TRAIL_CAP` entries and `TRAIL_DAYS` of them. "Remember what I read" with
//!   no ceiling is a disk leak that only shows up a year later, and the reader has no way to audit it.
//!
//! What the list is *for* is the second half: a `lastRead` position (the heading's text plus a fraction
//! of the document) so opening a file resumes where it stopped. The heading is stored as **text**, never
//! as an id — ids are assigned per render (`markdown.rs`), so an id kept here points at nothing after
//! the next render, which is why `Tab.outlineHit` is a string too (SPEC §5).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, Result};
use crate::fs_ops;

pub const TRAIL_VERSION: u32 = 1;

/// The ceiling and the window. Both are the owner's call (2026-10-14): 100 entries, 90 days. They are
/// mirrored in the frontend's copy of the list, so the two cannot drift into showing different sizes.
pub const TRAIL_CAP: usize = 100;
pub const TRAIL_DAYS: u64 = 90;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Where the reader stopped: the heading they were under, and how far down the document that was.
///
/// The percentage is the fallback, not the primary: it survives a document whose headings were renamed,
/// and it is the only thing that means anything for a file that has no headings at all.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadPos {
    pub heading: String,
    pub pct: f64,
    /// When this position was taken. Part of the entry's *touch* — see `touch_of` — so a document you
    /// read today is not pruned as old just because it was first opened in March.
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    /// `"file"` or `"folder"`. A folder is recorded because the empty state and the app menu list both,
    /// and the sheet says which is which; it never carries a position.
    pub kind: String,
    pub opened_at: u64,
    /// How many times it was opened, from 1. Not shown anywhere yet — it is what a future sort ("most
    /// read") or a de-clutter rule would need, and it costs one integer to keep.
    #[serde(default)]
    pub opens: u32,
    /// `None` for a folder, and for a file that was opened but never scrolled.
    #[serde(default)]
    pub last_read: Option<ReadPos>,
}

/// What the commands hand the UI: a stored entry plus the one fact that is about the **disk** rather
/// than about the trail, so the sheet can strike a row through instead of letting the click fail.
///
/// It is a separate type on purpose. The first version put `missing` on `Entry` with `serde(skip)` —
/// which keeps it out of the file *and out of the serialized response*, so the UI silently received
/// `undefined` and drew a file that is gone as if it were there. Found by driving the built app; the
/// fix is to make "the file never stores a derived fact" a type-level fact instead of an accident of
/// which serde attribute was used.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    #[serde(flatten)]
    pub entry: Entry,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trail {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

impl Default for Trail {
    fn default() -> Self {
        Self {
            version: TRAIL_VERSION,
            entries: Vec::new(),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

pub fn trail_path() -> PathBuf {
    crate::session::data_dir().join("reading-trail.json")
}

/// The last time this entry was *touched*: read, or opened. Grouping, sorting and the window all measure
/// from here rather than from `opened_at`, or a document opened once in March and read this morning would
/// be filed under March and pruned as old while it is the freshest thing in the list.
fn touch_of(entry: &Entry) -> u64 {
    entry.last_read.as_ref().map(|p| p.at).unwrap_or(0).max(entry.opened_at)
}

/// Normalises the stored paths and drops what is left of the window.
///
/// Resolution on read mirrors `session.rs`'s rule: a path is stored as the reader's identity for the
/// entry, and a relative one would never match the absolute path the open announces (so the same document
/// would appear twice). `Ok(None)`-style tolerance: a trail that cannot be read is an empty trail, never
/// an error — nothing here is worth stopping a launch over.
pub fn load_from(path: &Path) -> Trail {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Trail::default();
    };
    let Ok(mut trail) = serde_json::from_str::<Trail>(&text) else {
        return Trail::default();
    };
    if trail.version != TRAIL_VERSION {
        return Trail::default();
    }
    for entry in &mut trail.entries {
        entry.path = fs_ops::absolute(Path::new(&entry.path)).display().to_string();
    }
    prune(&mut trail, now_ms());
    trail
}

pub fn load() -> Trail {
    load_from(&trail_path())
}

pub fn save_to(path: &Path, trail: &Trail) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ApiError::io(parent, e))?;
    }
    let body = serde_json::to_vec_pretty(trail).map_err(|e| ApiError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;
    // Same directory (same volume), then an atomic replace — see the header.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| ApiError::io(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| ApiError::io(path, e))?;
    Ok(())
}

pub fn save(trail: &Trail) -> Result<()> {
    save_to(&trail_path(), trail)
}

/// Drops entries older than the window, measured by `touch_of`. Called on load and before every write, so
/// neither the file nor the list can outlive the contract.
pub fn prune(trail: &mut Trail, now: u64) {
    let floor = now.saturating_sub(TRAIL_DAYS * DAY_MS);
    trail.entries.retain(|e| touch_of(e) >= floor);
}

/// Records an open: most recent first, de-duplicated case-insensitively, capped. Called on both sides of
/// the boundary — like `session::push_recent` — so the cap cannot drift between the list the UI holds and
/// the list on disk.
pub fn note(trail: &mut Trail, path: &str, kind: &str, now: u64) {
    let normalized = fs_ops::absolute(Path::new(path)).display().to_string();
    let opens = trail
        .entries
        .iter()
        .find(|e| e.path.eq_ignore_ascii_case(&normalized))
        .map(|e| e.opens)
        .unwrap_or(0);
    let last_read = trail
        .entries
        .iter()
        .find(|e| e.path.eq_ignore_ascii_case(&normalized))
        .and_then(|e| e.last_read.clone());
    trail.entries.retain(|e| !e.path.eq_ignore_ascii_case(&normalized));
    trail.entries.insert(
        0,
        Entry {
            path: normalized,
            kind: kind.to_string(),
            opened_at: now,
            opens: opens.saturating_add(1),
            // A file opened again keeps where it stopped — otherwise opening a document in the tree
            // would throw away the position the reader came back for.
            last_read,
        },
    );
    trail.entries.truncate(TRAIL_CAP);
    prune(trail, now);
}

/// Moves the position of an entry that is already in the list.
///
/// An unknown path is **ignored, not inserted**: a position is not an open. Creating an entry here would
/// let a stale tab (one whose open was never noted, e.g. restored from a session written before this
/// feature existed) insert itself into the trail as if the reader had just opened it.
pub fn set_position(trail: &mut Trail, path: &str, heading: &str, pct: f64, now: u64) {
    let normalized = fs_ops::absolute(Path::new(path)).display().to_string();
    let Some(entry) = trail
        .entries
        .iter_mut()
        .find(|e| e.path.eq_ignore_ascii_case(&normalized))
    else {
        return;
    };
    entry.last_read = Some(ReadPos {
        heading: heading.to_string(),
        pct: pct.clamp(0.0, 1.0),
        at: now,
    });
    prune(trail, now);
}

pub fn clear(trail: &mut Trail) {
    trail.entries.clear();
}

/// The list the UI is about to show: one `stat` per entry, on the blocking pool with the rest of the
/// command. A hundred of them is nothing next to the round trip, and the alternative is a row that looks
/// alive until it is clicked.
pub fn views(trail: &Trail) -> Vec<EntryView> {
    trail
        .entries
        .iter()
        .map(|entry| EntryView {
            missing: !Path::new(&entry.path).exists(),
            entry: entry.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("markdownaura-trail-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("reading-trail.json")
    }

    /// An absolute path on the running platform, so `note`'s resolution is a no-op and the assertions
    /// compare the strings they show. (`session.rs` learned this the hard way: a literal `E:\…` is a
    /// *relative* file name on Unix, where the Linux run of the suite resolves it against the cwd.)
    fn doc(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .display()
            .to_string()
    }

    #[test]
    fn round_trips() {
        let path = tmp("roundtrip");
        let mut trail = Trail::default();
        /* Timestamps relative to the wall clock, not 1_000/2_000: `load_from` prunes what is outside the
           window against *now*, so epoch-millisecond fixtures are fifty years old and come back as an
           empty list. (The first version of this test did exactly that and failed on `len == 2`.) */
        let now = now_ms();
        note(&mut trail, &doc("notes.md"), "file", now - 3_000);
        set_position(&mut trail, &doc("notes.md"), "Pipeline", 0.34, now - 2_000);
        note(&mut trail, &doc("docs"), "folder", now - 1_000);
        save_to(&path, &trail).unwrap();

        let back = load_from(&path);
        assert_eq!(back.version, TRAIL_VERSION);
        assert_eq!(back.entries.len(), 2);
        assert_eq!(back.entries[0].path, doc("docs"));
        assert_eq!(back.entries[0].kind, "folder");
        assert_eq!(back.entries[0].last_read, None);
        assert_eq!(back.entries[1].last_read.as_ref().unwrap().heading, "Pipeline");
        assert!((back.entries[1].last_read.as_ref().unwrap().pct - 0.34).abs() < f64::EPSILON);
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        let path = tmp("atomic");
        let mut trail = Trail::default();
        note(&mut trail, &doc("a.md"), "file", 1_000);
        save_to(&path, &trail).unwrap();
        assert!(path.with_extension("json.tmp").exists() == false);
    }

    #[test]
    fn unknown_version_starts_clean() {
        let path = tmp("version");
        std::fs::write(&path, r#"{"version":99,"entries":[{"path":"x","kind":"file","openedAt":1}]}"#).unwrap();
        assert!(load_from(&path).entries.is_empty());
    }

    #[test]
    fn unreadable_or_broken_file_is_an_empty_trail() {
        let path = tmp("broken");
        std::fs::write(&path, "{not json").unwrap();
        assert!(load_from(&path).entries.is_empty());
        let missing = tmp("missing");
        assert!(load_from(&missing).entries.is_empty());
    }

    #[test]
    fn note_is_de_duplicated_case_insensitively_and_most_recent_first() {
        let mut trail = Trail::default();
        let upper = doc("NOTES.md");
        let lower = doc("notes.md");
        note(&mut trail, &upper, "file", 1_000);
        note(&mut trail, &doc("other.md"), "file", 2_000);
        note(&mut trail, &lower, "file", 3_000);

        assert_eq!(trail.entries.len(), 2);
        assert_eq!(trail.entries[0].path, lower, "the re-open moves it to the front");
        assert_eq!(trail.entries[0].opens, 2, "and counts the second open");
        assert_eq!(trail.entries[0].opened_at, 3_000);
    }

    #[test]
    fn re_opening_a_file_keeps_where_it_stopped() {
        let mut trail = Trail::default();
        let file = doc("long.md");
        note(&mut trail, &file, "file", 1_000);
        set_position(&mut trail, &file, "Caching", 0.88, 1_500);
        note(&mut trail, &file, "file", 2_000);
        let entry = &trail.entries[0];
        assert_eq!(entry.last_read.as_ref().unwrap().heading, "Caching");
        assert_eq!(entry.opens, 2);
    }

    #[test]
    fn note_caps_the_list() {
        let mut trail = Trail::default();
        for i in 0..(TRAIL_CAP + 5) {
            note(&mut trail, &doc(&format!("f{i}.md")), "file", 1_000 + i as u64);
        }
        assert_eq!(trail.entries.len(), TRAIL_CAP);
        assert_eq!(trail.entries[0].path, doc(&format!("f{}.md", TRAIL_CAP + 4)));
    }

    #[test]
    fn the_window_measures_the_last_touch_not_the_first_open() {
        // Far enough along the epoch that "300 days before now" is still a positive number: the first
        // version used `now = 100 * DAY_MS` and the subtraction was a const-eval underflow (denied).
        let now = 400 * DAY_MS;
        let mut trail = Trail::default();
        // Opened long before the window, read again inside it: the entry belongs in the list.
        trail.entries.push(Entry {
            path: doc("old.md"),
            kind: "file".into(),
            opened_at: now - 300 * DAY_MS,
            opens: 1,
            last_read: Some(ReadPos {
                heading: "Caching".into(),
                pct: 0.5,
                at: now - DAY_MS,
            }),
        });
        // Opened before the window and never read since: it does not.
        trail.entries.push(Entry {
            path: doc("stale.md"),
            kind: "file".into(),
            opened_at: now - 91 * DAY_MS,
            opens: 1,
            last_read: None,
        });
        prune(&mut trail, now);
        assert_eq!(trail.entries.len(), 1);
        assert_eq!(trail.entries[0].path, doc("old.md"));
    }

    #[test]
    fn a_position_for_an_unknown_path_is_ignored() {
        let mut trail = Trail::default();
        set_position(&mut trail, &doc("never-opened.md"), "Pipeline", 0.5, 1_000);
        assert!(trail.entries.is_empty(), "a position is not an open");
    }

    #[test]
    fn the_percentage_is_clamped() {
        let mut trail = Trail::default();
        let file = doc("edge.md");
        note(&mut trail, &file, "file", 1_000);
        set_position(&mut trail, &file, "", 1.7, 1_100);
        set_position(&mut trail, &file, "", -2.0, 1_200);
        assert_eq!(trail.entries[0].last_read.as_ref().unwrap().pct, 0.0);
    }

    #[test]
    fn missing_is_derived_and_never_stored() {
        let path = tmp("missing-flag");
        let mut trail = Trail::default();
        // A real file (this test's own directory) and one that cannot exist.
        let here = path.parent().unwrap().join("here.md");
        std::fs::write(&here, "x").unwrap();
        note(&mut trail, &here.display().to_string(), "file", now_ms());
        note(&mut trail, &doc("definitely-not-here-9f3a.md"), "file", now_ms());
        save_to(&path, &trail).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        // By key, not by substring: the temp directory is named after this test, so "missing" appears
        // in the stored *paths* and a `contains` check would pass for the wrong reason.
        assert!(
            raw["entries"][0].get("missing").is_none(),
            "the flag is derived, not written"
        );

        let back = load_from(&path);
        let list = views(&back);
        // By path, not by index: `note` inserts at the front, so the first view is the *last* one noted —
        // which is the missing file. (The first version of this asserted on the index and failed.)
        let entry_of = |p: &str| list.iter().find(|v| v.entry.path == p).expect("entry");
        assert!(!entry_of(&here.display().to_string()).missing, "the file is right there");
        assert!(
            entry_of(&doc("definitely-not-here-9f3a.md")).missing,
            "the other one never existed"
        );
        // …and the flag is not in the file either, by key rather than by substring: the temp directory
        // is named after this test, so "missing" appears in the stored *paths*.
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            raw["entries"][0].get("missing").is_none(),
            "the flag is derived, not written"
        );
    }

    #[test]
    fn clear_empties_the_list_without_touching_the_version() {
        let mut trail = Trail::default();
        note(&mut trail, &doc("a.md"), "file", 1_000);
        clear(&mut trail);
        assert!(trail.entries.is_empty());
        assert_eq!(trail.version, TRAIL_VERSION);
    }
}
