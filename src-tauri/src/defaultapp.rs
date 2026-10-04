//! Being the default handler for Markdown files (SPEC §10).
//!
//! The two platforms differ in a way that cannot be papered over, so this module does not pretend they
//! are the same:
//!
//! * **Linux can be told.** `xdg-mime default <desktop file> text/markdown` writes `~/.config/mimeapps.list`
//!   and that is the whole job. An AppImage is not installed, so it has no desktop file to name — it has
//!   to be integrated with the desktop first, and the status says so rather than failing silently.
//! * **Windows cannot.** Since Windows 8 the per-user choice lives in `FileExts\.md\UserChoice`, which is
//!   protected against exactly this kind of write. An installer can register a ProgID and appear in
//!   *Open with* — ours does — but the choice belongs to the user. The only honest ways to hand it over are
//!   the *Open with* dialog for a real document (`rundll32 shell32.dll,OpenAs_RunDLL <file>`, one file,
//!   one click, tick *Always*) or the Default Apps page. Both are offered; neither claims to have set
//!   anything by itself.
use std::path::PathBuf;

use crate::error::{ApiError, Result};

/// The desktop file the Debian package installs, and the one an integrated AppImage would.
const DEB_DESKTOP: &str = "MarkdownAura.desktop";
const APPIMAGE_DESKTOP: &str = "markdownaura.desktop";
const MIME: &str = "text/markdown";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppStatus {
    /// `windows` or `linux`; the frontend labels the button differently.
    pub platform: String,
    /// Is MarkdownAura among the applications that can open a `.md`?
    pub registered: bool,
    /// Is it *the* handler right now?
    pub is_default: bool,
    /// What is: a friendly name where one is available, otherwise the raw identifier.
    pub current: String,
    /// What `set_default_app` will do here: `set`, `dialog` or `settings`.
    pub action: String,
    /// Set once by the installer, consumed by the first launch that reads it.
    pub offer: bool,
}

pub fn status() -> DefaultAppStatus {
    imp::status()
}

/// Hands the choice to the platform. `path` is the document that is open, used by the Windows *Open
/// with* dialog; Linux ignores it.
pub fn set_default(path: Option<PathBuf>) -> Result<String> {
    imp::set_default(path)
}

// ---------------------------------------------------------------- windows

#[cfg(windows)]
mod imp {
    use super::{DefaultAppStatus, MIME, Result};
    use std::path::{Path, PathBuf};
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    use winreg::RegKey;

    const EXT: &str = ".md";
    const MARKER_KEY: &str = "Software\\MarkdownAura";
    const MARKER_VALUE: &str = "OfferDefaultApp";

