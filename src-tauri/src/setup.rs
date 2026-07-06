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
        if cert_is_currently_valid(&leaf_crt) {
            return; // 证书存在且当前有效；信任在生成/安装时已完成
        }
        eprintln!("[OpenFlux] dev cert expired or invalid — regenerating for HTTPS 18803...");
    } else {
        eprintln!("[OpenFlux] dev certs missing — generating self-signed certs (rcgen) for HTTPS 18803...");
    }

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

/// 检查 PEM 证书链中的首个证书当前是否有效（未过期且已生效）。
/// 解析失败或已过期均返回 false，触发重新生成。
fn cert_is_currently_valid(crt_path: &Path) -> bool {
    let Ok(pem_bytes) = std::fs::read(crt_path) else {
        return false;
    };
    for pem in x509_parser::pem::Pem::iter_from_buffer(&pem_bytes) {
        let Ok(pem) = pem else { continue };
        if let Ok(cert) = pem.parse_x509() {
            return cert.validity().is_valid();
        }
    }
    false
}

/// Ensure the CA cert is trusted in the system store (called at plugin-install time,
/// not at app startup, so the admin-password prompt only appears for users who
/// actually use Office plugins).
///
/// Idempotent: if the cert is already trusted, this is a no-op.
///
/// Returns `true` when the CA is (already or now) trusted; `false` when trust
/// could not be established (e.g. the user declined the system confirmation
/// dialog) — callers should surface a warning to the user in that case.
pub fn ensure_ca_trusted() -> bool {
    use std::path::PathBuf;

    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let cert_dir = PathBuf::from(&home).join(".office-addin-dev-certs");

    // Prefer ca.crt (compat), fallback to openflux-ca.crt
    let ca_crt = {
        let p = cert_dir.join("ca.crt");
        if p.exists() { p } else { cert_dir.join("openflux-ca.crt") }
    };
    if !ca_crt.exists() {
        // 老机器上的证书可能来自 npx office-addin-dev-certs（无 ca.crt 落盘），
        // 其 CA 在生成时已被信任，这里视为成功，避免误报警告。
        eprintln!("[OpenFlux] CA cert file not found — assuming externally-managed trust");
        return true;
    }

    trust_ca(&ca_crt)
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
    // 明确设置 10 年有效期，避免依赖 rcgen 默认值导致证书过期（WebView2 会拒绝过期证书）。
    ca_params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    ca_params.not_after = rcgen::date_time_ymd(2034, 1, 1);
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
    leaf_params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    leaf_params.not_after = rcgen::date_time_ymd(2034, 1, 1);
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
/// dialog may appear on first run; no admin required). Returns whether the CA is trusted.
#[cfg(target_os = "windows")]
fn trust_ca(ca_crt: &std::path::Path) -> bool {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;

    // 单次 PowerShell 完成"按指纹查 CurrentUser\Root + 未信任则 certutil 导入"：
    // - 指纹命中直接跳过，避免每次开启插件都弹系统确认框
    //   （按名称检查不可靠：证书重新生成后 Subject 相同但指纹已变）；
    // - 合并为一个子进程，低配设备上少一次 PowerShell 冷启动。
    // WebView2 读系统证书库，导入 CurrentUser\Root 即被信任。
    let ca_path = ca_crt.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 '{ca_path}'; \
         if (Get-ChildItem Cert:\\CurrentUser\\Root -EA SilentlyContinue | Where-Object {{ $_.Thumbprint -eq $ca.Thumbprint }}) {{ 'already-trusted' }} \
         else {{ & certutil -user -addstore Root '{ca_path}' | Out-Null; if ($LASTEXITCODE -eq 0) {{ 'trusted' }} else {{ 'failed' }} }}"
    );
    let r = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(NO_WINDOW)
        .output();
    match r {
        Ok(o) if o.status.success() => {
            let out = String::from_utf8_lossy(&o.stdout);
            let verdict = out.trim();
            match verdict {
                "already-trusted" => {
                    eprintln!("[OpenFlux] CA already trusted (CurrentUser\\Root) — skipping");
                    true
                }
                "trusted" => {
                    eprintln!("[OpenFlux] CA trusted (CurrentUser\\Root)");
                    true
                }
                _ => {
                    eprintln!("[OpenFlux] certutil add failed (user declined?): {verdict}");
                    false
                }
            }
        }
        Ok(o) => {
            eprintln!(
                "[OpenFlux] trust script failed: {}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            false
        }
        Err(e) => {
            eprintln!("[OpenFlux] powershell error: {e}");
            false
        }
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
fn trust_ca(ca_crt: &std::path::Path) -> bool {
    // Check if CA is already trusted in System keychain (avoid re-prompting)
    if let Ok(output) = std::process::Command::new("security")
        .args(["find-certificate", "-c", "Developer CA for Microsoft Office", "-Z",
               "/Library/Keychains/System.keychain"])
        .output()
    {
        if output.status.success() {
            eprintln!("[OpenFlux] CA already trusted in System keychain — skipping");
            return true;
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
            return true;
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
            return true;
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
        Ok(o) if o.status.success() => {
            eprintln!("[OpenFlux] CA trusted (login keychain fallback)");
            true
        }
        Ok(o) => {
            eprintln!(
                "[OpenFlux] login keychain trust also failed: {}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            false
        }
        Err(e) => {
            eprintln!("[OpenFlux] security error: {e}");
            false
        }
    }
}


/// Other platforms: only generate certs, no trust step (dev only).
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn trust_ca(_ca_crt: &std::path::Path) -> bool {
    eprintln!("[OpenFlux] CA trust skipped (unsupported platform)");
    false
}

/// Auto-copy Office plugin files from the embedded resources to AppData on every launch.
///
/// Skips a plugin if its `manifest.xml.disabled` marker is present (user uninstalled it).
/// Overwrites all plugin files to pick up version upgrades silently.
pub fn sync_office_plugins(app: &AppHandle, plugins_dir: &Path) {
    let Ok(resource_dir) = app.path().resource_dir() else { return };

    // (subdir, label, disabled-marker filename)
    // Office add-ins use `manifest.xml.disabled`; the Chrome extension uses a plain `.disabled` marker.
    let plugins = [
        ("excel",      "Excel",      "manifest.xml.disabled"),
        ("word",       "Word",       "manifest.xml.disabled"),
        ("powerpoint", "PowerPoint", "manifest.xml.disabled"),
        ("chrome",     "Chrome",     ".disabled"),
    ];

    for (sub, label, marker) in &plugins {
        let src  = resource_dir.join("resources").join("plugins").join(sub);

        // Dev-mode：优先使用源码树 src-tauri/resources（CARGO_MANIFEST_DIR）作为同步源。
        // 否则会用 target/debug/resources 下由 cargo 构建期拷贝的【旧副本】，导致直接编辑
        // src-tauri/resources/plugins 后不重新 cargo build 就"改了不生效"（多副本漂移的根源）。
        // 这样 debug 下只需编辑 src-tauri/resources + 重启应用即可生效，无需 cargo 重建资源。
        #[cfg(debug_assertions)]
        let src = {
            let dev_src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("plugins")
                .join(sub);
            if dev_src.exists() { dev_src } else { src }
        };

        let dest = plugins_dir.join(sub);

        if !src.exists() {
            continue;
        }

        let disabled = dest.join(marker);
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
