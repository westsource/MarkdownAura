//! Filesystem watching (IMPL.md §3).
//!
//! The watcher exists so the preview stays honest about what is on disk. Two design points:
//!
//! * **Events are coalesced, not forwarded.** A save in an editor can produce a burst of
//!   create/write/rename notifications for the same path; the contract is one `fs://changed`
//!   per batch of edits, never one per file. That is why this module does its own 120 ms
//!   window instead of depending on a debouncer crate.
//! * The paths watched, and the ignore rules applied to them, live here and not in the
//!   frontend, so the sidebar's "watching N files" counter cannot disagree with reality.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::ApiError;
use crate::fs_ops::{self, is_ignored_dir};

/// Long enough to swallow an editor's write burst, short enough that a save still feels live.
pub const DEBOUNCE: Duration = Duration::from_millis(120);
pub const CHANGED_EVENT: &str = "fs://changed";
pub const REMOVED_EVENT: &str = "fs://removed";

/// Counting stops here so a pathological folder cannot stall `watch_set`.
const COUNT_CAP: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub watching: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPayload {
    pub paths: Vec<String>,
}

/// What this process last wrote, per path — the mtime it left behind.
///
/// A save cannot be told from an external edit by the event alone: `write_file` replaces the
/// document through a temp file plus a rename (SPEC §12), and notify reports that like any other
/// burst. So `save_doc` records the mtime it wrote, and the coalescer drops a batch naming a path
/// that still carries it — the file on disk is already what the pane shows, because the save path
/// re-read and re-rendered it. Without this, one `ctrl S` repainted the document twice about 120 ms
/// apart: a visible flash on a diagram-heavy file, and a second window in which the editable pane
/// had been emptied of text and lost the caret. Found 2026-10-13 by timing the panes' DOM during a
/// save, not by reading this file.
#[derive(Default)]
pub struct SelfWrites(Mutex<HashMap<String, i64>>);

impl SelfWrites {
    /// Records a write this process just made. Called by `save_doc` after the file is replaced.
    pub fn remember(&self, path: &Path, mtime_ms: i64) {
        if let Ok(mut writes) = self.0.lock() {
            writes.insert(key(path), mtime_ms);
        }
    }

    /// Whether `path` is still exactly what this process last wrote — in which case the event naming
    /// it is our own save coming back and there is nothing left to reload. The record is consumed
    /// either way: a mismatch means somebody else wrote the file, and *that* write is theirs to
    /// report, so a stale record must not sit there and swallow the next change.
    fn is_ours(&self, path: &Path) -> bool {
        let Ok(mut writes) = self.0.lock() else {
            return false;
        };
        let Some(recorded) = writes.remove(&key(path)) else {
            return false;
        };
        match std::fs::metadata(path) {
            Ok(meta) => fs_ops::mtime_ms(&meta) == recorded,
            // A path that is gone is not what we wrote; a removal is a real event.
            Err(_) => false,
        }
    }
}

/// The key two sides have to agree on: `save_doc` gets the tab's path, the watcher reports what
/// notify joined onto the watched root. `fs_ops::absolute` is the app's one rule for making those
/// comparable; the rest mirrors `normalizePath` in `state.ts`, because on Windows those two strings
/// can differ in case and separator and still name one file.
fn key(path: &Path) -> String {
    let text = fs_ops::absolute(path).display().to_string();
    if cfg!(windows) {
        text.replace('\\', "/").to_lowercase()
    } else {
        text
    }
}

/// Owns the notify watcher and the current watch set. Registered as Tauri state.
pub struct FsWatcher {
    inner: RecommendedWatcher,
    roots: Vec<PathBuf>,
    /// Kept alive for the lifetime of the watcher; dropping it closes the channel and the
    /// coalescing thread exits.
    _tx: Sender<notify::Result<Event>>,
}

impl FsWatcher {
    pub fn new(app: AppHandle) -> Result<Self, ApiError> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        // The callback needs its own handle, and the original is kept in the struct: the channel
        // stays open only while at least one Sender is alive, so holding one here is what keeps
        // the coalescing thread from exiting on the next tick.
        let sender = tx.clone();
        let inner = notify::recommended_watcher(move |res: notify::Result<Event>| {
            // A send failure means the app is shutting down; there is nobody left to tell.
            let _ = sender.send(res);
        })
        .map_err(|e| ApiError::io_plain(Path::new("<watcher>"), std::io::ErrorKind::Other, e.to_string()))?;

        spawn_coalescer(app, rx);

