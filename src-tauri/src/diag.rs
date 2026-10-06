//! Runtime diagnostics (IMPL.md §13).
//!
//! The failure this exists for leaves nothing behind: a shipped build is `panic = "abort"` with
//! `strip = true` and no console, so a panic on a user's machine is a process that simply
//! vanishes. This module writes the evidence — an NDJSON `app.log`, a self-contained report per
//! panic, and a `run.json` marker whose survival across a launch is how an unclean exit is told
//! from a clean one.
//!
//! Every rule in here is narrow on purpose:
//!
//! * Nothing depends on a Tauri handle. `init()` runs before `tauri::Builder::default()`, so a
//!   panic inside plugin init or `window.build()` is still logged; the path comes from `std` +
//!   env, exactly like `session::data_dir()`.
//! * Logging never fails the app. Every I/O error here is dropped: a log directory that cannot be
//!   created is not a reason to refuse to open a document.
//! * The panic hook never touches the main writer's lock. It opens its own `File` and only
//!   `try_lock`s the shared one, because the thread that panicked may already hold it.
//! * Nothing here logs a document, a buffer or IPC arguments (IMPL.md §13.9) — paths, counts,
//!   sizes, durations and error kinds only.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const APP_LOG: &str = "app.log";
const RUN_FILE: &str = "run.json";
/// `app.log` at most, and four files in total once rotation has run its course.
const MAX_BYTES: u64 = 1024 * 1024;
const ROTATE_KEEP: usize = 3;
/// One line, so a single pathological message cannot eat the rotation budget.
const MAX_LINE: usize = 4096;
const HEARTBEAT: Duration = Duration::from_secs(300);
const CRASH_KEEP: usize = 10;
const TAIL_LINES: usize = 200;

const LEVEL_OFF: u8 = 0;
const LEVEL_ERROR: u8 = 1;
const LEVEL_WARN: u8 = 2;
const LEVEL_INFO: u8 = 3;
const LEVEL_DEBUG: u8 = 4;

/// The open log file. Behind a `Mutex` because every thread writes through the same handle, which
/// is what keeps lines from interleaving within one `write_all`.
struct Sink {
    dir: PathBuf,
    file: File,
    bytes: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static LEVEL: AtomicU8 = AtomicU8::new(LEVEL_INFO);
static RUN: LazyLock<String> = LazyLock::new(mint_run_id);
static START: LazyLock<Instant> = LazyLock::new(Instant::now);
static LINES: AtomicU64 = AtomicU64::new(0);
static PANIC_HOOKED: AtomicBool = AtomicBool::new(false);
static CRASH_HOOKED: AtomicBool = AtomicBool::new(false);
static EXITED: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------- public surface

/// Collects a run id and starts writing, before any Tauri type exists (IMPL.md §13.2). Must be the
/// first statement of `run()`. A configured directory that cannot be created falls back to the
/// platform default and says so in the line that reports it.
pub fn init() {
    // Anchor the process start time now rather than at the first heartbeat, so `uptime` is real.
    let _ = &*START;
    new_run();

    let session = crate::session::load();
    let env_dir = std::env::var("MARKDOWNAURA_LOG_DIR")
        .ok()
        .filter(|s| !s.is_empty());
    let configured = env_dir.or_else(|| {
        session
            .as_ref()
            .map(|s| s.log_dir.clone())
            .filter(|s| !s.is_empty())
    });
    let default = platform_default_dir();

    let mut rejected = None;
    let (dir, sink) = match configured {
        Some(raw) => {
            let wanted = PathBuf::from(raw);
            match Sink::open(&wanted) {
                Ok(sink) => (wanted, Some(sink)),
                Err(err) => {
                    rejected = Some((wanted, err.to_string()));
                    (default.clone(), Sink::open(&default).ok())
                }
            }
        }
        None => (default.clone(), Sink::open(&default).ok()),
    };

    LEVEL.store(initial_level(&session), Ordering::Relaxed);
    if let Ok(mut guard) = SINK.lock() {
        *guard = sink;
    }

    install_panic_hook();
    spawn_heartbeat();

    if let Some((wanted, err)) = rejected {
        crate::diag_warn!("diag", "configured log dir unusable", {
            "dir": wanted.display().to_string(),
            "err": err,
            "using": dir.display().to_string()
        });
    }
    crate::diag_info!("diag", "diagnostics started", {"dir": dir.display().to_string()});
}

/// The directory lines are currently being written to.
pub fn dir() -> PathBuf {
    SINK.lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|s| s.dir.clone()))
        .unwrap_or_else(platform_default_dir)
}

