//! Word Add-in registry management (mirrors excel_plugin.rs)
use tauri::Manager;

const ADDIN_ID: &str = "{c3d4e5f6-a7b8-9012-cdef-123456789012}";
const REG_BASE: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs";
const WEF_ROOT: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF";

#[tauri::command]
pub fn word_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve AppData: {e}"))?
        .join("data")
        .join("plugins")
        .join("word");

    // Auto-create the plugin directory and copy files from resources if needed
    if let Ok(resource_dir) = app.path().resource_dir() {
        let src = resource_dir.join("resources").join("plugins").join("word");
        let disabled = plugins_dir.join("manifest.xml.disabled");
        let dest_manifest = plugins_dir.join("manifest.xml");

        // Ensure directory exists
        if !plugins_dir.exists() {
            std::fs::create_dir_all(&plugins_dir)
                .map_err(|e| format!("Failed to create plugin dir: {e}"))?;
        }

        // Delete .disabled marker (if any)
        let _ = std::fs::remove_file(&disabled);

        // Copy all plugin files from resources
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
                .map_err(|e| format!("Failed to copy plugin files: {e}"))?;
        } else if !dest_manifest.exists() {
            return Err("Plugin resources not found. Please reinstall OpenFlux.".to_string());
        }
    } else {
        if !plugins_dir.exists() {
            return Err(format!(
                "Plugin folder not found: {}. Please restart OpenFlux first.",
                plugins_dir.display()
            ));
        }
        // Even without resource_dir, remove the .disabled marker
        let _ = std::fs::remove_file(plugins_dir.join("manifest.xml.disabled"));
    }

    // Word uses UNC (SMB) shared folder catalog - same discovery mechanism as Excel's file:// catalog.
    // We create a Windows file share "OpenFluxWord" pointing to the plugin directory,
    // then register the UNC path \\localhost\OpenFluxWord as a TrustedCatalog.
    let unc_url = r"\\localhost\OpenFluxWord".to_string();
    let plugins_dir_str = plugins_dir.to_string_lossy().to_string();
    let reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let guid = guid_plain(ADDIN_ID);

    let ps = format!(
        r#"
$ErrorActionPreference = 'Continue'
$log = @()
$guid = '{guid}'
$wef  = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
$pluginDir = '{plugins_dir}'

# 1. Create SMB file share (required for Word to treat catalog as "Shared Folder" type)
#    Without this, https:// URLs are treated as "SharePoint" type and do NOT scan for manifest.xml.
& net share OpenFluxWord /delete 2>&1 | Out-Null
$shareOut = & net share "OpenFluxWord=$pluginDir" /Grant:Everyone,READ 2>&1
$shareOk = Get-SmbShare -Name 'OpenFluxWord' -EA SilentlyContinue
$log += "SMB share exists=$([ bool]$shareOk): $($shareOut -join ' ')"

# 2. Register TrustedCatalog with UNC URL (Word recognizes \\server\share as Shared Folder)
$p = '{reg_path}'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '{unc_url}'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value '{addin_id}'
$regUrl = (Get-ItemProperty $p -EA SilentlyContinue).Url
$log += "TrustedCatalog URL=$regUrl"

# 3. Remove .disabled marker in AppData (safety net, Rust already did this)
$mfDis = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\word\manifest.xml.disabled'
if (Test-Path $mfDis -EA SilentlyContinue) {{
    Remove-Item $mfDis -Force -EA SilentlyContinue
    $log += "Removed stale .disabled marker"
}}

# 4. Clear stale WEF cache for our GUID (forces fresh manifest scan)
if (Test-Path $wef) {{
    Get-ChildItem -Path $wef -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    $log += "Stale WEF manifest cache cleared"
}}

# 5. Prime AddinInfo Omex index for Word
$addinInfoDir = Join-Path $wef 'AddinInfo\1\omex\Word'
if (-not (Test-Path $addinInfoDir)) {{ New-Item $addinInfoDir -ItemType Directory -Force | Out-Null }}
$log += "AddinInfo Omex index primed for Word"

# 6. Tell Office that Word has registry-based add-ins
$wefRoot = 'HKCU:\Software\Microsoft\Office\16.0\WEF'
Set-ItemProperty -Path $wefRoot -Name 'Word__HasRegistryAddin' -Value 1 -Type DWord -EA SilentlyContinue
$userId = (Get-ItemProperty $wefRoot -EA SilentlyContinue).OmexStoreUser
if ($userId) {{
    Set-ItemProperty -Path $wefRoot -Name "Word_${{userId}}_HasRegistryAddin" -Value 1 -Type DWord -EA SilentlyContinue
    $log += "Set Word_${{userId}}_HasRegistryAddin = 1"
}}
Set-ItemProperty -Path $wefRoot -Name 'WordOMEXRefreshPending' -Value 1 -Type DWord -EA SilentlyContinue
$refreshGuid = [System.Guid]::NewGuid().ToByteArray()
Set-ItemProperty -Path $wefRoot -Name 'Word_RequireForceRefreshAtBoot' -Value $refreshGuid -Type Binary -EA SilentlyContinue
$log += "Word WEF HasRegistryAddin flags set"

Write-Output ($log -join "`n")
"#,
        reg_path = reg_path,
        plugins_dir = plugins_dir_str,
        unc_url = unc_url,
        addin_id = ADDIN_ID,
        guid = guid,
    );

    run_powershell(&ps).map(|log| {
        format!("✅ 安装完成！\n\n{log}\n\n请重新打开 Word，然后：\n插入 → 加载项 → 我的加载项 → 更多加载项 → 共享文件夹 → OpenFlux Agent → 添加")
    })
}

