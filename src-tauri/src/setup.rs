//! Application setup helpers.
//!
//! Called from the Tauri `setup` closure in `lib.rs` to keep the entry point clean.

use std::path::Path;
use tauri::{AppHandle, Manager};

/// Recursively copy `src` directory into `dst`, overwriting existing files.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Apply Windows WebView2 AppContainer loopback exemption (idempotent).
///
/// Without this, WebView2 cannot reach `127.0.0.1` on some Windows machines.
#[cfg(target_os = "windows")]
pub fn apply_loopback_exemption() {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("CheckNetIsolation.exe")
        .args(["loopbackexempt", "-a", "-n=microsoft.win32webviewhost_cw5n1h2txyewy"])
        .creation_flags(NO_WINDOW)
        .output();
    let _ = std::process::Command::new("CheckNetIsolation.exe")
        .args(["loopbackexempt", "-a", "-n=MSEdge"])
        .creation_flags(NO_WINDOW)
        .output();
    eprintln!("[OpenFlux] WebView2 loopback exemption applied");
}

/// Kill any process occupying port 18803 (dev hot-reload leftover cleanup, Windows only).
#[cfg(target_os = "windows")]
pub fn kill_dev_port_3000() {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let ps = "Get-NetTCPConnection -LocalPort 18803 -State Listen -ErrorAction SilentlyContinue \
              | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }";
    let _ = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps])
        .creation_flags(NO_WINDOW)
        .output();
}

/// Auto-copy Office plugin files from the embedded resources to AppData on every launch.
///
/// Skips a plugin if its `manifest.xml.disabled` marker is present (user uninstalled it).
/// Overwrites all plugin files to pick up version upgrades silently.
pub fn sync_office_plugins(app: &AppHandle, plugins_dir: &Path) {
    let Ok(resource_dir) = app.path().resource_dir() else { return };

    let plugins = [
        ("excel",      "Excel"),
        ("word",       "Word"),
        ("powerpoint", "PowerPoint"),
    ];

    for (sub, label) in &plugins {
        let src  = resource_dir.join("resources").join("plugins").join(sub);
        let dest = plugins_dir.join(sub);

        if !src.exists() {
            continue;
        }

        let disabled = dest.join("manifest.xml.disabled");
        if disabled.exists() {
            eprintln!("[OpenFlux] {} plugin uninstalled by user — skipping auto-copy", label);
            continue;
        }

        match copy_dir_all(&src, &dest) {
            Ok(_)  => eprintln!("[OpenFlux] {} plugin updated at {:?}", label, dest),
            Err(e) => eprintln!("[OpenFlux] Failed to update {} plugin: {}", label, e),
        }
    }
}