/// Re-opens the writer at `dir`; `None`/`""` returns to the platform default. The file already
/// written stays where it was — the next line simply creates a fresh `app.log` here. The `run.json`
/// marker follows the log, because it is about *this* process and leaving it behind would be read
/// as an unclean exit on the next launch at the old path.
pub fn set_dir(raw: Option<&str>) -> io::Result<PathBuf> {
    let target = match raw {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => platform_default_dir(),
    };
    let sink = Sink::open(&target)?;
    let previous = dir();
    {
        let mut guard = SINK
            .lock()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "log sink is poisoned"))?;
        *guard = Some(sink);
    }
    if target != previous {
        let _ = std::fs::remove_file(previous.join(RUN_FILE));
        write_marker(&target);
    }
    crate::diag_info!("diag", "log dir changed", {"dir": target.display().to_string()});
    Ok(target)
}

/// Mints the run id once per process and returns it. The front end reuses the same value on every
/// line it reports, so one run can be selected without a timestamp range.
pub fn new_run() -> &'static str {
    RUN.as_str()
}

/// Sanitises and applies a level, returning what was applied. Anything unrecognised — including a
/// typo in the env override — becomes `info`, never silence.
pub fn set_level(level: &str) -> String {
    let number = level_number(level);
    LEVEL.store(number, Ordering::Relaxed);
    level_name(number).to_string()
}

pub fn level() -> String {
    level_name(LEVEL.load(Ordering::Relaxed)).to_string()
}

/// Called by `init()`. Under `panic = "abort"` the hook still runs before the process dies, which
/// is the only recourse a stripped release build has.
pub fn install_panic_hook() {
    if PANIC_HOOKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic while writing the crash report must not recurse; `swap` claims the one run and
        // hands every later panic straight back to the default hook.
        if CRASH_HOOKED.swap(true, Ordering::SeqCst) {
            previous(info);
            return;
        }
        let message = panic_text(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        write_crash_report(&message, &location, &thread, &backtrace);

        // Best effort into the shared log: `try_lock`, never `lock`, because the panicking thread
        // may already hold it.
        if let Ok(mut guard) = SINK.try_lock() {
            if let Some(sink) = guard.as_mut() {
                let _ = emit(sink, LEVEL_INFO, LEVEL_ERROR, "panic", &message, None);
            }
        }
        previous(info);
    }));
}

/// What `mark_running` found on disk before it wrote our own marker. Remembered because that is the
/// only moment the evidence exists: the marker is one file, and writing ours destroys the previous
/// run's — so `status()` and the report would otherwise always read "clean" and the About row's
/// unclean line could never appear.
static PREVIOUS_UNCLEAN: Mutex<Option<PreviousRun>> = Mutex::new(None);

/// `setup()`: the single-instance plugin has already decided this process owns the window, so this
/// is the first point a marker may be written. A marker still on disk means the previous run never
/// reached `mark_clean_exit`.
pub fn mark_running() {
    let dir = dir();
    let previous = previous_unclean_in(&dir);
    if let Some(previous) = previous.as_ref() {
        crate::diag_warn!("app", "previous run did not exit cleanly", {
            "prev_run": previous.run.clone(),
            "started": previous.started.clone()
        });
    }
    if let Ok(mut guard) = PREVIOUS_UNCLEAN.lock() {
        *guard = previous;
    }
    write_marker(&dir);
}

/// `RunEvent::Exit` / `ExitRequested`. Idempotent: the marker is removed only by the process whose
/// pid it records, so a second launch that hands its path over and exits cannot delete ours.
pub fn mark_clean_exit() {
    if EXITED.swap(true, Ordering::SeqCst) {
        return;
    }
    let dir = dir();
    if let Some(marker) = read_marker(&dir) {
        if marker.pid == std::process::id() {
            let _ = std::fs::remove_file(dir.join(RUN_FILE));
        }
    }
    crate::diag_info!("app", "exit");
}

pub fn status() -> DiagStatus {
    let dir = dir();
    DiagStatus {
        level: level(),
        run: new_run().to_string(),
        log_dir: dir.display().to_string(),
        log_bytes: std::fs::metadata(dir.join(APP_LOG)).map(|m| m.len()).unwrap_or(0),
        previous_unclean: previous_unclean(),
    }
}

