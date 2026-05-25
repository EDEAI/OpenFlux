//! PowerPoint Add-in registry management (mirrors word_plugin.rs)
use tauri::Manager;

const ADDIN_ID: &str = "{e5f6a7b8-c9d0-1234-ef01-234567890123}";
const REG_BASE: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs";
const WEF_ROOT: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF";

#[tauri::command]
pub fn ppt_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    let plugins_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve AppData: {e}"))?
        .join("data")
        .join("plugins")
        .join("powerpoint");

    // Auto-create the plugin directory and copy files from resources if needed
    let src = if let Ok(resource_dir) = app.path().resource_dir() {
        // Try standard path first, then fallback to src-tauri/resources (dev mode)
        let p1 = resource_dir.join("resources").join("plugins").join("powerpoint");
        if p1.exists() {
            Some(p1)
        } else {
            // Dev mode: resource_dir might be project root, try src-tauri subdir
            let p2 = resource_dir.join("src-tauri").join("resources").join("plugins").join("powerpoint");
            if p2.exists() { Some(p2) } else { None }
        }
    } else {
        None
    };

    // Ensure directory exists
    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create plugin dir: {e}"))?;
    }

    // Delete .disabled marker (if any)
    let _ = std::fs::remove_file(plugins_dir.join("manifest.xml.disabled"));

    let dest_manifest = plugins_dir.join("manifest.xml");
    if let Some(ref s) = src {
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
        copy_dir(s, &plugins_dir)
            .map_err(|e| format!("Failed to copy plugin files: {e}"))?;
    } else if !dest_manifest.exists() {
        return Err("Plugin resources not found. Please reinstall OpenFlux.".to_string());
    }

    // PowerPoint uses UNC (SMB) shared folder catalog — same mechanism as Word.
    let unc_url = r"\\localhost\OpenFluxPPT".to_string();
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

# 1. Create SMB file share (required for PowerPoint to treat catalog as "Shared Folder" type)
& net share OpenFluxPPT /delete 2>&1 | Out-Null
$shareOut = & net share "OpenFluxPPT=$pluginDir" /Grant:Everyone,READ 2>&1
$shareOk = Get-SmbShare -Name 'OpenFluxPPT' -EA SilentlyContinue
$log += "SMB share exists=$([bool]$shareOk): $($shareOut -join ' ')"

# 2. Register TrustedCatalog with UNC URL
$p = '{reg_path}'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '{unc_url}'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value '{addin_id}'
$regUrl = (Get-ItemProperty $p -EA SilentlyContinue).Url
$log += "TrustedCatalog URL=$regUrl"

# 3. Remove .disabled marker in AppData
$mfDis = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\powerpoint\manifest.xml.disabled'
if (Test-Path $mfDis -EA SilentlyContinue) {{
    Remove-Item $mfDis -Force -EA SilentlyContinue
    $log += "Removed stale .disabled marker"
}}

# 4. Clear stale WEF cache for our GUID
if (Test-Path $wef) {{
    Get-ChildItem -Path $wef -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    $log += "Stale WEF manifest cache cleared"
}}

# 5. Prime AddinInfo Omex index for PowerPoint
$addinInfoDir = Join-Path $wef 'AddinInfo\1\omex\PowerPoint'
if (-not (Test-Path $addinInfoDir)) {{ New-Item $addinInfoDir -ItemType Directory -Force | Out-Null }}
$log += "AddinInfo Omex index primed for PowerPoint"