        Ok(Self {
            inner,
            roots: Vec::new(),
            _tx: tx,
        })
    }

    /// Replaces the whole watch set. Idempotent: calling it twice with the same paths is the
    /// same as calling it once.
    pub fn set_paths(&mut self, paths: Vec<PathBuf>) -> Result<WatcherStatus, ApiError> {
        for root in self.roots.drain(..) {
            // Unwatch failures are not worth surfacing: the path may already be gone.
            let _ = self.inner.unwatch(&root);
        }

        for path in &paths {
            if !path.exists() {
                continue;
            }
            let (target, mode) = if path.is_dir() {
                (path.clone(), RecursiveMode::Recursive)
            } else {
                // Watch the containing folder; notify cannot watch a single file portably.
                (
                    path.parent().unwrap_or(path).to_path_buf(),
                    RecursiveMode::NonRecursive,
                )
            };
            self.inner
                .watch(&target, mode)
                .map_err(|e| ApiError::io_plain(&target, std::io::ErrorKind::Other, e.to_string()))?;
            self.roots.push(target);
        }

        Ok(WatcherStatus {
            watching: count_files(&paths),
        })
    }

    pub fn stop_all(&mut self) -> Result<(), ApiError> {
        for root in self.roots.drain(..) {
            let _ = self.inner.unwatch(&root);
        }
        Ok(())
    }

    pub fn status(&self) -> WatcherStatus {
        WatcherStatus {
            watching: count_files(&self.roots),
        }
    }
}

/// Files under `roots`, skipping the same directories the tree hides. Recursion is iterative so
/// a deep tree cannot blow the stack.
fn count_files(roots: &[PathBuf]) -> usize {
    let mut count = 0usize;
    let mut stack: Vec<PathBuf> = roots.to_vec();

    while let Some(dir) = stack.pop() {
        if count >= COUNT_CAP {
            break;
        }
        if dir.is_file() {
            count += 1;
            continue;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    if !is_ignored_dir(&name) {
                        stack.push(entry.path());
                    }
                }
                Ok(_) => count += 1,
                Err(_) => {}
            }
        }
    }
    count.min(COUNT_CAP)
}

/// Folds one raw event into the batch being collected.
///
/// A removal wins over a pending change for the same path, and a create or modify cancels a
/// pending removal. That second half is the one that matters: saving through a temporary file
/// (write, delete, rename) looks like a removal followed by a create, and the tab has to come
/// back rather than go `missing` (IMPL.md §3).
fn classify(
    kind: &EventKind,
    path: PathBuf,
    changed: &mut HashSet<PathBuf>,
    removed: &mut HashSet<PathBuf>,
) {
    match kind {
        EventKind::Remove(_) => {
            changed.remove(&path);
            removed.insert(path);
        }
        EventKind::Create(_) | EventKind::Modify(_) => {
            removed.remove(&path);
            changed.insert(path);
        }
        _ => {}
    }
}

