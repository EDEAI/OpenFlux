//! Unified Office Add-in install / uninstall logic (shared by Excel / Word / PowerPoint).
//!
//! The three hosts differ only in parameters (GUID, process name, subdirectory,
//! share name), so all the PowerShell flow lives in this module and
//! `excel_plugin` / `word_plugin` / `powerpoint_plugin` only assemble parameters.
//!
//! ## Loading mechanism (unified)
//! 1. **WEF\Developer sideload (primary path)**: write the local path of
//!    manifest.xml into `HKCU\...\WEF\Developer`; Office auto-loads it on next
//!    launch, no manual "Add" required.
//! 2. **TrustedCatalogs + UNC share (fallback path)**: create an SMB share for
//!    the plugin directory, then register `\\localhost\<share>` as a trusted
//!    catalog for "My Add-ins -> Shared Folder".
//! 3. **dev certs**: every manifest points to `https://localhost:18803`; on
//!    install we ensure `office-addin-dev-certs` is installed, otherwise the
//!    task pane shows a blank page due to the missing certificate.
//!
//! ## Persistence layers that uninstall must clean up
//! Process lock . SMB share . TrustedCatalogs . WEF registry subkeys . WEF file
//! cache (by name + by content) . WebView2 storage . AppData manifest (writes a
//! .disabled marker) . AddinInfo Omex index . WEF\Developer sideload entry.

use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows: CREATE_NO_WINDOW — hides the PowerShell child process console window
/// to avoid a flashing cmd popup.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
const REG_BASE: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs";
#[cfg(target_os = "windows")]
const WEF_ROOT: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF";

/// Configuration for a single Office host plugin.
pub struct OfficePlugin {
    /// AppData subdirectory & manifest path fragment, e.g. `"excel"`.
    pub sub: &'static str,
    /// Add-in GUID (with braces), e.g. `"{a1b2c3d4-...}"`.
    pub addin_id: &'static str,
    /// Process name (`Stop-Process -Name`), e.g. `"EXCEL"` / `"WINWORD"` / `"POWERPNT"`.
    pub process: &'static str,
    /// App name used by WEF / Omex, e.g. `"Excel"` / `"Word"` / `"PowerPoint"`.
    pub app_label: &'static str,
    /// SMB share name, e.g. `"OpenFluxExcel"`.
    pub share: &'static str,
    /// Display name shown in prompts, e.g. `"Excel"`.
    pub display: &'static str,
    /// macOS host container Bundle ID (sideload manifest target directory),
    /// e.g. `"com.microsoft.Excel"` / `"com.microsoft.Word"` / `"com.microsoft.Powerpoint"`.
    pub mac_container: &'static str,
}

/// Strip the braces from a GUID, for regex / filename matching. (Windows only)
#[cfg(target_os = "windows")]
pub fn guid_plain(guid: &str) -> String {
    guid.trim_matches(|c| c == '{' || c == '}').to_string()
}