# 6. Tell Office that PowerPoint has registry-based add-ins
$wefRoot = 'HKCU:\Software\Microsoft\Office\16.0\WEF'
Set-ItemProperty -Path $wefRoot -Name 'PowerPoint__HasRegistryAddin' -Value 1 -Type DWord -EA SilentlyContinue
$userId = (Get-ItemProperty $wefRoot -EA SilentlyContinue).OmexStoreUser
if ($userId) {{
    Set-ItemProperty -Path $wefRoot -Name "PowerPoint_${{userId}}_HasRegistryAddin" -Value 1 -Type DWord -EA SilentlyContinue
    $log += "Set PowerPoint_${{userId}}_HasRegistryAddin = 1"
}}
Set-ItemProperty -Path $wefRoot -Name 'PowerPointOMEXRefreshPending' -Value 1 -Type DWord -EA SilentlyContinue
$refreshGuid = [System.Guid]::NewGuid().ToByteArray()
Set-ItemProperty -Path $wefRoot -Name 'PowerPoint_RequireForceRefreshAtBoot' -Value $refreshGuid -Type Binary -EA SilentlyContinue
$log += "PowerPoint WEF HasRegistryAddin flags set"

Write-Output ($log -join "`n")
"#,
        reg_path = reg_path,
        plugins_dir = plugins_dir_str,
        unc_url = unc_url,
        addin_id = ADDIN_ID,
        guid = guid,
    );

    run_powershell(&ps).map(|log| {
        format!("✅ 安装完成！\n\n{log}\n\n请重新打开 PowerPoint，然后：\n插入 → 加载项 → 我的加载项 → 更多加载项 → 共享文件夹 → OpenFlux Agent → 添加")
    })
}

#[tauri::command]
pub fn ppt_plugin_uninstall() -> Result<String, String> {
    let _reg_path = format!("{REG_BASE}\\{ADDIN_ID}");
    let guid = guid_plain(ADDIN_ID);

    let ps = format!(
        r#"
$log = @()
$guid = '{guid}'

# 1. Force-close PowerPoint
$ppt = Get-Process -Name POWERPNT -ErrorAction SilentlyContinue
if ($ppt) {{
    $ppt | Stop-Process -Force -ErrorAction SilentlyContinue
    $waited = 0
    while ((Get-Process -Name POWERPNT -ErrorAction SilentlyContinue) -and $waited -lt 10) {{
        Start-Sleep -Milliseconds 500; $waited++
    }}
    $log += "PowerPoint closed (waited $($waited*500)ms)"
}} else {{ $log += "PowerPoint was not running" }}

# 2. Remove SMB file share
net share OpenFluxPPT /delete 2>&1 | Out-Null
$log += "SMB share OpenFluxPPT removed"

# 3. Remove TrustedCatalog entries referencing OpenFlux PowerPoint plugin
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

# 4. Remove WEF registry sub-keys matching our GUID
if (Test-Path '{wef_root}') {{
    Get-ChildItem -Path '{wef_root}' -Recurse -EA SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        ForEach-Object {{ Remove-Item -Path $_.PSPath -Force -Recurse -EA SilentlyContinue; $log += "Removed WEF key: $($_.PSChildName)" }}
}}

# 5. Clear WEF file cache
$wefCache = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'
if (Test-Path $wefCache) {{
    Get-ChildItem -Path $wefCache -Recurse -Force -EA SilentlyContinue |
        Where-Object {{ $_.Name -match $guid }} |
        ForEach-Object {{ Remove-Item $_.FullName -Force -Recurse -EA SilentlyContinue }}
    $log += "WEF file cache cleared"
}}

# 6. Disable AppData manifest
$mf = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\powerpoint\manifest.xml'
$mfDis = "$mf.disabled"
if (Test-Path $mf -EA SilentlyContinue) {{ Remove-Item $mf -Force -EA SilentlyContinue; $log += "manifest.xml deleted" }}
if (-not (Test-Path $mfDis -EA SilentlyContinue)) {{ New-Item $mfDis -ItemType File -Force -EA SilentlyContinue | Out-Null }}
$log += "manifest.disabled marker created"

# 7. Delete AddinInfo Omex index
$omex = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef\AddinInfo\1\omex\PowerPoint'
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
        "✅ 卸载完成！\n\n重新打开 PowerPoint 后插件将不再出现。".to_string()
    })
}

#[tauri::command]
pub fn ppt_plugin_status() -> bool {
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
