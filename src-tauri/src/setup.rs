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

/// Ensure local dev certs exist and are trusted (required for HTTPS 18803, the Office add-in).
///
/// Pure Rust (rcgen) offline generation of a self-signed CA + `localhost` leaf cert,
/// written to the `~/.office-addin-dev-certs/localhost.{crt,key}` paths that
/// `plugin_server` reads, then trust the CA via built-in system commands
/// (Windows: certutil; macOS: security). **No node/npx dependency, no network at runtime.**
///
/// Must complete before `plugin_server::start`, otherwise the server cannot find the
/// certs and falls back to HTTP 18802, causing the manifest's `https://localhost:18803`
/// to fail to load (add-in error / blank page).
pub fn ensure_dev_certs() {
    use std::path::PathBuf;

    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return,
    };
    let cert_dir = PathBuf::from(&home).join(".office-addin-dev-certs");
    let leaf_crt = cert_dir.join("localhost.crt");
    let leaf_key = cert_dir.join("localhost.key");
    if leaf_crt.exists() && leaf_key.exists() {
        return; // certs already exist; assume trusted (we trust them at generation time)
    }

    eprintln!("[OpenFlux] dev certs missing — generating self-signed certs (rcgen) for HTTPS 18803...");

    if let Err(e) = std::fs::create_dir_all(&cert_dir) {
        eprintln!("[OpenFlux] cannot create cert dir: {e}");
        return;
    }

    let ca_crt = cert_dir.join("openflux-ca.crt");
    match generate_dev_certs() {
        Ok((leaf_chain_pem, leaf_key_pem, ca_pem)) => {
            if let Err(e) = std::fs::write(&leaf_key, leaf_key_pem) {
                eprintln!("[OpenFlux] write key failed: {e}");
                return;
            }
            if let Err(e) = std::fs::write(&leaf_crt, leaf_chain_pem) {
                eprintln!("[OpenFlux] write cert failed: {e}");
                return;
            }
            if let Err(e) = std::fs::write(&ca_crt, ca_pem) {
                eprintln!("[OpenFlux] write CA failed: {e}");
                return;
            }
            eprintln!("[OpenFlux] dev certs generated at {:?}", cert_dir);
            trust_ca(&ca_crt);
        }
        Err(e) => eprintln!("[OpenFlux] cert generation failed: {e}"),
    }
}

/// Generate a self-signed CA + localhost leaf cert with rcgen.
/// Returns (leaf cert chain PEM [leaf + CA], leaf private key PEM, CA cert PEM).
fn generate_dev_certs() -> Result<(String, String, String), String> {
    use rcgen::{
        BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
        KeyUsagePurpose, SanType,
    };
    use std::net::Ipv4Addr;

    // ── Self-signed CA ─────────────────────────────────────────────────────────
    let ca_key = KeyPair::generate().map_err(|e| format!("CA key: {e}"))?;
    let mut ca_params =
        CertificateParams::new(Vec::<String>::new()).map_err(|e| format!("CA params: {e}"))?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "OpenFlux Dev Root CA");
    ca_params
        .distinguished_name
        .push(DnType::OrganizationName, "OpenFlux");
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|e| format!("CA self_signed: {e}"))?;

    // ── localhost leaf cert (issued by the CA) ──────────────────────────────────
    let leaf_key = KeyPair::generate().map_err(|e| format!("leaf key: {e}"))?;
    let mut leaf_params = CertificateParams::new(vec!["localhost".to_string()])
        .map_err(|e| format!("leaf params: {e}"))?;
    leaf_params
        .distinguished_name
        .push(DnType::CommonName, "localhost");
    leaf_params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().map_err(|_| "san dns".to_string())?),
        SanType::IpAddress(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)),
    ];
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key)
        .map_err(|e| format!("leaf signed_by: {e}"))?;

    let ca_pem = ca_cert.pem();
    // Leaf cert chain: leaf + CA (plugin_server sends the full chain to the client)
    let leaf_chain_pem = format!("{}\n{}", leaf_cert.pem(), ca_pem);
    let leaf_key_pem = leaf_key.serialize_pem();

    Ok((leaf_chain_pem, leaf_key_pem, ca_pem))
}

/// Install the CA cert into the system trust store (a one-time system confirmation
/// dialog may appear on first run; no admin required).
#[cfg(target_os = "windows")]
fn trust_ca(ca_crt: &std::path::Path) {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    // Install into "CurrentUser Trusted Root"; WebView2 uses the system cert store -> auto-trusted.
    let r = std::process::Command::new("certutil")
        .args(["-user", "-addstore", "Root"])
        .arg(ca_crt)
        .creation_flags(NO_WINDOW)
        .output();
    match r {
        Ok(o) if o.status.success() => eprintln!("[OpenFlux] CA trusted (CurrentUser\\Root)"),
        Ok(o) => eprintln!(
            "[OpenFlux] certutil add failed: {}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => eprintln!("[OpenFlux] certutil error: {e}"),
    }
}

/// Install and trust the CA cert in the login keychain (WKWebView uses the keychain
/// -> auto-trusted; a password prompt may appear).
#[cfg(target_os = "macos")]
fn trust_ca(ca_crt: &std::path::Path) {
    let home = std::env::var("HOME").unwrap_or_default();
    let keychain = format!("{home}/Library/Keychains/login.keychain-db");
    let r = std::process::Command::new("security")
        .args(["add-trusted-cert", "-r", "trustRoot", "-k", &keychain])
        .arg(ca_crt)
        .output();
    match r {
        Ok(o) if o.status.success() => eprintln!("[OpenFlux] CA trusted (login keychain)"),
        Ok(o) => eprintln!(
            "[OpenFlux] security add-trusted-cert failed: {}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => eprintln!("[OpenFlux] security error: {e}"),
    }
}

/// Other platforms: only generate certs, no trust step (dev only).
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn trust_ca(_ca_crt: &std::path::Path) {
    eprintln!("[OpenFlux] CA trust skipped (unsupported platform)");
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