/// Coalesces raw notify events into one batch per quiet window.
fn spawn_coalescer(app: AppHandle, rx: mpsc::Receiver<notify::Result<Event>>) {
    thread::Builder::new()
        .name("markdownaura-watcher".into())
        .spawn(move || {
            let mut changed: HashSet<PathBuf> = HashSet::new();
            let mut removed: HashSet<PathBuf> = HashSet::new();
            let mut deadline: Option<Instant> = None;

            loop {
                // Block until either the quiet window closes or another event arrives.
                let wait = deadline
                    .map(|d| d.saturating_duration_since(Instant::now()))
                    .unwrap_or(Duration::from_secs(3600));

                match rx.recv_timeout(wait) {
                    Ok(Ok(event)) => {
                        for path in event.paths {
                            classify(&event.kind, path, &mut changed, &mut removed);
                        }
                        // Every event pushes the window out, which is what makes a burst of
                        // twenty notifications collapse into one.
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                    // notify's error stream used to be dropped here, which is how a watch that
                    // stopped working looks exactly like a file that stopped changing.
                    Ok(Err(err)) => {
                        crate::diag_warn!("watcher", "notify error", {"err": err.to_string()});
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if deadline.is_some_and(|d| Instant::now() >= d) {
                            flush(&app, &mut changed, &mut removed);
                            deadline = None;
                        }
                    }
                    // The sender is gone, which means the app is going down.
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .expect("failed to spawn the watcher thread");
}

fn flush(app: &AppHandle, changed: &mut HashSet<PathBuf>, removed: &mut HashSet<PathBuf>) {
    drop_own_writes(app, changed);
    drop_own_writes(app, removed);
    if !changed.is_empty() {
        let payload = ChangedPayload {
            paths: changed.drain().map(|p| p.display().to_string()).collect(),
        };
        let _ = app.emit(CHANGED_EVENT, payload);
    }
    if !removed.is_empty() {
        let payload = ChangedPayload {
            paths: removed.drain().map(|p| p.display().to_string()).collect(),
        };
        let _ = app.emit(REMOVED_EVENT, payload);
    }
}

/// Drops the paths whose change is this process's own write coming back — see `SelfWrites`.
fn drop_own_writes(app: &AppHandle, paths: &mut HashSet<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let ours = app.state::<SelfWrites>();
    paths.retain(|path| !ours.is_ours(path));
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn counting_skips_the_same_dirs_the_tree_hides() {
        let root = std::env::temp_dir().join("markdownaura-watchcount");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("docs/b.md"), "b").unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(root.join("node_modules/x.js"), "x").unwrap();

        assert_eq!(count_files(&[root.clone()]), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_single_file_counts_as_one() {
        let root = std::env::temp_dir().join("markdownaura-watchcount-file");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("only.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(count_files(&[file]), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_root_counts_zero_instead_of_panicking() {
        let missing = std::env::temp_dir().join("markdownaura-does-not-exist-9f3a");
        assert_eq!(count_files(&[missing]), 0);
    }

    #[test]
    fn a_removed_then_recreated_file_is_a_change_not_a_removal() {
        let path = PathBuf::from("E:\\notes\\a.md");
        let mut changed = HashSet::new();
        let mut removed = HashSet::new();

        classify(&EventKind::Remove(RemoveKind::File), path.clone(), &mut changed, &mut removed);
        assert!(removed.contains(&path) && changed.is_empty(), "a removal is pending");

        classify(&EventKind::Create(CreateKind::File), path.clone(), &mut changed, &mut removed);
        assert!(changed.contains(&path), "the recreated file is a change");
        assert!(!removed.contains(&path), "the pending removal has to be dropped");

        classify(&EventKind::Modify(ModifyKind::Any), path.clone(), &mut changed, &mut removed);
        assert!(changed.contains(&path) && !removed.contains(&path));
    }

    #[test]
    fn a_removal_after_a_change_wins() {
        let path = PathBuf::from("E:\\notes\\b.md");
        let mut changed = HashSet::new();
        let mut removed = HashSet::new();

        classify(&EventKind::Modify(ModifyKind::Any), path.clone(), &mut changed, &mut removed);
        classify(&EventKind::Remove(RemoveKind::File), path.clone(), &mut changed, &mut removed);
        assert!(removed.contains(&path), "a real removal stays a removal");
        assert!(!changed.contains(&path), "and it must not also be reported as changed");
    }

    #[test]
    fn our_own_write_is_recognised_once_and_only_while_it_is_still_on_disk() {
        let root = std::env::temp_dir().join("markdownaura-selfwrite");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("doc.md");
        std::fs::write(&file, "a").unwrap();
        let ours = SelfWrites::default();
        let left_behind = fs_ops::mtime_ms(&std::fs::metadata(&file).unwrap());

        // A path nobody recorded is somebody else's business.
        assert!(!ours.is_ours(&file));

        ours.remember(&file, left_behind);
        assert!(ours.is_ours(&file), "the mtime we left behind is ours");
        assert!(!ours.is_ours(&file), "and the record is consumed, not sticky");

        // An mtime that is not the file's means the file moved on without us.
        ours.remember(&file, left_behind + 1_000);
        assert!(!ours.is_ours(&file));
        assert!(!ours.is_ours(&file), "a record that did not match is dropped, not left to misfire");

        // A path that is gone is a removal, not our old write.
        ours.remember(&file, left_behind);
        std::fs::remove_file(&file).unwrap();
        assert!(!ours.is_ours(&file));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The two strings that have to meet: `save_doc`'s tab path and what notify joined onto the
    /// watched root. On Windows they can differ in case and separator and still name one file;
    /// elsewhere that difference is two different files and must stay two.
    #[test]
    fn the_key_folds_what_windows_does_not_distinguish() {
        let written = PathBuf::from("C:\\Users\\reader\\Notes\\Doc.md");
        let reported = PathBuf::from("c:/users/reader/notes/doc.md");

        if cfg!(windows) {
            assert_eq!(key(&written), key(&reported));
        } else {
            assert_ne!(key(&written), key(&reported));
        }
    }
}