/// Run a PowerShell script; returns stdout on success. (Windows only)
#[cfg(target_os = "windows")]
pub fn run_powershell(script: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// Run a shell command; returns stdout on success.
/// (macOS only, used to install dev certs / quit host processes)
#[cfg(target_os = "macos")]
pub fn run_shell(cmd: &str) -> Result<String, String> {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .map_err(|e| format!("Failed to run command: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

/// macOS: sideload wef directory `~/Library/Containers/<container>/Data/Documents/wef`.
#[cfg(target_os = "macos")]
fn mac_wef_dir(plugin: &OfficePlugin) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法解析 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library/Containers")
        .join(plugin.mac_container)
        .join("Data/Documents/wef"))
}

/// macOS: sideload manifest filename (one per host).
#[cfg(target_os = "macos")]
fn mac_manifest_name(plugin: &OfficePlugin) -> String {
    format!("openflux-{}.xml", plugin.sub)
}

/// Recursively copy the contents of `src` into `dst`; existing files are overwritten.
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(&entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Resolve the plugin source directory from bundled resources
/// (also handles dev mode where resource_dir points at the project root).
fn resolve_resource_src(app: &tauri::AppHandle, sub: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let p1 = resource_dir.join("resources").join("plugins").join(sub);
    if p1.exists() {
        return Some(p1);
    }
    let p2 = resource_dir
        .join("src-tauri")
        .join("resources")
        .join("plugins")
        .join(sub);
    if p2.exists() {
        return Some(p2);
    }
    // Dev-mode fallback: CARGO_MANIFEST_DIR points to src-tauri/ at compile time,
    // so we can locate plugin files directly from the source tree when the bundled
    // resources are not present (macOS/Linux dev builds don't copy bundle resources).
    // Only enabled in debug builds to avoid leaking build-machine paths into release binaries.
    #[cfg(debug_assertions)]
    {
        let p3 = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("plugins")
            .join(sub);
        if p3.exists() {
            return Some(p3);
        }
    }
    None
}

/// Unified install: copy plugin files -> ensure certs -> create share -> register trusted catalog -> sideload.
pub fn install(app: &tauri::AppHandle, plugin: &OfficePlugin) -> Result<String, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve AppData: {e}"))?
        .join("data")
        .join("plugins")
        .join(plugin.sub);

    std::fs::create_dir_all(&plugins_dir)
        .map_err(|e| format!("Failed to create plugin dir: {e}"))?;

    // Remove the .disabled marker
    let _ = std::fs::remove_file(plugins_dir.join("manifest.xml.disabled"));

    // Copy the full plugin directory from resources (including assets/ icons)
    let dest_manifest = plugins_dir.join("manifest.xml");
    match resolve_resource_src(app, plugin.sub) {
        Some(src) => {
            copy_dir_recursive(&src, &plugins_dir)
                .map_err(|e| format!("Failed to copy plugin files from resources: {e}"))?;
        }
        None => {
            if !dest_manifest.exists() {
                return Err("Plugin resources not found. Please reinstall OpenFlux.".to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let plugins_dir_str = plugins_dir.to_string_lossy().to_string();
        let unc_url = format!(r"\\localhost\{}", plugin.share);
        let reg_path = format!("{REG_BASE}\\{}", plugin.addin_id);
        let guid = guid_plain(plugin.addin_id);

        let script = INSTALL_TEMPLATE
            .replace("@@GUID@@", &guid)
            .replace("@@ADDIN_ID@@", plugin.addin_id)
            .replace("@@PLUGIN_DIR@@", &plugins_dir_str)
            .replace("@@SHARE@@", plugin.share)
            .replace("@@UNC_URL@@", &unc_url)
            .replace("@@REG_PATH@@", &reg_path)
            .replace("@@APP_LABEL@@", plugin.app_label)
            .replace("@@WEF_ROOT@@", WEF_ROOT);

        run_powershell(&script).map(|_| {
            format!(
                "✅ 安装完成！\n\n请重新打开 {}，OpenFlux 插件将自动出现在 Home 选项卡的 Ribbon 中。",
                plugin.display
            )
        })
    }

    #[cfg(target_os = "macos")]
    {
        install_macos(plugin, &dest_manifest)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = &dest_manifest;
        Err("当前操作系统暂不支持 Office 插件安装".to_string())
    }
}

/// macOS install: sideload the manifest into the host container's wef directory
/// and ensure dev certs are generated and trusted.
#[cfg(target_os = "macos")]
fn install_macos(plugin: &OfficePlugin, src_manifest: &Path) -> Result<String, String> {
    let wef_dir = mac_wef_dir(plugin)?;
    std::fs::create_dir_all(&wef_dir)
        .map_err(|e| format!("创建 wef 旁加载目录失败：{e}"))?;

    let dest = wef_dir.join(mac_manifest_name(plugin));
    std::fs::copy(src_manifest, &dest)
        .map_err(|e| format!("复制 manifest 到 wef 目录失败：{e}"))?;

    // Ensure dev certs exist (generates if missing, fast no-op if present)
    crate::setup::ensure_dev_certs();
    // Ensure the CA is trusted in System keychain (shows password dialog on first install;
    // subsequent installs skip if already trusted — idempotent).
    crate::setup::ensure_ca_trusted();

    Ok(format!(
        "✅ 安装完成！\n\n请重新打开 {}，在「插入 → 我的加载项」中即可看到 OpenFlux 插件。",
        plugin.display
    ))
}

/// Unified uninstall.
/// Windows: kill process -> remove share/trusted catalog/registry/cache/WebView2/Omex/sideload.
/// macOS: delete the sideload manifest from the wef directory and quit the host process to force a refresh.
pub fn uninstall(plugin: &OfficePlugin) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let guid = guid_plain(plugin.addin_id);

        let script = UNINSTALL_TEMPLATE
            .replace("@@GUID@@", &guid)
            .replace("@@ADDIN_ID@@", plugin.addin_id)
            .replace("@@PROCESS@@", plugin.process)
            .replace("@@DISPLAY@@", plugin.display)
            .replace("@@SHARE@@", plugin.share)
            .replace("@@SUB@@", plugin.sub)
            .replace("@@APP_LABEL@@", plugin.app_label)
            .replace("@@REG_BASE@@", REG_BASE)
            .replace("@@WEF_ROOT@@", WEF_ROOT);

        run_powershell(&script).map(|_| {
            format!(
                "✅ 卸载完成！\n\n重新打开 {} 后插件将不再出现。",
                plugin.display
            )
        })
    }

    #[cfg(target_os = "macos")]
    {
        let wef_dir = mac_wef_dir(plugin)?;
        let target = wef_dir.join(mac_manifest_name(plugin));
        if target.exists() {
            std::fs::remove_file(&target)
                .map_err(|e| format!("删除旁加载 manifest 失败：{e}"))?;
        }
        // Quit the host process to force an add-in refresh (best-effort; ignored if not running).
        let _ = run_shell(&format!("pkill -x 'Microsoft {}'", plugin.app_label));
        Ok(format!(
            "✅ 卸载完成！\n\n重新打开 {} 后插件将不再出现。",
            plugin.display
        ))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = plugin;
        Err("当前操作系统暂不支持 Office 插件卸载".to_string())
    }
}

/// Query install status.
/// Windows: whether the trusted-catalog registry entry exists.
/// macOS: whether the sideload manifest exists in the wef directory.
pub fn status(plugin: &OfficePlugin) -> bool {
    #[cfg(target_os = "windows")]
    {
        let reg_path = format!("{REG_BASE}\\{}", plugin.addin_id);
        let script = format!(
            "if (Test-Path '{reg_path}') {{ Write-Output 'yes' }} else {{ Write-Output 'no' }}"
        );
        run_powershell(&script)
            .map(|s| s.trim() == "yes")
            .unwrap_or(false)
    }

    #[cfg(target_os = "macos")]
    {
        mac_wef_dir(plugin)
            .map(|d| d.join(mac_manifest_name(plugin)).exists())
            .unwrap_or(false)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = plugin;
        false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell templates (use @@TOKEN@@ placeholders to avoid format!'s brace-escaping hell)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
const INSTALL_TEMPLATE: &str = r#"
$ErrorActionPreference = 'Continue'
$log = @()
$guid = '@@GUID@@'
$addinId = '@@ADDIN_ID@@'
$wef = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
$pluginDir = '@@PLUGIN_DIR@@'
$manifestPath = Join-Path $pluginDir 'manifest.xml'

# 0. Ensure dev certs are installed (the manifest uses https://localhost:18803; missing cert = blank page)
$certDir  = Join-Path $env:USERPROFILE '.office-addin-dev-certs'
$certFile = Join-Path $certDir 'localhost.crt'
$keyFile  = Join-Path $certDir 'localhost.key'
if (-not ((Test-Path $certFile) -and (Test-Path $keyFile))) {
    try {
        $r = & npx --yes office-addin-dev-certs@2 install --days 3650 2>&1
        $log += "Dev certs installed: $r"
    } catch { $log += "Dev cert install failed (non-fatal): $_" }
} else { $log += "Dev certs present" }

# 1. Create SMB share (fallback directory path; non-fatal on failure, sideload still works)
& net share @@SHARE@@ /delete 2>&1 | Out-Null
$shareOut = & net share "@@SHARE@@=$pluginDir" /Grant:Everyone,READ 2>&1
$shareOk = Get-SmbShare -Name '@@SHARE@@' -EA SilentlyContinue
$log += "SMB share exists=$([bool]$shareOk)"

# 2. Register TrustedCatalog (unified UNC URL)
$p = '@@REG_PATH@@'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '@@UNC_URL@@'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value $addinId
$log += "TrustedCatalog: @@UNC_URL@@"

# 3. Remove the AppData .disabled marker (Rust already removes it once; this is a fallback)
$mfDis = "$manifestPath.disabled"
if (Test-Path $mfDis -EA SilentlyContinue) {
    Remove-Item $mfDis -Force -EA SilentlyContinue
    $log += "Removed stale .disabled marker"
}

# 4. Clear old WEF cache (force reload of the latest manifest from disk)
if (Test-Path $wef) {
    Get-ChildItem -Path $wef -Recurse -Force -EA SilentlyContinue |
        Where-Object { $_.Name -match $guid } |
        Remove-Item -Force -Recurse -EA SilentlyContinue
    $log += "Stale WEF manifest cache cleared"
}

# 5. Pre-create the AddinInfo Omex index directory
$addinInfoDir = Join-Path $wef 'AddinInfo\1\omex\@@APP_LABEL@@'
if (-not (Test-Path $addinInfoDir)) { New-Item $addinInfoDir -ItemType Directory -Force | Out-Null }
$log += "AddinInfo Omex index primed"

# 6. Tell Office this host has a registry-based add-in
$wefRoot = '@@WEF_ROOT@@'
Set-ItemProperty -Path $wefRoot -Name '@@APP_LABEL@@__HasRegistryAddin' -Value 1 -Type DWord -EA SilentlyContinue
$userId = (Get-ItemProperty $wefRoot -EA SilentlyContinue).OmexStoreUser
if ($userId) {
    Set-ItemProperty -Path $wefRoot -Name "@@APP_LABEL@@_${userId}_HasRegistryAddin" -Value 1 -Type DWord -EA SilentlyContinue
}
Set-ItemProperty -Path $wefRoot -Name '@@APP_LABEL@@OMEXRefreshPending' -Value 1 -Type DWord -EA SilentlyContinue
$refreshGuid = [System.Guid]::NewGuid().ToByteArray()
Set-ItemProperty -Path $wefRoot -Name '@@APP_LABEL@@_RequireForceRefreshAtBoot' -Value $refreshGuid -Type Binary -EA SilentlyContinue
$log += "@@APP_LABEL@@ HasRegistryAddin flags set"

# 7. WEF\Developer sideload registration (primary load mechanism, no manual "Add" needed)
$devKey = '@@WEF_ROOT@@\Developer'
if (-not (Test-Path $devKey)) { New-Item -Path $devKey -Force | Out-Null }
# Remove legacy brace-less entry (historical format)
if (Get-ItemProperty $devKey -Name $guid -EA SilentlyContinue) {
    Remove-ItemProperty -Path $devKey -Name $guid -EA SilentlyContinue
}
Set-ItemProperty -Path $devKey -Name $addinId -Value $manifestPath -Type String
$log += "Developer sideload registered: $manifestPath"

Write-Output ($log -join "`n")
"#;

#[cfg(target_os = "windows")]
const UNINSTALL_TEMPLATE: &str = r#"
$ErrorActionPreference = 'Continue'
$log = @()
$guid = '@@GUID@@'
$addinId = '@@ADDIN_ID@@'

# 1. Force-close the host process (release file locks)
$proc = Get-Process -Name @@PROCESS@@ -EA SilentlyContinue
if ($proc) {
    $proc | Stop-Process -Force -EA SilentlyContinue
    $waited = 0
    while ((Get-Process -Name @@PROCESS@@ -EA SilentlyContinue) -and $waited -lt 10) {
        Start-Sleep -Milliseconds 500; $waited++
    }
    $log += "@@DISPLAY@@ closed (waited $($waited*500)ms)"
} else { $log += "@@DISPLAY@@ was not running" }

# 2. Remove the SMB share
& net share @@SHARE@@ /delete 2>&1 | Out-Null
$log += "SMB share @@SHARE@@ removed"

# 3. Delete the TrustedCatalog entry (by Id/GUID, or matching manifest content)
$tcRoot = '@@REG_BASE@@'
if (Test-Path $tcRoot) {
    Get-ChildItem $tcRoot -EA SilentlyContinue | ForEach-Object {
        $url = (Get-ItemProperty $_.PSPath -EA SilentlyContinue).Url
        $id  = (Get-ItemProperty $_.PSPath -EA SilentlyContinue).Id
        $isOurs = ($id -eq $addinId) -or ($id -match $guid)
        if (-not $isOurs -and $url) {
            try {
                $mf = if ($url -match '^file:') { [System.Uri]::new($url).LocalPath + '\manifest.xml' }
                      elseif ($url -match '^\\\\') { "$url\manifest.xml" }
                      else { $null }
                if ($mf -and (Test-Path $mf -EA SilentlyContinue)) {
                    $isOurs = (Get-Content $mf -Raw -EA Stop) -match $guid
                }
            } catch {}
        }
        if ($isOurs) {
            Remove-Item $_.PSPath -Force -EA SilentlyContinue
            $log += "Removed TrustedCatalog: $($_.PSChildName)"
        }
    }
}

# 4. Delete WEF registry subkeys (containing the GUID)
$wefRoot = '@@WEF_ROOT@@'
if (Test-Path $wefRoot) {
    Get-ChildItem -Path $wefRoot -Recurse -EA SilentlyContinue |
        Where-Object { $_.Name -match $guid } |
        ForEach-Object {
            Remove-Item -Path $_.PSPath -Force -Recurse -EA SilentlyContinue
            $log += "Removed WEF registry key: $($_.PSChildName)"
        }
}

# 5. Clear the WEF file cache (by name + by content + WebView2)
$wefCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
if (Test-Path $wefCache) {
    $byName = @(Get-ChildItem -Path $wefCache -Recurse -Force -EA SilentlyContinue |
        Where-Object { $_.Name -match $guid })
    foreach ($item in $byName) { Remove-Item -Path $item.FullName -Force -Recurse -EA SilentlyContinue }
    $log += "WEF cache by name: $($byName.Count) items"

    $byContent = @(Get-ChildItem -Path $wefCache -Recurse -File -Force -EA SilentlyContinue |
        Where-Object { $_.Extension -in @('.xml', '.json', '') -and $_.Length -lt 524288 } |
        Where-Object { try { (Get-Content $_.FullName -Raw -EA Stop) -match $guid } catch { $false } })
    foreach ($item in $byContent) { Remove-Item -Path $item.FullName -Force -EA SilentlyContinue }
    if ($byContent.Count -gt 0) { $log += "WEF cache by content: $($byContent.Count) items" }

    # WebView2 storage — clear the "My Add-ins" activation list (it rebuilds safely on its own)
    $wv2 = Join-Path $wefCache 'webview2'
    if (Test-Path $wv2) {
        Get-ChildItem -Path $wv2 -Recurse -Directory -Force -EA SilentlyContinue |
            Where-Object { $_.Name -in @('IndexedDB', 'Local Storage', 'Session Storage', 'Cache') } |
            ForEach-Object { Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue }
        $log += "WebView2 add-in storage cleared"
    }
}

# 6. Disable the AppData manifest (delete + create a .disabled marker to block auto-restore on launch)
$mf = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\@@SUB@@\manifest.xml'
$mfDis = "$mf.disabled"
if (Test-Path $mf -EA SilentlyContinue) { Remove-Item $mf -Force -EA SilentlyContinue; $log += "manifest.xml deleted" }
if (-not (Test-Path $mfDis -EA SilentlyContinue)) { New-Item $mfDis -ItemType File -Force -EA SilentlyContinue | Out-Null }
$log += "manifest.disabled marker created"

# 7. Delete the AddinInfo Omex global index (otherwise a restart rebuilds the cache)
$omex = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef\AddinInfo\1\omex\@@APP_LABEL@@'
if (Test-Path $omex -EA SilentlyContinue) {
    Get-ChildItem $omex -Directory -Force -EA SilentlyContinue | ForEach-Object {
        $hasOurs = Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue |
            Where-Object { $_.Length -lt 65536 } |
            Where-Object { try { (Get-Content $_.FullName -Raw -EA Stop) -match $guid } catch { $false } }
        if (-not $hasOurs) {
            $allDirs = @(Get-ChildItem $omex -Directory -Force -EA SilentlyContinue)
            if ($allDirs.Count -eq 1) { $hasOurs = $true }
        }
        if ($hasOurs) {
            Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue
            $log += "Removed Omex index: $($_.Name)"
        }
    }
} else { $log += "Omex index absent" }

# 8. Delete the WEF\Developer sideload entry (by name + by value as fallback)
$devKey = '@@WEF_ROOT@@\Developer'
if (Test-Path $devKey -EA SilentlyContinue) {
    if (Get-ItemProperty $devKey -Name $addinId -EA SilentlyContinue) {
        Remove-ItemProperty -Path $devKey -Name $addinId -EA SilentlyContinue
        $log += "Removed Developer entry: $addinId"
    }
    $props = Get-ItemProperty $devKey -EA SilentlyContinue
    if ($props) {
        $props.PSObject.Properties |
            Where-Object { $_.Value -match $guid -and $_.Name -notlike 'PS*' } |
            ForEach-Object {
                Remove-ItemProperty -Path $devKey -Name $_.Name -EA SilentlyContinue
                $log += "Removed Developer entry (by value): $($_.Name)"
            }
    }
}

Write-Output ($log -join "`n")
"#;
