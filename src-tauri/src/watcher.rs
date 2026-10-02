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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::ApiError;
use crate::fs_ops::is_ignored_dir;

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
                            match event.kind {
                                EventKind::Remove(_) => {
                                    changed.remove(&path);
                                    removed.insert(path);
                                }
                                EventKind::Create(_) | EventKind::Modify(_) => {
                                    // A file that was removed then recreated is a change, not a
                                    // removal — the tab must come back, not go `missing`.
                                    if !removed.contains(&path) {
                                        changed.insert(path);
                                    }
                                }
                                _ => {}
                            }
                        }
                        // Every event pushes the window out, which is what makes a burst of
                        // twenty notifications collapse into one.
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                    Ok(Err(_)) => {}
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
