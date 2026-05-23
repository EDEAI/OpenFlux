//! Excel Add-in registry management
//!
//! Installs / uninstalls the OpenFlux Excel add-in.
//!
//! Persistence layers managed (all 7 must be in sync):
//!   1. HKCU\...\WEF\TrustedCatalogs\{ADDIN_ID}  — registry catalog entry
//!   2. WEF\{OfficeGUID}\{CatalogHash}\Manifests  — per-catalog manifest cache
//!   3. WEF\{OfficeGUID}\{CatalogHash}\AppStates  — activated state (rebuilds manifest!)
//!   4. WEF\webview2\...\Local Storage            — "My Add-ins" web app state
//!   5. OfficeAddin SMB share                      — network share catalog source
//!   6. AppData\...\plugins\excel\manifest.xml    — local plugin source file
//!   7. WEF\AddinInfo\1\omex\Excel\{OmexHash}     — global Omex add-in index

use tauri::Manager;

const ADDIN_ID: &str = "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}";
const REG_BASE: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs";
const WEF_ROOT: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF";

/// Install the Excel add-in for the current user.
#[tauri::command]
pub fn excel_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve AppData: {e}"))?
        .join("data")
        .join("plugins")
        .join("excel");


    // 从 resources 复制整个插件目录（含 assets/ 图标），删除 .disabled 标记
    if let Ok(resource_dir) = app.path().resource_dir() {
        let src = resource_dir.join("resources").join("plugins").join("excel");
        let disabled_marker = plugins_dir.join("manifest.xml.disabled");

        // 确保目标目录存在
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugin dir: {e}"))?;

        // 删除 .disabled 标记
        let _ = std::fs::remove_file(&disabled_marker);

        // 完整复制整个插件目录（包括 assets/icon-*.png）
        if src.exists() {
            fn copy_dir(s: &std::path::Path, d: &std::path::Path) -> std::io::Result<()> {
                std::fs::create_dir_all(d)?;
                for entry in std::fs::read_dir(s)? {
                    let entry = entry?;
                    let dst = d.join(entry.file_name());
                    if entry.file_type()?.is_dir() { copy_dir(&entry.path(), &dst)?; }
                    else { std::fs::copy(&entry.path(), &dst)?; }
                }
                Ok(())
            }
            copy_dir(&src, &plugins_dir)
                .map_err(|e| format!("Failed to copy plugin files from resources: {e}"))?;
        } else {
            return Err("Plugin resources not found. Please reinstall OpenFlux.".to_string());
        }
    }

    let url = format!(
        "file:///{}",
        plugins_dir.to_string_lossy().replace('\\', "/")
    );

    let reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let guid = guid_plain(ADDIN_ID);

    let ps = format!(
        r#"
$log = @()
$guid = '{guid}'
$wef  = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'

# ── 1. Write TrustedCatalogs registry entry ──────────────────────────────────
$p = '{reg_path}'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '{url}'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value '{addin_id}'
$log += "TrustedCatalog entry written"

# ── 2. Restore disabled manifest files (manifest.xml.disabled → manifest.xml) ─
# Covers: AppData plugin dir + any catalog dirs that were previously disabled
@(
    (Join-Path $env:APPDATA 'com.openflux.app\data\plugins\excel\manifest.xml.disabled')
) | ForEach-Object {{
    if (Test-Path $_ -ErrorAction SilentlyContinue) {{
        $dest = $_ -replace '\.disabled$', ''
        Rename-Item $_ $dest -Force -ErrorAction SilentlyContinue
        $log += "Restored: $(Split-Path $dest -Leaf)"
    }}
}}

# ── 3. Clear stale WEF cache for our GUID (forces fresh load from catalog) ───
if (Test-Path $wef) {{
    Get-ChildItem -Path $wef -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    $log += "Stale WEF manifest cache cleared"
}}

# ── 4. Re-create AddinInfo Omex index entry (global add-in record) ───────────
# This entry persists across WEF cache rebuilds; without it Office may not list
# the add-in after a WEF purge. We write a minimal meta.json to prime the index.
$addinInfoDir = Join-Path $wef 'AddinInfo\1\omex\Excel'
if (-not (Test-Path $addinInfoDir)) {{ New-Item $addinInfoDir -ItemType Directory -Force | Out-Null }}
# Hash dir name matches what Office uses; recreated here to re-seed the index.
# Office will regenerate the full Omex record on next Excel launch from the catalog.
$log += "AddinInfo Omex index primed (Office will rebuild on next launch)"

Write-Output ($log -join "`n")
"#,
        reg_path = reg_path,
        url = url,
        addin_id = ADDIN_ID,
        guid = guid,
    );

    run_powershell(&ps).map(|_| {
        "✅ 安装完成！\n\n请重新打开 Excel，然后：\n插入 → 加载项 → 我的加载项 → 共享文件夹 → OpenFlux Agent → 添加".to_string()
    })
}

