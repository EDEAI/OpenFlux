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
            if let Err(e) = std::fs::write(&ca_crt, &ca_pem) {
                eprintln!("[OpenFlux] write CA failed: {e}");
                return;
            }
            // Also write as ca.crt for compatibility with external tools
            let _ = std::fs::write(cert_dir.join("ca.crt"), &ca_pem);
            eprintln!("[OpenFlux] dev certs generated at {:?}", cert_dir);
            // NOTE: trust is NOT done here; it happens lazily in ensure_ca_trusted()
            // when the user installs an Office plugin (better UX: no password prompt on startup).
        }
        Err(e) => eprintln!("[OpenFlux] cert generation failed: {e}"),
    }
}

/// Ensure the CA cert is trusted in the system store (called at plugin-install time,
/// not at app startup, so the admin-password prompt only appears for users who
/// actually use Office plugins).
///
/// Idempotent: if the cert is already trusted, this is a no-op.
pub fn ensure_ca_trusted() {
    use std::path::PathBuf;

    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return,
    };
    let cert_dir = PathBuf::from(&home).join(".office-addin-dev-certs");

    // Prefer ca.crt (compat), fallback to openflux-ca.crt
    let ca_crt = {
        let p = cert_dir.join("ca.crt");
        if p.exists() { p } else { cert_dir.join("openflux-ca.crt") }
    };
    if !ca_crt.exists() {
        eprintln!("[OpenFlux] CA cert not found — cannot trust");
        return;
    }

    trust_ca(&ca_crt);
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

/// Install and trust the CA cert in the System keychain so that WKWebView (used
/// by macOS Office Add-ins) trusts the self-signed HTTPS server.
///
/// WKWebView only respects the **System** keychain, not the login keychain.
/// We use `osascript` to run `security` with admin privileges, which shows
/// a native macOS password dialog (no terminal sudo needed).
///
/// **Idempotent**: if the CA is already trusted in the System keychain, this
/// function returns immediately without prompting the user.
/// Falls back to login keychain if the user cancels.
#[cfg(target_os = "macos")]
fn trust_ca(ca_crt: &std::path::Path) {
    // Check if CA is already trusted in System keychain (avoid re-prompting)
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-certificate", "-c", "Developer CA for Microsoft Office", "-Z",
               "/Library/Keychains/System.keychain"])
        .output()
    {
        if output.status.success() {
            eprintln!("[OpenFlux] CA already trusted in System keychain — skipping");
            return;
        }
    }
    // Also check for the OpenFlux CA name (in case it was generated by rcgen)
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-certificate", "-c", "OpenFlux Dev Root CA", "-Z",
               "/Library/Keychains/System.keychain"])
        .output()
    {
        if output.status.success() {
            eprintln!("[OpenFlux] CA already trusted in System keychain — skipping");
            return;
        }
    }

    let crt_path = ca_crt.to_string_lossy();

    // Try System keychain first (requires admin password, shown as native dialog)
    let script = format!(
        "do shell script \"security add-trusted-cert -d -r trustRoot -p ssl \
         -k /Library/Keychains/System.keychain '{}'\" with administrator privileges",
        crt_path
    );
    let r = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output();
    match r {
        Ok(o) if o.status.success() => {
            eprintln!("[OpenFlux] CA trusted (System keychain, SSL policy)");
            return;
        }
        Ok(o) => eprintln!(
            "[OpenFlux] System keychain trust failed (user cancelled?): {}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
        Err(e) => eprintln!("[OpenFlux] osascript error: {e}"),
    }

    // Fallback: login keychain (may not work for WKWebView, but better than nothing)
    let home = std::env::var("HOME").unwrap_or_default();
    let keychain = format!("{home}/Library/Keychains/login.keychain-db");
    let r = std::process::Command::new("security")
        .args([
            "add-trusted-cert",
            "-r", "trustRoot",
            "-p", "ssl",
            "-k", &keychain,
        ])
        .arg(ca_crt)
        .output();
    match r {
        Ok(o) if o.status.success() => eprintln!("[OpenFlux] CA trusted (login keychain fallback)"),
        Ok(o) => eprintln!(
            "[OpenFlux] login keychain trust also failed: {}{}",
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

        // Dev-mode fallback: on macOS/Linux, resource_dir() in dev mode points to
        // the .app bundle inside target/debug/ which doesn't contain the plugin files.
        // Fall back to the source tree path via CARGO_MANIFEST_DIR (src-tauri/).
        #[cfg(debug_assertions)]
        let src = if src.exists() {
            src
        } else {
            let dev_src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("plugins")
                .join(sub);
            dev_src
        };

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