/// Markdown, for the clipboard. Not truncated: the last 200 lines are the whole tail, and a
/// clipboard is not a size budget. The caller reveals a saved report; this only builds the text.
pub fn report() -> String {
    report_in(&dir(), previous_unclean().as_ref())
}

/// The body, with the directory and the previous run injected — the same shape as
/// `previous_unclean_in`, so the text a reader is handed can be asserted without touching the
/// process-wide sink.
fn report_in(dir: &Path, previous: Option<&PreviousRun>) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let webview = webview_data_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let browser_args = if std::env::var_os("MARKDOWNAURA_BROWSER_ARGS").is_some() {
        "set"
    } else {
        "unset"
    };

    let mut out = String::new();
    out.push_str("# MarkdownAura diagnostics\n\n");
    out.push_str("> This report contains local paths (your user name, install and log locations).\n");
    out.push_str("> Review it before sharing.\n\n");
    out.push_str(&format!("- version: {}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!("- run: {}\n", new_run()));
    out.push_str(&format!("- os: {} / {}\n", std::env::consts::OS, std::env::consts::ARCH));
    out.push_str(&format!("- exe: {exe}\n"));
    out.push_str(&format!("- log dir: {}\n", dir.display()));
    out.push_str(&format!("- webview2 data dir: {webview}\n"));
    out.push_str(&format!("- MARKDOWNAURA_BROWSER_ARGS: {browser_args}\n"));
    match previous {
        Some(previous) => out.push_str(&format!(
            "- previous run: unclean (run {}, started {})\n",
            previous.run, previous.started
        )),
        None => out.push_str("- previous run: clean\n"),
    }

    out.push_str("\n## environment\n\n");
    match environment_block_in(dir) {
        Some(line) => {
            out.push_str(&line);
            out.push('\n');
        }
        None => out.push_str("no environment entry\n"),
    }

    out.push_str(&format!("\n## last {TAIL_LINES} lines\n\n```\n"));
    for line in read_tail(&dir.join(APP_LOG), TAIL_LINES) {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str("```\n");
    out
}

/// Writes the full report to `logs/report-<ts>.md`. Returning the path rather than revealing it
/// keeps this module free of the window and the platform's file manager — the command's caller
/// does the reveal (IMPL.md §13.8).
pub fn save_report() -> io::Result<PathBuf> {
    let dir = dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("report-{}.md", file_stamp_now()));
    std::fs::write(&path, report())?;
    Ok(path)
}

/// The unclean run `mark_running` found at startup, if any (§13.5.4). Read from memory, not from
/// `run.json`: by now that file holds *this* run's marker.
pub fn previous_unclean() -> Option<PreviousRun> {
    PREVIOUS_UNCLEAN.lock().ok().and_then(|guard| guard.clone())
}

/// The one entry point every macro funnels into. A level of `off` — or one below the current
/// threshold — writes nothing at all.
pub fn log_event(level: &str, module: &str, message: &str, data: Option<Value>) {
    let Ok(mut guard) = SINK.lock() else {
        return;
    };
    let Some(sink) = guard.as_mut() else {
        return;
    };
    let _ = emit(
        sink,
        LEVEL.load(Ordering::Relaxed),
        level_number(level),
        module,
        message,
        data.as_ref(),
    );
}

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagStatus {
    pub level: String,
    pub run: String,
    pub log_dir: String,
    pub log_bytes: u64,
    pub previous_unclean: Option<PreviousRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousRun {
    pub run: String,
    pub started: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunMarker {
    pid: u32,
    run: String,
    started: String,
}

// ---------------------------------------------------------------- levels

/// An unrecognised name is `info`, which is why the match falls through rather than erroring.
fn level_number(name: &str) -> u8 {
    match name {
        "off" => LEVEL_OFF,
        "error" => LEVEL_ERROR,
        "warn" => LEVEL_WARN,
        "debug" => LEVEL_DEBUG,
        _ => LEVEL_INFO,
    }
}

fn level_name(number: u8) -> &'static str {
    match number {
        LEVEL_OFF => "off",
        LEVEL_ERROR => "error",
        LEVEL_WARN => "warn",
        LEVEL_DEBUG => "debug",
        _ => "info",
    }
}

/// The file never carries an `off`/`debug` mismatch: `level == off` writes nothing and a level
/// above the current threshold is filtered out.
fn enabled(level: u8, current: u8) -> bool {
    level != LEVEL_OFF && current != LEVEL_OFF && level <= current
}

/// The level `init()` starts with: `MARKDOWNAURA_LOG`, else the session's `logLevel`, else `info`.
fn initial_level(session: &Option<crate::session::Session>) -> u8 {
    if let Some(raw) = std::env::var("MARKDOWNAURA_LOG").ok().filter(|s| !s.is_empty()) {
        return level_number(&raw);
    }
    session
        .as_ref()
        .map(|s| level_number(&s.log_level))
        .unwrap_or(LEVEL_INFO)
}

// ---------------------------------------------------------------- writing

impl Sink {
    fn open(dir: &Path) -> io::Result<Sink> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(APP_LOG);
        // Rotate at startup as well as in-process: a run that died over the cap must not start
        // building on top of the full file.
        let over = std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
        if over {
            rotate(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Sink {
            dir: dir.to_path_buf(),
            file,
            bytes,
        })
    }

    /// One `write_all` per line, so a crash cannot leave half a line in the middle of another.
    fn write(&mut self, line: &str) -> io::Result<()> {
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        if self.bytes + buf.len() as u64 > MAX_BYTES {
            rotate(&self.dir)?;
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(APP_LOG))?;
            self.bytes = 0;
        }
        self.file.write_all(&buf)?;
        self.bytes += buf.len() as u64;
        Ok(())
    }
}

/// Keeps `app.log`…`app.3.log` and drops the oldest. Rename, not copy: a same-volume rename is
/// atomic, and where the destination already exists on Windows it has to be removed first — that
/// is what the `remove_file` calls are for, not error swallowing.
fn rotate(dir: &Path) -> io::Result<()> {
    let current = dir.join(APP_LOG);
    if !current.exists() {
        return Ok(());
    }
    for i in (1..ROTATE_KEEP).rev() {
        let from = dir.join(format!("app.{i}.log"));
        if from.exists() {
            let to = dir.join(format!("app.{}.log", i + 1));
            let _ = std::fs::remove_file(&to);
            std::fs::rename(&from, &to)?;
        }
    }
    let _ = std::fs::remove_file(dir.join("app.1.log"));
    std::fs::rename(&current, dir.join("app.1.log"))?;
    Ok(())
}

/// Filter then format then write. Returns whether a line reached the file, which is the only
/// difference the two halves of the test suite need to see.
fn emit(sink: &mut Sink, current: u8, level: u8, module: &str, message: &str, data: Option<&Value>) -> bool {
    if !enabled(level, current) {
        return false;
    }
    match sink.write(&make_line(level_name(level), module, message, data)) {
        Ok(()) => {
            LINES.fetch_add(1, Ordering::Relaxed);
            true
        }
        Err(_) => false,
    }
}

/// One NDJSON object. Built by hand rather than through `serde_json::Value` so the field order
/// matches the contract and the file stays greppable by eye.
fn make_line(level: &str, module: &str, message: &str, data: Option<&Value>) -> String {
    let line = encode(level, module, message, data, false);
    if line.len() <= MAX_LINE {
        return line;
    }
    // A message this long is a bug in the caller, not evidence: drop `d`, cut `msg` at a char
    // boundary, and mark the line so a reader knows it is not the whole thing. Shrink in a loop
    // because JSON escaping can make the encoded form longer than the raw bytes.
    let base = encode(level, module, "", None, true);
    let room = MAX_LINE.saturating_sub(base.len()).saturating_add(2);
    let mut cut = truncate_utf8(message, room);
    loop {
        let candidate = encode(level, module, cut, None, true);
        if candidate.len() <= MAX_LINE || cut.is_empty() {
            return candidate;
        }
        cut = truncate_utf8(cut, cut.len().saturating_sub(candidate.len() - MAX_LINE));
    }
}

fn encode(level: &str, module: &str, message: &str, data: Option<&Value>, trunc: bool) -> String {
    let mut line = String::with_capacity(message.len() + 128);
    line.push_str("{\"ts\":");
    line.push_str(&json_str(&now_iso()));
    line.push_str(",\"lvl\":");
    line.push_str(&json_str(level));
    line.push_str(",\"run\":");
    line.push_str(&json_str(new_run()));
    line.push_str(",\"mod\":");
    line.push_str(&json_str(module));
    line.push_str(",\"msg\":");
    line.push_str(&json_str(message));
    if trunc {
        line.push_str(",\"trunc\":true");
    }
    if let Some(value) = data {
        if !value.is_null() {
            line.push_str(",\"d\":");
            line.push_str(&value.to_string());
        }
    }
    line.push('}');
    line
}

/// Serialise a string with its JSON escapes; the only failure `serde_json` has here is a
/// non-existent one, so the fallback is a safe empty string rather than a panic.
fn json_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ---------------------------------------------------------------- time

/// `2026-10-06T13:22:04.512Z`. The civil-date conversion is Hinnant's, shifted so the era begins
/// on March 1 — that is what makes the leap-day arithmetic fall out without a branch per month.
fn iso8601(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn now_iso() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso8601(now.as_secs() as i64, now.subsec_millis())
}

/// A filename-safe stamp: `20261006-132204-512`. Its lexicographic order is chronological, which
/// is what lets the crash directory be pruned by name.
fn file_stamp_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    file_stamp(now.as_secs() as i64, now.subsec_millis())
}