#[tauri::command]
pub fn word_plugin_uninstall() -> Result<String, String> {
    let _reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let guid = guid_plain(ADDIN_ID);

    let ps = format!(
        r#"
$log = @()
$guid = '{guid}'

# 1. Force-close Word
$word = Get-Process -Name WINWORD -ErrorAction SilentlyContinue
if ($word) {{
    $word | Stop-Process -Force -ErrorAction SilentlyContinue
    $waited = 0
    while ((Get-Process -Name WINWORD -ErrorAction SilentlyContinue) -and $waited -lt 10) {{
        Start-Sleep -Milliseconds 500; $waited++
    }}
    $log += "Word closed (waited $($waited*500)ms)"
}} else {{ $log += "Word was not running" }}

# 2. Remove SMB file share
net share OpenFluxWord /delete 2>&1 | Out-Null
$log += "SMB share OpenFluxWord removed"

# 3. Remove TrustedCatalog entries referencing OpenFlux Word plugin
$tcRoot = '{reg_base}'
if (Test-Path $tcRoot) {{
    Get-ChildItem $tcRoot -ErrorAction SilentlyContinue | ForEach-Object {{
        $id = (Get-ItemProperty $_.PSPath -EA SilentlyContinue).Id
        if ($id -eq '{addin_id}' -or $id -match $guid) {{
            Remove-Item $_.PSPath -Force -EA SilentlyContinue
            $log += "Removed TrustedCatalog: $($_.PSChildName)"
        }}
    }}
}}

# 3. Remove WEF registry sub-keys matching our GUID
if (Test-Path '{wef_root}') {{
    Get-ChildItem -Path '{wef_root}' -Recurse -EA SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        ForEach-Object {{ Remove-Item -Path $_.PSPath -Force -Recurse -EA SilentlyContinue; $log += "Removed WEF key: $($_.PSChildName)" }}
}}

# 4. Clear WEF file cache
$wefCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
if (Test-Path $wefCache) {{
    Get-ChildItem -Path $wefCache -Recurse -Force -EA SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        ForEach-Object {{ Remove-Item $_.FullName -Force -Recurse -EA SilentlyContinue }}
    $log += "WEF file cache cleared"
}}

# 5. Disable AppData manifest
$mf = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\word\manifest.xml'
$mfDis = "$mf.disabled"
if (Test-Path $mf -EA SilentlyContinue) {{ Remove-Item $mf -Force -EA SilentlyContinue; $log += "manifest.xml deleted" }}
if (-not (Test-Path $mfDis -EA SilentlyContinue)) {{ New-Item $mfDis -ItemType File -Force -EA SilentlyContinue | Out-Null }}
$log += "manifest.disabled marker created"

# 6. Delete AddinInfo Omex index
$omex = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef\AddinInfo\1\omex\Word'
if (Test-Path $omex -EA SilentlyContinue) {{
    Get-ChildItem $omex -Directory -Force -EA SilentlyContinue | ForEach-Object {{
        $hasOurs = Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue |
            Where-Object {{ $_.Length -lt 65536 }} |
            Where-Object {{ try {{ (Get-Content $_.FullName -Raw -EA Stop) -match $guid }} catch {{ $false }} }}
        if ($hasOurs) {{ Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue; $log += "Removed Omex index: $($_.Name)" }}
    }}
}} else {{ $log += "Omex index absent" }}

Write-Output ($log -join "`n")
"#,
        reg_base = REG_BASE,
        addin_id = ADDIN_ID,
        wef_root = WEF_ROOT,
        guid = guid,
    );

    run_powershell(&ps).map(|_| {
        "✅ 卸载完成！\n\n重新打开 Word 后插件将不再出现。".to_string()
    })
}

#[tauri::command]
pub fn word_plugin_status() -> bool {
    let reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let ps = format!(
        "if (Test-Path '{reg_path}') {{ Write-Output 'yes' }} else {{ Write-Output 'no' }}",
        reg_path = reg_path
    );
    run_powershell(&ps)
        .map(|s| s.trim() == "yes")
        .unwrap_or(false)
}

fn guid_plain(guid: &str) -> String {
    guid.trim_matches(|c| c == '{' || c == '}').to_string()
}

fn run_powershell(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}
