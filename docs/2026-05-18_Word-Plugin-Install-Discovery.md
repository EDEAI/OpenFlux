# Word Plugin Install & Discovery Mechanism

**创建时间：** 2026-05-18  
**最后更新：** 2026-05-18  
**作者：** 开发团队  
**状态：** 已发布  
**相关文档：** [Excel Plugin Install](2026-05-18_Excel-Plugin-Install-Uninstall.md)

## 文档概述

记录 Word Add-in 的安装机制，包含与 Excel 插件的关键区别和调试过程中的重要发现。

## 更新记录

| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|----------|--------|
| 2026-05-18 | v1.0 | 初始版本，记录 SMB 共享发现机制 | 开发团队 |

---

## 1. Excel vs Word 目录类型的核心差异

| 特性 | Excel | Word |
|------|-------|------|
| TrustedCatalog URL | `file:///path/to/plugins/excel` | `\\localhost\OpenFluxWord` (UNC) |
| Trust Center 显示类型 | Shared Folder | Shared Folder |
| `https://` URL 的 Trust Center 类型 | ❌ 拒绝 | ❌ SharePoint 类型（不扫描 manifest.xml）|
| 注册表路径 | `HKCU:\...\WEF\TrustedCatalogs\{GUID}` | 同左 |
| 扫描机制 | 直接读取文件系统 | 通过 SMB 读取文件共享 |

> [!IMPORTANT]
> Word 的 TrustedCatalog URL 如果使用 `https://` 前缀，Word 会将其识别为 **SharePoint 目录**类型，并调用 SharePoint REST API（如 `/_api/web/lists/...`）枚举加载项，**不会**扫描 `manifest.xml`。必须使用 UNC 路径。

## 2. 正确的安装流程

### Step 1: 创建 Windows 文件共享

```powershell
# 删除旧共享（如有）
net share OpenFluxWord /delete

# 创建新共享，指向插件目录
net share "OpenFluxWord=C:\Users\...\com.openflux.app\data\plugins\word" /Grant:Everyone,READ
```

### Step 2: 注册 TrustedCatalog（UNC URL）

```powershell
$p = 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{c3d4e5f6-a7b8-9012-cdef-123456789012}'
New-Item -Path $p -Force | Out-Null
Set-ItemProperty -Path $p -Name 'Url'   -Value '\\localhost\OpenFluxWord'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value '{c3d4e5f6-a7b8-9012-cdef-123456789012}'
```

### Step 3: 清理 WEF 缓存 & 设置刷新标志

```powershell
# 清除旧缓存（按 GUID）
$guid = 'c3d4e5f6-a7b8-9012-cdef-123456789012'
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef" -Recurse -Force |
    Where-Object { $_.Name -match $guid } | Remove-Item -Force -Recurse

# 设置 Office 扫描标志
Set-ItemProperty -Path 'HKCU:\...\WEF' -Name 'WordOMEXRefreshPending' -Value 1 -Type DWord
```

### Step 4: 用户操作（首次安装需要）

重启 Word 后：
> 插入 → 加载项 → 我的加载项 → **更多加载项** → **共享文件夹** tab → OpenFlux Agent → 添加

---

## 3. WEF 缓存目录哈希算法

Office 使用 **Unicode MD5（Base64）** 对 Catalog URL 命名缓存目录：

```powershell
function Get-OfficeCatalogHash($url) {
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($url)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    [Convert]::ToBase64String($md5.ComputeHash($bytes))
}

# 示例
Get-OfficeCatalogHash "\\localhost\OpenFluxWord"
# → GJukq7LTk9drNyag8K3x0w==  ✅ 与实际目录匹配
```

缓存位置：`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\{OfficeGUID}\<CatalogHash>\Manifests\`

---

## 4. 证书说明

- `office-addin-dev-certs` 的 CA 证书会自动写入 Windows 信任存储（`certutil -addstore`）
- HTTPS plugin server（端口 3000）用于 taskpane HTML 加载（添加插件后）
- manifest.xml 本身通过 SMB 共享读取，**不需要** HTTPS

---

## 5. 卸载流程

```powershell
# 1. 关闭 Word
Stop-Process -Name WINWORD -Force

# 2. 删除 SMB 共享
net share OpenFluxWord /delete

# 3. 删除注册表 TrustedCatalog 条目
Remove-Item 'HKCU:\...\WEF\TrustedCatalogs\{GUID}' -Force

# 4. 清理 WEF 文件缓存
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef" -Recurse -Force |
    Where-Object { $_.Name -match $guid } | Remove-Item -Force -Recurse
```
