//! Office Add-in 统一安装 / 卸载逻辑（Excel / Word / PowerPoint 共用）
//!
//! 三个宿主只是参数不同（GUID、进程名、子目录、共享名），因此把全部
//! PowerShell 流程下沉到本模块，`excel_plugin` / `word_plugin` /
//! `powerpoint_plugin` 仅做参数装配。
//!
//! ## 加载机制（统一）
//! 1. **WEF\Developer 旁加载（主路径）**：把 manifest.xml 的本地路径写入
//!    `HKCU\...\WEF\Developer`，Office 下次启动自动加载，无需手动「添加」。
//! 2. **TrustedCatalogs + UNC 共享（备用路径）**：为插件目录创建 SMB 共享，
//!    再以 `\\localhost\<share>` 注册可信目录，供「我的加载项 → 共享文件夹」使用。
//! 3. **dev 证书**：manifest 全部走 `https://localhost:18803`，安装时确保
//!    `office-addin-dev-certs` 已安装，否则任务窗格会因证书缺失而白屏。
//!
//! ## 卸载需要同步清理的持久化层
//! 进程锁 · SMB 共享 · TrustedCatalogs · WEF 注册表子键 · WEF 文件缓存
//! （按名 + 按内容）· WebView2 存储 · AppData manifest（写 .disabled 标记）
//! · AddinInfo Omex 索引 · WEF\Developer 旁加载条目。

use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows: CREATE_NO_WINDOW —— 隐藏 PowerShell 子进程的控制台窗口，避免弹出 cmd 闪窗。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
const REG_BASE: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs";
#[cfg(target_os = "windows")]
const WEF_ROOT: &str = r"HKCU:\Software\Microsoft\Office\16.0\WEF";

/// 单个 Office 宿主插件的配置。
pub struct OfficePlugin {
    /// AppData 子目录 & manifest 路径片段，如 `"excel"`。
    pub sub: &'static str,
    /// Add-in GUID（含花括号），如 `"{a1b2c3d4-...}"`。
    pub addin_id: &'static str,
    /// 进程名（`Stop-Process -Name`），如 `"EXCEL"` / `"WINWORD"` / `"POWERPNT"`。
    pub process: &'static str,
    /// WEF / Omex 使用的应用名，如 `"Excel"` / `"Word"` / `"PowerPoint"`。
    pub app_label: &'static str,
    /// SMB 共享名，如 `"OpenFluxExcel"`。
    pub share: &'static str,
    /// 提示语展示名，如 `"Excel"`。
    pub display: &'static str,
    /// macOS 宿主容器 Bundle ID（旁加载 manifest 落地目录），
    /// 如 `"com.microsoft.Excel"` / `"com.microsoft.Word"` / `"com.microsoft.Powerpoint"`。
    pub mac_container: &'static str,
}

/// 去掉 GUID 的花括号，用于正则 / 文件名匹配。（仅 Windows）
#[cfg(target_os = "windows")]
pub fn guid_plain(guid: &str) -> String {
    guid.trim_matches(|c| c == '{' || c == '}').to_string()
}

/// 执行 PowerShell 脚本，成功返回 stdout。（仅 Windows）
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

/// 执行 shell 命令，成功返回 stdout。（仅 macOS，用于安装 dev 证书 / 退出宿主进程）
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

/// macOS：旁加载 wef 目录 `~/Library/Containers/<container>/Data/Documents/wef`。
#[cfg(target_os = "macos")]
fn mac_wef_dir(plugin: &OfficePlugin) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法解析 HOME 环境变量".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library/Containers")
        .join(plugin.mac_container)
        .join("Data/Documents/wef"))
}

/// macOS：旁加载 manifest 文件名（每个宿主独立）。
#[cfg(target_os = "macos")]
fn mac_manifest_name(plugin: &OfficePlugin) -> String {
    format!("openflux-{}.xml", plugin.sub)
}