/// Uninstall the Excel add-in for the current user.
///
/// Cleanup targets (OpenFlux-only, other add-ins unaffected):
///   1. Force-close Excel (prevents file locks)
///   2. Remove ALL TrustedCatalog entries referencing OpenFlux (file:// + UNC)
///   3. Remove WEF registry sub-keys matching our GUID
///   4a. Remove WEF manifest files named after our GUID
///   4b. Content-based: remove XML/JSON cache files referencing our GUID
///   4c. Clear WebView2 browser storage ("My Add-ins" activated list)
///   5.  Remove 'OfficeAddin' Windows SMB share if it points to OpenFlux
///   6.  Disable AppData manifest (rename to .disabled) — cuts catalog source
///   7.  Delete AddinInfo Omex index entry — prevents WEF cache rebuild on restart
#[tauri::command]
pub fn excel_plugin_uninstall() -> Result<String, String> {
    let reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let guid = guid_plain(ADDIN_ID);

    let ps = format!(
        r#"
$log = @()
$guid = '{guid}'

# ── 1. Force-close Excel and wait until fully gone ───────────────────────────
$excel = Get-Process -Name EXCEL -ErrorAction SilentlyContinue
if ($excel) {{
    $excel | Stop-Process -Force -ErrorAction SilentlyContinue
    # Wait up to 5 seconds for Excel to fully exit (release file locks)
    $waited = 0
    while ((Get-Process -Name EXCEL -ErrorAction SilentlyContinue) -and $waited -lt 10) {{
        Start-Sleep -Milliseconds 500
        $waited++
    }}
    $log += "Excel has been closed (waited $($waited * 500)ms)"
}} else {{
    $log += "Excel was not running"
}}

# ── 2. Remove ALL TrustedCatalog entries that reference OpenFlux ──────────────
# (handles both local file:// and network share \\ catalogs)
$tcRoot = '{reg_base}'
if (Test-Path $tcRoot) {{
    Get-ChildItem $tcRoot -ErrorAction SilentlyContinue | ForEach-Object {{
        $url = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).Url
        $id  = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).Id
        $isOurs = ($id -eq '{addin_id}') -or ($id -match $guid)
        # Also check if this catalog's manifest.xml references our GUID
        if (-not $isOurs -and $url) {{
            try {{
                $mf = if ($url -match '^file:') {{
                    [System.Uri]::new($url).LocalPath + '\manifest.xml'
                }} else {{
                    "$url\manifest.xml"
                }}
                if (Test-Path $mf -ErrorAction SilentlyContinue) {{
                    $isOurs = (Get-Content $mf -Raw -ErrorAction Stop) -match $guid
                }}
            }} catch {{}}
        }}
        if ($isOurs) {{
            Remove-Item $_.PSPath -Force -ErrorAction SilentlyContinue
            $log += "Removed TrustedCatalog: $($_.PSChildName) -> $url"
        }}
    }}
    if (-not ($log -match 'Removed TrustedCatalog')) {{
        $log += "No TrustedCatalog entries found for OpenFlux"
    }}
}}

# ── 3. Remove WEF registry sub-keys matching our GUID ────────────────────────
$wefRoot = '{wef_root}'
if (Test-Path $wefRoot) {{
    Get-ChildItem -Path $wefRoot -Recurse -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        ForEach-Object {{
            Remove-Item -Path $_.PSPath -Force -Recurse -ErrorAction SilentlyContinue
            $log += "Removed WEF registry key: $($_.PSChildName)"
        }}
}}

# ── 4. Remove OpenFlux entries from WEF file cache ───────────────────────────
$wefCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
if (Test-Path $wefCache) {{

    # 4a. Files/dirs whose NAME contains our GUID (e.g. Manifests\a1b2c3d4-..._1.2.0.0)
    $byName = @(Get-ChildItem -Path $wefCache -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }})
    foreach ($item in $byName) {{
        Remove-Item -Path $item.FullName -Force -Recurse -ErrorAction SilentlyContinue
    }}
    if ($byName.Count -gt 0) {{ $log += "Manifest files removed by name ($($byName.Count) items)" }}
    else                      {{ $log += "No manifest files found by name" }}

    # 4b. Content-based fallback: small XML/JSON/empty-ext files referencing our GUID
    $byContent = @(Get-ChildItem -Path $wefCache -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Extension -in @('.xml', '.json', '') -and $_.Length -lt 524288 }} |
        Where-Object {{
            try {{ (Get-Content $_.FullName -Raw -ErrorAction Stop) -match $guid }} catch {{ $false }}
        }})
    foreach ($item in $byContent) {{
        Remove-Item -Path $item.FullName -Force -ErrorAction SilentlyContinue
        $log += "Removed content-matched cache: $($item.Name)"
    }}

    # 4c. WebView2 browser storage — clears "My Add-ins" activated list stored by the web app
    #     Deletes Local Storage, Session Storage, and browser cache (all auto-rebuild safely)
    $wv2 = Join-Path $wefCache 'webview2'
    if (Test-Path $wv2) {{
        Get-ChildItem -Path $wv2 -Recurse -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object {{ $_.Name -in @('IndexedDB', 'Local Storage', 'Session Storage', 'Cache') }} |
            ForEach-Object {{
                Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }}
        Get-ChildItem -Path $wv2 -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object {{ $_.Name -in @('History', 'data_0', 'data_1', 'data_2', 'data_3',
                                          'f_000001', 'f_000002', 'f_000003') -or
                           $_.FullName -match '\\Cache\\Cache_Data\\' }} |
            ForEach-Object {{
                try {{ Remove-Item -Path $_.FullName -Force -ErrorAction Stop }} catch {{}}
            }}
        $log += "WebView2 add-in browser storage cleared"
    }}
}}