    fn exe_name() -> String {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "markdownaura.exe".into())
            .to_ascii_lowercase()
    }

    /// The `shell\open\command` of a ProgID, lowercased.
    fn command_of(progid: &str) -> Option<String> {
        RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(format!("{progid}\\shell\\open\\command"))
            .ok()?
            .get_value::<String, _>("")
            .ok()
            .map(|s| s.to_ascii_lowercase())
    }

    /// Is `progid` one that launches this executable?
    fn is_ours(progid: &str, exe: &str) -> bool {
        command_of(progid).is_some_and(|c| c.contains(exe))
    }

    /// Everything registered for `.md` that points at us, plus whether any does.
    fn registered_progids(exe: &str) -> (Vec<String>, bool) {
        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        let mut ours = Vec::new();
        if let Ok(open_with) = hkcr.open_subkey(format!("{EXT}\\OpenWithProgids")) {
            for (progid, _) in open_with.enum_values().flatten() {
                if is_ours(&progid, exe) {
                    ours.push(progid);
                }
            }
        }
        let registered = !ours.is_empty();
        (ours, registered)
    }

    fn user_choice() -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\{EXT}\\UserChoice"
            ))
            .ok()?
            .get_value::<String, _>("ProgId")
            .ok()
    }

    /// The ProgID's display name — what the Default Apps page shows for it.
    fn friendly_name(progid: &str) -> Option<String> {
        RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(progid)
            .ok()?
            .get_value::<String, _>("")
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// Read-and-clear: the installer sets it, the first launch that asks consumes it.
    fn take_offer() -> bool {
        let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            MARKER_KEY,
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        ) else {
            return false;
        };
        let value = key.get_value::<u32, _>(MARKER_VALUE).unwrap_or(0);
        let _ = key.delete_value(MARKER_VALUE);
        value == 1
    }

    pub fn status() -> DefaultAppStatus {
        let exe = exe_name();
        let (_ours, registered) = registered_progids(&exe);
        let choice = user_choice();
        let is_default = choice.as_deref().is_some_and(|p| is_ours(p, &exe));
        let current = match &choice {
            Some(progid) => friendly_name(progid).unwrap_or_else(|| progid.clone()),
            None => String::new(),
        };
        DefaultAppStatus {
            platform: "windows".into(),
            registered,
            is_default,
            current,
            action: if is_default { "set".into() } else { "dialog".into() },
            offer: take_offer() && !is_default,
        }
    }

    pub fn set_default(path: Option<PathBuf>) -> Result<String> {
        match path.filter(|p| p.exists()) {
            // One document, one click, and the "Always use this app" box is right there.
            Some(document) => {
                std::process::Command::new("rundll32")
                    .args(["shell32.dll,OpenAs_RunDLL"])
                    .arg(&document)
                    .spawn()
                    .map_err(|e| super::ApiError::io(Path::new("rundll32"), e))?;
                Ok("dialog".into())
            }
            // No document to hand over: the Default Apps page is the supported route.
            None => {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "", "ms-settings:defaultapps"])
                    .spawn()
                    .map_err(|e| super::ApiError::io(Path::new("ms-settings"), e))?;
                Ok("settings".into())
            }
        }
    }
}

// ---------------------------------------------------------------- linux

#[cfg(not(windows))]
mod imp {
    use super::{APPIMAGE_DESKTOP, DEB_DESKTOP, DefaultAppStatus, MIME, Result};
    use std::path::{Path, PathBuf};

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(program).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Where a `.desktop` of this name would be found, in XDG order.
    fn desktop_file(name: &str) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
            dirs.push(PathBuf::from(data).join("applications"));
        } else if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/share/applications"));
        }
        for dir in std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into()).split(':') {
            dirs.push(PathBuf::from(dir).join("applications"));
        }
        dirs.into_iter().map(|d| d.join(name)).find(|p| p.exists())
    }

    /// The `Name=` of a desktop file, for showing what is currently the handler.
    fn desktop_name(path: &Path) -> Option<String> {
        let text = std::fs::read_to_string(path).ok()?;
        text.lines()
            .find_map(|l| l.strip_prefix("Name="))
            .map(|s| s.trim().to_string())
    }

    fn current_id() -> Option<String> {
        run("xdg-mime", &["query", "default", MIME]).filter(|s| !s.is_empty())
    }

    /// The desktop file we would name: the installed one, else the one an integrated AppImage owns.
    fn our_desktop() -> Option<&'static str> {
        if desktop_file(DEB_DESKTOP).is_some() {
            Some(DEB_DESKTOP)
        } else if desktop_file(APPIMAGE_DESKTOP).is_some() {
            Some(APPIMAGE_DESKTOP)
        } else {
            None
        }
    }

    pub fn status() -> DefaultAppStatus {
        let current = current_id().unwrap_or_default();
        let ours = our_desktop();
        let is_default = ours.is_some_and(|id| current == id);
        let name = desktop_file(&current)
            .and_then(|p| desktop_name(&p))
            .unwrap_or_else(|| current.clone());
        DefaultAppStatus {
            platform: "linux".into(),
            registered: ours.is_some(),
            is_default,
            current: name,
            action: "set".into(),
            offer: false,
        }
    }

    pub fn set_default(_path: Option<PathBuf>) -> Result<String> {
        let Some(id) = our_desktop() else {
            // An AppImage that was never integrated has nothing to name. Saying so is better than
            // running xdg-mime against a file that does not exist and reporting success.
            return Err(super::ApiError::io_plain(
                Path::new(APPIMAGE_DESKTOP),
                std::io::ErrorKind::NotFound,
                "no desktop entry for MarkdownAura — install the package, or integrate the AppImage with your desktop first",
            ));
        };
        run("xdg-mime", &["default", id, MIME]);
        Ok("set".into())
    }
}