fn file_stamp(secs: i64, millis: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}-{millis:03}")
}

// ---------------------------------------------------------------- paths

/// Same shape as `session::data_dir()`: `std` + env only, because `init()` runs before any
/// `Manager` exists. Logs live in the state/data directory, never roaming `%APPDATA%` — a profile
/// has no business syncing 4 MB of rolling logs (IMPL.md §13.3).
fn platform_default_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(base).join("MarkdownAura").join("logs");
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(base) = std::env::var_os("XDG_STATE_HOME") {
            return PathBuf::from(base).join("MarkdownAura").join("logs");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/state/MarkdownAura/logs");
        }
    }
    PathBuf::from("logs")
}

/// WebView2's own default is `<exe folder>\<exe name>.<ext>.WebView2`, so the file *name* is tried
/// first and the stem second (a folder named without the `.exe` is what some hosts create); then the
/// same two names under `%LOCALAPPDATA%`, which is where WebView2 falls back when the exe's folder is
/// not writable. The data directory is located and recorded, never moved (IMPL.md §13.5) — this is
/// diagnostics, not a behaviour change for existing installs. `None` is an honest "not found".
fn webview_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let stem = exe.file_stem()?.to_string_lossy().to_string();
    let full = exe.file_name()?.to_string_lossy().to_string();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    for name in [format!("{full}.WebView2"), format!("{stem}.WebView2")] {
        if let Some(parent) = exe.parent() {
            let beside = parent.join(&name);
            if beside.exists() {
                return Some(beside);
            }
        }
        if let Some(local) = local.as_ref() {
            let candidate = local.join(&name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------- run marker

fn marker_path(dir: &Path) -> PathBuf {
    dir.join(RUN_FILE)
}

/// Temp-then-rename, the same discipline `session::save_to` uses: a reader never sees a half-written
/// marker. Failures are dropped — a marker that cannot be written costs an unclean-exit line, not a
/// launch.
fn write_marker(dir: &Path) {
    let marker = RunMarker {
        pid: std::process::id(),
        run: new_run().to_string(),
        started: now_iso(),
    };
    let Ok(body) = serde_json::to_vec(&marker) else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = dir.join("run.json.tmp");
    if std::fs::write(&tmp, &body).is_err() {
        return;
    }
    if std::fs::rename(&tmp, marker_path(dir)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn read_marker(dir: &Path) -> Option<RunMarker> {
    let text = std::fs::read_to_string(marker_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// A residual marker written by any other process is an unclean run; our own is not, which matters
/// because `mark_running` writes one before `status` or the report is ever asked for.
fn previous_unclean_in(dir: &Path) -> Option<PreviousRun> {
    read_marker(dir)
        .filter(|m| m.pid != std::process::id())
        .map(|m| PreviousRun {
            run: m.run,
            started: m.started,
        })
}

// ---------------------------------------------------------------- panic

/// The hook's own file, never the shared writer. Content: the message, the compiled-in location
/// (which survives `strip` and is usually the whole answer), the thread, the backtrace, the last
/// 50 lines and the environment block.
fn write_crash_report(message: &str, location: &str, thread_name: &str, backtrace: &str) {
    let dir = dir();
    let crash_dir = dir.join("crash");
    if std::fs::create_dir_all(&crash_dir).is_err() {
        return;
    }
    let path = crash_dir.join(format!("{}-{}.md", file_stamp_now(), new_run()));
    let Ok(mut file) = File::create(&path) else {
        return;
    };
    let _ = writeln!(file, "# MarkdownAura crash report\n");
    let _ = writeln!(file, "> This report contains local paths. Review it before sharing.\n");
    let _ = writeln!(file, "- run: {}", new_run());
    let _ = writeln!(file, "- time: {}", now_iso());
    let _ = writeln!(file, "- thread: {thread_name}");
    let _ = writeln!(file, "- location: {location}");
    let _ = writeln!(file, "- message: {message}\n");
    let _ = writeln!(file, "## backtrace\n\n```\n{backtrace}\n```\n");
    let tail = read_tail(&dir.join(APP_LOG), 50).join("\n");
    let _ = writeln!(file, "## last 50 lines\n\n```\n{tail}\n```\n");
    let _ = writeln!(
        file,
        "## environment\n\n{}",
        environment_block().unwrap_or_else(|| "no environment entry".to_string())
    );
    prune_crash_dir(&crash_dir);
}

/// Keeps the newest `CRASH_KEEP` reports. The `<ts>-` prefix sorts chronologically, so no mtime
/// read is needed.
fn prune_crash_dir(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == std::ffi::OsStr::new("md")))
        .collect();
    if files.len() <= CRASH_KEEP {
        return;
    }
    files.sort();
    for old in &files[..files.len() - CRASH_KEEP] {
        let _ = std::fs::remove_file(old);
    }
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

// ---------------------------------------------------------------- tail / environment

/// The last `n` lines of a file, read whole because `app.log` is capped at 1 MB. Missing or
/// non-UTF-8 reads give an empty tail rather than an error.
fn read_tail(path: &Path, n: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() > n {
        lines.drain(..lines.len() - n);
    }
    lines.into_iter().map(str::to_string).collect()
}

/// The most recent `"mod":"env"` entry anywhere in `app.log` — not just the tail. The front end
/// writes it once per run, so the report can carry the environment even when the tail has scrolled
/// past it.
fn environment_block() -> Option<String> {
    environment_block_in(&dir())
}

fn environment_block_in(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(APP_LOG)).ok()?;
    text.lines()
        .rev()
        .find(|line| line.contains("\"mod\":\"env\""))
        .map(str::to_string)
}

// ---------------------------------------------------------------- threads

/// A Rust-side heartbeat on purpose: it is what separates "the process died" from "only the render
/// process died" (IMPL.md §13.5). It follows the current directory because it goes through
/// `log_event` like every other line.
fn spawn_heartbeat() {
    let _ = thread::Builder::new()
        .name("markdownaura-heartbeat".to_string())
        .spawn(|| loop {
            thread::sleep(HEARTBEAT);
            let uptime = START.elapsed().as_secs();
            crate::diag_info!("diag", "alive", {
                "uptime": uptime,
                "lines": LINES.load(Ordering::Relaxed)
            });
        });
}

/// 6 lowercase hex digits is short enough to paste into a report and wide enough to separate the
/// concurrent runs a user can produce. Seeded from the clock and the pid; no `rand` dependency.
fn mint_run_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos ^ (u64::from(std::process::id()) << 20) ^ 0x9E37_79B9_7F4A_7C15;
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    format!("{:06x}", x & 0xFF_FFFF)
}

// ---------------------------------------------------------------- macros

/// `diag_warn!("watcher", "notify error", {"path": p, "err": e})` — the data group is optional and
/// becomes `serde_json::json!`. Four copies rather than one delegating macro: the level has to be a
/// literal for the filter to be a constant, and a reader should not have to expand it to see that.
#[macro_export]
macro_rules! diag_error {
    ($module:expr, $message:expr $(,)?) => {
        $crate::diag::log_event("error", $module, $message, ::std::option::Option::None)
    };
    ($module:expr, $message:expr, $data:tt $(,)?) => {
        $crate::diag::log_event("error", $module, $message, ::std::option::Option::Some(::serde_json::json!($data)))
    };
}

#[macro_export]
macro_rules! diag_warn {
    ($module:expr, $message:expr $(,)?) => {
        $crate::diag::log_event("warn", $module, $message, ::std::option::Option::None)
    };
    ($module:expr, $message:expr, $data:tt $(,)?) => {
        $crate::diag::log_event("warn", $module, $message, ::std::option::Option::Some(::serde_json::json!($data)))
    };
}

#[macro_export]
macro_rules! diag_info {
    ($module:expr, $message:expr $(,)?) => {
        $crate::diag::log_event("info", $module, $message, ::std::option::Option::None)
    };
    ($module:expr, $message:expr, $data:tt $(,)?) => {
        $crate::diag::log_event("info", $module, $message, ::std::option::Option::Some(::serde_json::json!($data)))
    };
}

#[macro_export]
macro_rules! diag_debug {
    ($module:expr, $message:expr $(,)?) => {
        $crate::diag::log_event("debug", $module, $message, ::std::option::Option::None)
    };
    ($module:expr, $message:expr, $data:tt $(,)?) => {
        $crate::diag::log_event("debug", $module, $message, ::std::option::Option::Some(::serde_json::json!($data)))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("markdownaura-diag-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn iso8601_matches_known_instants() {
        assert_eq!(iso8601(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_700_000_000, 0), "2023-11-14T22:13:20.000Z");
        // 2000 is a leap year (divisible by 400), so Feb 29 exists.
        assert_eq!(iso8601(951_782_400, 0), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601(1_700_000_000, 512), "2023-11-14T22:13:20.512Z");
    }

    #[test]
    fn file_stamps_sort_chronologically() {
        assert_eq!(file_stamp(1_700_000_000, 512), "20231114-221320-512");
        assert!(file_stamp(1_700_000_000, 0) < file_stamp(1_700_000_001, 0));
    }

    #[test]
    fn unknown_levels_sanitise_to_info() {
        assert_eq!(set_level("verbose"), "info");
        assert_eq!(set_level("WARN"), "info");
        assert_eq!(set_level("debug"), "debug");
        assert_eq!(level(), "debug");
        // Leave the process level where it started, so a later test is not affected.
        assert_eq!(set_level("info"), "info");
    }

    #[test]
    fn off_and_below_threshold_write_nothing() {
        let dir = temp_dir("filter");
        let mut sink = Sink::open(&dir).unwrap();
        let log = dir.join(APP_LOG);

        assert!(!emit(&mut sink, LEVEL_OFF, LEVEL_INFO, "ipc", "should not appear", None));
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0, "off must write nothing");

        assert!(!emit(&mut sink, LEVEL_WARN, LEVEL_INFO, "ipc", "too verbose", None));
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);

        assert!(emit(&mut sink, LEVEL_INFO, LEVEL_WARN, "watcher", "notify error", None));
        assert!(std::fs::metadata(&log).unwrap().len() > 0);
    }

    #[test]
    fn a_huge_message_is_truncated_to_the_line_cap() {
        let big = "x".repeat(20_000);
        let line = make_line("info", "ipc", &big, Some(&serde_json::json!({"k": "v"})));
        assert!(line.len() <= MAX_LINE, "line was {} bytes", line.len());
        assert!(line.contains("\"trunc\":true"));
        // The data is dropped on a truncated line: it is part of what would not fit.
        assert!(!line.contains("\"d\":"));
    }

    #[test]
    fn a_short_line_is_left_alone() {
        let line = make_line("warn", "watcher", "notify error", Some(&serde_json::json!({"path": "E:\\notes"})));
        assert!(!line.contains("trunc"));
        assert!(line.contains("\"lvl\":\"warn\""));
        assert!(line.contains("\"mod\":\"watcher\""));
        assert!(line.contains("\"d\":{\"path\":\"E:\\\\notes\"}"));
        assert!(line.ends_with('}'));
    }

    #[test]
    fn rotation_keeps_four_files_and_drops_the_oldest() {
        let dir = temp_dir("rotate");
        for name in [APP_LOG, "app.1.log", "app.2.log", "app.3.log"] {
            std::fs::write(dir.join(name), name.as_bytes()).unwrap();
        }
        rotate(&dir).unwrap();

        assert!(!dir.join(APP_LOG).exists(), "app.log is renamed, not copied");
        assert_eq!(
            std::fs::read_to_string(dir.join("app.1.log")).unwrap(),
            APP_LOG,
            "app.log becomes app.1.log"
        );
        assert_eq!(std::fs::read_to_string(dir.join("app.2.log")).unwrap(), "app.1.log");
        assert_eq!(std::fs::read_to_string(dir.join("app.3.log")).unwrap(), "app.2.log");
        // The old app.3.log is the one dropped, and no temp file is left behind.
        assert!(!dir.join("app.log.tmp").exists());
        assert!(!dir.join("app.4.log").exists());

        // A reopened sink recreates app.log, so the steady state is still four files.
        let _sink = Sink::open(&dir).unwrap();
        assert!(dir.join(APP_LOG).exists());
    }

    #[test]
    fn a_full_file_rotates_on_open() {
        let dir = temp_dir("rotate-open");
        std::fs::write(dir.join(APP_LOG), vec![b'a'; (MAX_BYTES + 1) as usize]).unwrap();
        let _sink = Sink::open(&dir).unwrap();
        assert!(dir.join("app.1.log").exists());
        assert!(dir.join(APP_LOG).exists());
        assert!(std::fs::metadata(dir.join(APP_LOG)).unwrap().len() < MAX_BYTES);
    }

    #[test]
    fn tail_reads_only_the_last_lines() {
        let dir = temp_dir("tail");
        let path = dir.join("t.log");
        std::fs::write(&path, "1\n2\n3\n4\n5\n").unwrap();
        assert_eq!(read_tail(&path, 2), vec!["4", "5"]);
        assert_eq!(read_tail(&path, 50), vec!["1", "2", "3", "4", "5"]);
        assert!(read_tail(&dir.join("missing.log"), 3).is_empty());
    }

    /// The report is the artifact a reader sends, so its shape is pinned: the sharing warning, the
    /// facts, the environment entry *even after the tail has scrolled past it*, and the tail itself.
    #[test]
    fn the_report_carries_the_facts_the_environment_and_the_tail() {
        let dir = temp_dir("report");
        let mut log = String::from(
            "{\"ts\":\"t\",\"lvl\":\"info\",\"run\":\"aaaaaa\",\"mod\":\"env\",\"msg\":\"environment\",\"d\":{\"ua\":\"UA\"}}\n",
        );
        for i in 0..(TAIL_LINES + 5) {
            log.push_str(&format!(
                "{{\"ts\":\"t\",\"lvl\":\"info\",\"run\":\"aaaaaa\",\"mod\":\"app\",\"msg\":\"line {i}\"}}\n"
            ));
        }
        std::fs::write(dir.join(APP_LOG), &log).unwrap();

        let body = report_in(&dir, None);
        assert!(body.contains("contains local paths"), "the sharing warning is missing");
        assert!(body.contains(&format!("- log dir: {}", dir.display())));
        assert!(body.contains("- previous run: clean"));
        assert!(
            body.contains("\"d\":{\"ua\":\"UA\"}"),
            "the env entry was not scanned out of the whole file"
        );
        assert!(body.contains(&format!("line {}", TAIL_LINES + 4)), "the newest line is missing");
        assert!(!body.contains("line 0\"}"), "the tail kept lines older than its window");

        // The other branch: what the About row is built from when the last run never said goodbye.
        let crashed = PreviousRun {
            run: "abc123".to_string(),
            started: "2026-10-06T08:00:00.000Z".to_string(),
        };
        let body = report_in(&dir, Some(&crashed));
        assert!(body.contains("previous run: unclean (run abc123"), "the unclean branch is lost");
    }

    #[test]
    fn a_leftover_marker_reads_as_unclean_and_our_own_does_not() {
        let dir = temp_dir("unclean");
        let other = RunMarker {
            pid: 999_999,
            run: "abc123".to_string(),
            started: "2026-10-06T00:00:00.000Z".to_string(),
        };
        std::fs::write(marker_path(&dir), serde_json::to_vec(&other).unwrap()).unwrap();
        let previous = previous_unclean_in(&dir).expect("a residual marker is an unclean run");
        assert_eq!(previous.run, "abc123");
        assert_eq!(previous.started, "2026-10-06T00:00:00.000Z");

        let mine = RunMarker {
            pid: std::process::id(),
            run: "ourrun".to_string(),
            started: "2026-10-06T00:00:00.000Z".to_string(),
        };
        std::fs::write(marker_path(&dir), serde_json::to_vec(&mine).unwrap()).unwrap();
        assert!(previous_unclean_in(&dir).is_none());
    }

    #[test]
    fn a_marker_round_trips_without_a_temp_file() {
        let dir = temp_dir("marker");
        let marker = RunMarker {
            pid: 42,
            run: "7f3a21".to_string(),
            started: "2026-10-06T13:22:04.512Z".to_string(),
        };
        std::fs::write(marker_path(&dir), serde_json::to_vec(&marker).unwrap()).unwrap();
        assert_eq!(read_marker(&dir).unwrap().run, "7f3a21");
        assert!(!dir.join("run.json.tmp").exists());
    }

    #[test]
    fn the_run_id_is_six_hex_digits() {
        let id = new_run();
        assert_eq!(id.len(), 6);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