/// 递归复制 `src` 内容到 `dst`，已存在文件会被覆盖。
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

/// 解析打包资源中的插件源目录（兼容 dev 模式 resource_dir 指向项目根）。
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
        Some(p2)
    } else {
        None
    }
}

/// 统一安装：复制插件文件 → 确保证书 → 建共享 → 注册可信目录 → 旁加载。
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

    // 删除 .disabled 标记
    let _ = std::fs::remove_file(plugins_dir.join("manifest.xml.disabled"));

    // 从 resources 复制完整插件目录（含 assets/ 图标）
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

/// macOS 安装：把 manifest 旁加载到宿主容器的 wef 目录，并尝试安装 dev 证书。
#[cfg(target_os = "macos")]
fn install_macos(plugin: &OfficePlugin, src_manifest: &Path) -> Result<String, String> {
    let wef_dir = mac_wef_dir(plugin)?;
    std::fs::create_dir_all(&wef_dir)
        .map_err(|e| format!("创建 wef 旁加载目录失败：{e}"))?;

    let dest = wef_dir.join(mac_manifest_name(plugin));
    std::fs::copy(src_manifest, &dest)
        .map_err(|e| format!("复制 manifest 到 wef 目录失败：{e}"))?;

    // 确保 dev 证书已安装（manifest 走 https://localhost:18803，缺证书会白屏）。
    // 失败不致命：用户可能已装过，或稍后手动信任证书。
    let _ = run_shell("npx --yes office-addin-dev-certs@2 install --days 3650 2>&1");

    Ok(format!(
        "✅ 安装完成！\n\n请重新打开 {}，在「插入 → 我的加载项」中即可看到 OpenFlux 插件。",
        plugin.display
    ))
}

/// 统一卸载。
/// Windows：关进程 → 删共享/可信目录/注册表/缓存/WebView2/Omex/旁加载。
/// macOS：删除 wef 目录中的旁加载 manifest，并退出宿主进程强制刷新。
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
        // 退出宿主进程以强制刷新加载项（best-effort，未运行则忽略）。
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

/// 查询安装状态。
/// Windows：可信目录注册表项是否存在。
/// macOS：wef 目录中的旁加载 manifest 是否存在。
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
// PowerShell 模板（用 @@TOKEN@@ 占位，避免 format! 的花括号转义地狱）
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

# 0. 确保 dev 证书已安装（manifest 走 https://localhost:18803，缺证书会白屏）
$certDir  = Join-Path $env:USERPROFILE '.office-addin-dev-certs'
$certFile = Join-Path $certDir 'localhost.crt'
$keyFile  = Join-Path $certDir 'localhost.key'
if (-not ((Test-Path $certFile) -and (Test-Path $keyFile))) {
    try {
        $r = & npx --yes office-addin-dev-certs@2 install --days 3650 2>&1
        $log += "Dev certs installed: $r"
    } catch { $log += "Dev cert install failed (non-fatal): $_" }
} else { $log += "Dev certs present" }

# 1. 创建 SMB 共享（备用目录路径；失败不致命，旁加载仍可用）
& net share @@SHARE@@ /delete 2>&1 | Out-Null
$shareOut = & net share "@@SHARE@@=$pluginDir" /Grant:Everyone,READ 2>&1
$shareOk = Get-SmbShare -Name '@@SHARE@@' -EA SilentlyContinue
$log += "SMB share exists=$([bool]$shareOk)"

# 2. 注册 TrustedCatalog（统一 UNC URL）
$p = '@@REG_PATH@@'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '@@UNC_URL@@'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value $addinId
$log += "TrustedCatalog: @@UNC_URL@@"

# 3. 删除 AppData 的 .disabled 标记（Rust 已删一次，这里兜底）
$mfDis = "$manifestPath.disabled"
if (Test-Path $mfDis -EA SilentlyContinue) {
    Remove-Item $mfDis -Force -EA SilentlyContinue
    $log += "Removed stale .disabled marker"
}