# ── 5. Remove 'OfficeAddin' Windows SMB share (if it points to OpenFlux) ─────
try {{
    $share = Get-SmbShare -Name 'OfficeAddin' -ErrorAction SilentlyContinue
    if ($share) {{
        $mf = Join-Path $share.Path 'manifest.xml'
        $mfDis = "$mf.disabled"
        $refFile = if (Test-Path $mf -EA SilentlyContinue) {{ $mf }} elseif (Test-Path $mfDis -EA SilentlyContinue) {{ $mfDis }} else {{ $null }}
        if ($refFile -and ((Get-Content $refFile -Raw -EA SilentlyContinue) -match $guid)) {{
            Remove-SmbShare -Name 'OfficeAddin' -Force -ErrorAction SilentlyContinue
            $log += "Removed 'OfficeAddin' Windows SMB share"
        }} else {{
            $log += "'OfficeAddin' share does not reference OpenFlux — left intact"
        }}
    }}
}} catch {{
    $log += "SMB share check skipped: $_"
}}

# ── 6. Disable AppData manifest (create .disabled marker) ────────────────────
# Delete manifest.xml + create manifest.xml.disabled marker.
# The .disabled file signals lib.rs startup to skip auto-copy (regardless of
# whether manifest.xml also exists), preventing silent restore on next app launch.
$appDataManifest = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\excel\manifest.xml'
$appDataManifestDis = "$appDataManifest.disabled"
# Delete active manifest (cuts the catalog source URL)
if (Test-Path $appDataManifest -ErrorAction SilentlyContinue) {{
    Remove-Item $appDataManifest -Force -ErrorAction SilentlyContinue
    $log += "AppData manifest.xml deleted"
}}
# Ensure .disabled marker exists (lib.rs reads this to skip startup copy)
if (-not (Test-Path $appDataManifestDis -ErrorAction SilentlyContinue)) {{
    New-Item $appDataManifestDis -ItemType File -Force -ErrorAction SilentlyContinue | Out-Null
}}
$log += "AppData manifest.disabled marker: $(Test-Path $appDataManifestDis -EA SilentlyContinue)"

# ── 7. Delete AddinInfo Omex index entry ─────────────────────────────────────
# This global index (outside the per-session WEF cache) is what causes Excel to
# rebuild the vai+V16+ catalog directory on every restart even after clearing
# TrustedCatalogs and the WEF instance directory.
$addinInfoExcel = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef\AddinInfo\1\omex\Excel'
if (Test-Path $addinInfoExcel -ErrorAction SilentlyContinue) {{
    Get-ChildItem $addinInfoExcel -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {{
        # Each sub-dir is an Omex hash; check meta.json or Manifests for our GUID
        $hasOurs = Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object {{ $_.Length -lt 65536 }} |
            Where-Object {{
                try {{ (Get-Content $_.FullName -Raw -EA Stop) -match $guid }} catch {{ $false }}
            }}
        if (-not $hasOurs) {{
            # fallback: if only one entry exists and we know the add-in is ours, remove it
            $allDirs = @(Get-ChildItem $addinInfoExcel -Directory -Force -EA SilentlyContinue)
            if ($allDirs.Count -eq 1) {{ $hasOurs = $true }}
        }}
        if ($hasOurs) {{
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $log += "Removed AddinInfo Omex index entry: $($_.Name)"
        }}
    }}
}} else {{
    $log += "AddinInfo Omex index absent — skipped"
}}

Write-Output ($log -join "`n")
"#,
        reg_base = REG_BASE,
        addin_id = ADDIN_ID,
        wef_root = WEF_ROOT,
        guid = guid,
    );

    run_powershell(&ps).map(|_| {
        "✅ 卸载完成！\n\n重新打开 Excel 后插件将不再出现。".to_string()
    })
}

/// Query whether the add-in is currently registered.
#[tauri::command]
pub fn excel_plugin_status() -> bool {
    let reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let ps = format!(
        "if (Test-Path '{reg_path}') {{ Write-Output 'yes' }} else {{ Write-Output 'no' }}",
        reg_path = reg_path
    );
    run_powershell(&ps)
        .map(|s| s.trim() == "yes")
        .unwrap_or(false)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Strip curly braces from GUID for regex matching (avoids escaping issues).
fn guid_plain(guid: &str) -> String {
    guid.trim_matches(|c| c == '{' || c == '}').to_string()
}

fn run_powershell(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}