# 4. 清理旧 WEF 缓存（强制从目录重新加载最新 manifest）
if (Test-Path $wef) {
    Get-ChildItem -Path $wef -Recurse -Force -EA SilentlyContinue |
        Where-Object { $_.Name -match $guid } |
        Remove-Item -Force -Recurse -EA SilentlyContinue
    $log += "Stale WEF manifest cache cleared"
}

# 5. 预置 AddinInfo Omex 索引目录
$addinInfoDir = Join-Path $wef 'AddinInfo\1\omex\@@APP_LABEL@@'
if (-not (Test-Path $addinInfoDir)) { New-Item $addinInfoDir -ItemType Directory -Force | Out-Null }
$log += "AddinInfo Omex index primed"

# 6. 告知 Office 该宿主存在基于注册表的加载项
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

# 7. WEF\Developer 旁加载注册（主加载机制，免手动「添加」）
$devKey = '@@WEF_ROOT@@\Developer'
if (-not (Test-Path $devKey)) { New-Item -Path $devKey -Force | Out-Null }
# 删除无花括号旧条目（历史格式）
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

# 1. 强制关闭宿主进程（释放文件锁）
$proc = Get-Process -Name @@PROCESS@@ -EA SilentlyContinue
if ($proc) {
    $proc | Stop-Process -Force -EA SilentlyContinue
    $waited = 0
    while ((Get-Process -Name @@PROCESS@@ -EA SilentlyContinue) -and $waited -lt 10) {
        Start-Sleep -Milliseconds 500; $waited++
    }
    $log += "@@DISPLAY@@ closed (waited $($waited*500)ms)"
} else { $log += "@@DISPLAY@@ was not running" }

# 2. 移除 SMB 共享
& net share @@SHARE@@ /delete 2>&1 | Out-Null
$log += "SMB share @@SHARE@@ removed"

# 3. 删除 TrustedCatalog 条目（按 Id/GUID，或 manifest 内容匹配）
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

# 4. 删除 WEF 注册表子键（含 GUID）
$wefRoot = '@@WEF_ROOT@@'
if (Test-Path $wefRoot) {
    Get-ChildItem -Path $wefRoot -Recurse -EA SilentlyContinue |
        Where-Object { $_.Name -match $guid } |
        ForEach-Object {
            Remove-Item -Path $_.PSPath -Force -Recurse -EA SilentlyContinue
            $log += "Removed WEF registry key: $($_.PSChildName)"
        }
}

# 5. 清理 WEF 文件缓存（按名 + 按内容 + WebView2）
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

    # WebView2 存储 —— 清「我的加载项」激活列表（会自动安全重建）
    $wv2 = Join-Path $wefCache 'webview2'
    if (Test-Path $wv2) {
        Get-ChildItem -Path $wv2 -Recurse -Directory -Force -EA SilentlyContinue |
            Where-Object { $_.Name -in @('IndexedDB', 'Local Storage', 'Session Storage', 'Cache') } |
            ForEach-Object { Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue }
        $log += "WebView2 add-in storage cleared"
    }
}

# 6. 禁用 AppData manifest（删除 + 创建 .disabled 标记，阻止启动自动恢复）
$mf = Join-Path $env:APPDATA 'com.openflux.app\data\plugins\@@SUB@@\manifest.xml'
$mfDis = "$mf.disabled"
if (Test-Path $mf -EA SilentlyContinue) { Remove-Item $mf -Force -EA SilentlyContinue; $log += "manifest.xml deleted" }
if (-not (Test-Path $mfDis -EA SilentlyContinue)) { New-Item $mfDis -ItemType File -Force -EA SilentlyContinue | Out-Null }
$log += "manifest.disabled marker created"

# 7. 删除 AddinInfo Omex 全局索引（否则重启会重建缓存）
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

# 8. 删除 WEF\Developer 旁加载条目（按名 + 按值兜底）
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
