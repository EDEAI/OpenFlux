# OpenFlux Excel Add-in 安装与卸载技术文档

**创建时间：** 2026-05-18  
**最后更新：** 2026-05-18  
**作者：** 开发团队  
**状态：** 已发布  
**相关文件：** `src-tauri/src/commands/excel_plugin.rs` · `src-tauri/src/lib.rs` · `src/main.ts`

---

## 更新记录

| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|----------|--------|
| 2026-05-18 | v1.0 | 初始版本，整理安装/卸载完整流程 | 开发团队 |

---

## 1. 概述

OpenFlux Excel Add-in 以 **Office Web Add-in（manifest.xml 方式）** 注册到 Excel，通过
`HKCU\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs` 注册表添加可信目录，指向本地
文件系统上的插件目录（`file://` URL）。

### 1.1 Add-in 身份

| 项目 | 值 |
|------|----|
| Add-in GUID | `{a1b2c3d4-e5f6-7890-abcd-ef1234567890}` |
| 注册表路径 | `HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{a1b2c3d4-...}` |
| 本地插件目录 | `%APPDATA%\com.openflux.app\data\plugins\excel\` |
| Catalog URL | `file:///C:/Users/{user}/AppData/Roaming/com.openflux.app/data/plugins/excel` |

### 1.2 需要同步管理的持久化层（共 7 层）

| # | 层 | 位置 | 说明 |
|---|----|------|------|
| 1 | TrustedCatalogs 注册表 | `HKCU:\...\WEF\TrustedCatalogs\{ADDIN_ID}` | Excel 从此读取可信目录 URL |
| 2 | WEF Manifests 缓存 | `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\{OfficeGUID}\{CatalogHash}\Manifests\` | 首次加载后的 manifest 缓存 |
| 3 | WEF AppStates 缓存 | `...\{CatalogHash}\AppStates\` | 激活状态记录（会触发 manifest 重建） |
| 4 | WebView2 Local Storage | `...\Wef\webview2\...Local Storage\` | 「我的加载项」已激活列表 |
| 5 | SMB Share（OfficeAddin） | Windows 共享 | 若通过网络共享安装则需要清理 |
| 6 | AppData manifest.xml | `%APPDATA%\com.openflux.app\data\plugins\excel\manifest.xml` | Catalog URL 指向的文件，**必须有效** |
| 7 | AddinInfo Omex 索引 | `%LOCALAPPDATA%\...\Wef\AddinInfo\1\omex\Excel\{OmexHash}\` | 全局加载项索引，跨 WEF 重建持久 |

---

## 2. 关键文件说明

### 2.1 插件目录结构

```
%APPDATA%\com.openflux.app\data\plugins\excel\
├── manifest.xml          ← 主要身份文件（~4.6 KB），内含 GUID、UI、URL 定义
├── manifest.xml.disabled ← 卸载标记文件（空文件），存在时 lib.rs 跳过自动更新
├── commands.html         ← 函数命令页面
├── commands.js
├── taskpane.html         ← 任务窗格 UI
└── taskpane.js           ← 任务窗格逻辑（~60 KB）
```

### 2.2 manifest.xml 状态机

```
正常运行:
  manifest.xml (4602 bytes) + 无 .disabled 标记
  → Excel 可读取，插件正常显示

已卸载:
  manifest.xml 被删除 + manifest.xml.disabled (空文件，0 bytes) 存在
  → lib.rs 启动时跳过自动复制，插件不出现在 Excel

安装中（Rust install 函数执行后）:
  manifest.xml.disabled 被删除 + manifest.xml 从 resources/ 重新复制（4602 bytes）
  → Excel 重启后可在「共享文件夹」里找到插件
```

### 2.3 Resources 源文件

Tauri 打包进 binary 的资源（开发时位于）：

```
src-tauri/resources/plugins/excel/
├── manifest.xml   ← 4602 bytes，是安装时的权威来源
├── commands.html
├── commands.js
├── taskpane.html
└── taskpane.js
```

> **重要：** 任何对插件内容的修改必须在 `src-tauri/resources/plugins/excel/` 中进行，
> 然后重新编译。AppData 目录的内容在下次 OpenFlux 启动时会被自动覆盖（未卸载状态下）。

---

## 3. 安装流程（Install）

触发方式：用户在客户端侧边栏 Connect 区域将 Excel 插件 toggle 拨到 **ON**。

### 3.1 前端（main.ts）

```
用户拨 ON
  → el.disabled = true（禁用 toggle 防止重复点击）
  → invoke('excel_plugin_install')
    ├─ 成功 → localStorage.setItem('excel-plugin-installed', '1')
    │          alert(result)  // 显示操作提示
    │          renderLocalAgents()  // 刷新侧边栏
    └─ 失败 → alert('安装失败: ' + error)
              el.checked = false  // 回滚 toggle 到 OFF
              el.disabled = false
```

### 3.2 Rust 命令（excel_plugin_install）

执行顺序：

**Step 0 — 确认插件目录存在**
```
plugins_dir = app_data_dir()/data/plugins/excel
如果目录不存在 → 返回错误（提示用户先重启 OpenFlux）
```

**Step 1（Rust 侧）— 修复 manifest.xml**
```
1a. 删除 manifest.xml.disabled 标记文件（若存在）
1b. 从 resource_dir()/resources/plugins/excel/manifest.xml
    复制到 plugins_dir/manifest.xml（覆盖任何空文件）
```

> **此步是 2026-05-18 修复的关键**：卸载后 manifest.xml.disabled 是空文件，
> 旧逻辑用 PowerShell rename 会产生 0 字节 manifest.xml，导致 Excel 无法解析。
> 现在改为从 resources 复制，确保内容始终完整。

**Step 2（PowerShell）— 写注册表 TrustedCatalogs**
```powershell
$p = 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{a1b2c3d4-...}'
New-Item -Path $p -Force
Set-ItemProperty -Path $p -Name 'Url'   -Value 'file:///C:/Users/.../plugins/excel'
Set-ItemProperty -Path $p -Name 'Flags' -Value 1      # Type: DWord
Set-ItemProperty -Path $p -Name 'Id'    -Value '{a1b2c3d4-e5f6-7890-abcd-ef1234567890}'
```

**Step 3（PowerShell）— 清理旧 WEF 缓存**
```powershell
# 删除包含我们 GUID 的 WEF 缓存文件/目录
Get-ChildItem %LOCALAPPDATA%\Microsoft\Office\16.0\Wef -Recurse |
    Where-Object { $_.Name -match 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' } |
    Remove-Item -Force -Recurse
```
> 清理旧缓存确保 Excel 从目录重新加载最新 manifest，而不是读取过期缓存。

**Step 4（PowerShell）— 预置 AddinInfo Omex 索引目录**
```powershell
$addinInfoDir = '%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\AddinInfo\1\omex\Excel'
New-Item $addinInfoDir -ItemType Directory -Force
# Excel 在下次启动时会自动填充完整记录
```

**返回结果：**
```
✅ 安装完成！

请重新打开 Excel，然后：
插入 → 加载项 → 我的加载项 → 共享文件夹 → OpenFlux Agent → 添加
```

---

## 4. 卸载流程（Uninstall）

触发方式：用户将 toggle 拨到 **OFF** 后，确认对话框点击「卸载」。

### 4.1 前端确认流程

```
用户拨 OFF
  → el.disabled = true
  → showExcelUninstallConfirm()  // 弹出自定义确认框
    ├─ 用户取消 → el.checked = true（回滚到 ON），el.disabled = false
    └─ 用户确认 → invoke('excel_plugin_uninstall')
                  ├─ 成功 → localStorage.removeItem('excel-plugin-installed')
                  │          alert(msg)
                  │          renderLocalAgents()
                  └─ 失败 → alert('卸载失败: ' + error)
                             el.checked = true（回滚到 ON）
                             el.disabled = false
```

### 4.2 Rust 命令（excel_plugin_uninstall）

执行 7 个清理步骤，全部由 PowerShell 完成：

**Step 1 — 强制关闭 Excel**
```powershell
Get-Process -Name EXCEL | Stop-Process -Force
# 等待最长 5 秒（每 500ms 检查一次），确保文件锁释放
```
> 必须先关 Excel，否则后续删文件/注册表会因文件锁失败。

**Step 2 — 删除所有 TrustedCatalogs 注册表项**
```powershell
# 遍历 HKCU:\...\WEF\TrustedCatalogs 下所有子键
# 匹配条件：Id = 我们的 GUID，或 manifest.xml 内容包含我们的 GUID
# 精准删除，不影响其他加载项
Get-ChildItem 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs' |
    Where-Object { ... 包含 OpenFlux GUID ... } |
    Remove-Item -Force
```

**Step 3 — 删除 WEF 注册表子键（含 GUID 的 key）**
```powershell
Get-ChildItem 'HKCU:\Software\Microsoft\Office\16.0\WEF' -Recurse |
    Where-Object { $_.Name -match 'a1b2c3d4-...' } |
    Remove-Item -Force -Recurse
```

**Step 4 — 清理 WEF 文件缓存（三种方式）**

4a. **按文件名删除**：文件名中包含 GUID 的 Manifest/AppState 文件
```powershell
Get-ChildItem %LOCALAPPDATA%\Microsoft\Office\16.0\Wef -Recurse |
    Where-Object { $_.Name -match 'a1b2c3d4-...' } |
    Remove-Item -Force -Recurse
```

4b. **按内容删除**（兜底）：小于 512KB 的 .xml/.json 文件中包含 GUID 的
```powershell
Get-ChildItem ... -Recurse -File |
    Where-Object { $_.Extension -in @('.xml','.json','') -and $_.Length -lt 524288 } |
    Where-Object { (Get-Content ...) -match 'a1b2c3d4-...' } |
    Remove-Item -Force
```

4c. **清理 WebView2 存储**（「我的加载项」激活列表）：
```powershell
# 删除 Local Storage、Session Storage、IndexedDB、Cache
%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\webview2\...\Local Storage\
%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\webview2\...\Session Storage\
%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\webview2\...\IndexedDB\
%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\webview2\...\Cache\
```

**Step 5 — 移除 OfficeAddin SMB 共享（可选）**
```powershell
$share = Get-SmbShare -Name 'OfficeAddin'
# 仅当共享路径下的 manifest.xml 内容匹配我们的 GUID 时才删除
# 不影响指向其他插件的同名共享
if ($share AND manifest包含OpenFlux GUID) { Remove-SmbShare -Name 'OfficeAddin' -Force }
```

**Step 6 — 禁用 AppData manifest（最关键步骤）**
```powershell
$manifest = '%APPDATA%\com.openflux.app\data\plugins\excel\manifest.xml'

# 6a. 删除 manifest.xml（切断 Catalog URL 指向的文件）
Remove-Item $manifest -Force

# 6b. 创建空的 manifest.xml.disabled 标记文件
New-Item "$manifest.disabled" -ItemType File -Force
```

> **此标记的作用**：OpenFlux 每次启动时（lib.rs）会检测 `manifest.xml.disabled` 是否存在。
> 若存在 → **跳过自动覆盖复制**，防止用户卸载后 App 重启时又自动恢复插件。

**Step 7 — 删除 AddinInfo Omex 全局索引**
```powershell
$dir = '%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\AddinInfo\1\omex\Excel'
# 查找包含我们 GUID 的 hash 子目录并删除
# 兜底：若只有一个子目录，直接删除（大概率是我们的）
Get-ChildItem $dir -Directory | Where-Object { ... contains GUID ... } | Remove-Item -Recurse -Force
```

> **为何要清理 Omex 索引**：这是一个跨 WEF 重建持久的索引。若不清理，Excel 重启后会从
> 此索引重建 WEF 缓存，导致即使 TrustedCatalogs 已删除，插件仍会出现。

**返回结果：**
```
✅ 卸载完成！

重新打开 Excel 后插件将不再出现。
```

---

## 5. lib.rs 启动时的自动同步

每次 OpenFlux 启动，`lib.rs` 都会执行：

```rust
let excel_src  = resource_dir / "resources" / "plugins" / "excel";
let excel_dest = app_data_dir / "data" / "plugins" / "excel";
let disabled_marker = excel_dest / "manifest.xml.disabled";

if disabled_marker.exists() {
    // 用户已卸载 → 跳过，不恢复插件
    eprintln!("[OpenFlux] Excel plugin uninstalled by user — skipping auto-copy");
} else {
    // 正常状态 → 覆盖式更新（确保版本升级后插件文件最新）
    copy_dir_all(&excel_src, &excel_dest);
}
```

**设计要点：**
- `.disabled` 标记优先级高于 `manifest.xml` 是否存在
- 正常状态下每次启动都会用 resources 里的文件覆盖 AppData，确保升级后立即生效
- 插件目录总大小约 64KB，覆盖开销可忽略

---

## 6. 状态流转图

```
[首次安装 OpenFlux]
        ↓
  lib.rs 启动：resources/ → AppData/
  manifest.xml (4602B) 存在，无 .disabled
        ↓
[用户操作：toggle ON]
  Rust install:
    1. 删除 .disabled（若有）
    2. 从 resources 复制 manifest.xml
    3. PowerShell 写注册表 + 清 WEF 缓存
  localStorage: excel-plugin-installed = '1'
        ↓
[重启 Excel]
  Excel 读取 TrustedCatalogs → 找到 Catalog URL
  从 manifest.xml 加载插件 → 显示在「共享文件夹」
        ↓
[用户操作：toggle OFF → 确认卸载]
  PowerShell:
    1. 关闭 Excel
    2-5. 清理注册表 + WEF 缓存
    6. 删除 manifest.xml + 创建 manifest.xml.disabled
    7. 清理 Omex 索引
  localStorage: 删除 excel-plugin-installed
        ↓
[OpenFlux 重启]
  lib.rs 检测到 .disabled → 跳过自动复制
  manifest.xml 不存在，Excel 重启后找不到插件
        ↓
[用户操作：toggle ON（重新安装）]
  → 回到「[用户操作：toggle ON]」步骤
```

---

## 7. 已知问题与修复记录

### Bug #1：重新安装后 manifest.xml 为 0 字节（2026-05-18 修复）

**现象：** 拨 ON 后重启 Excel，插件不出现。

**根本原因链：**
1. 卸载时：`manifest.xml` 被删除，`manifest.xml.disabled`（空文件，0B）被创建作为标记
2. 安装时（旧逻辑）：PowerShell `Rename-Item manifest.xml.disabled → manifest.xml`
3. rename 的结果：`manifest.xml` 存在，但内容是 0 字节（空文件）
4. Excel 读到 0 字节 XML → 解析失败 → 插件不显示

**修复方案：** 在 Rust install 函数里，PowerShell 执行**之前**：
```rust
// 删除 .disabled 标记
std::fs::remove_file(&disabled_marker);
// 从 resources 复制完整 manifest（4602 bytes）覆盖任何空占位文件
std::fs::copy(&src_manifest, &dest_manifest);
```

PowerShell 的 rename 步骤保留（此时已无 .disabled，rename 是 no-op），不影响正确性。

---

## 8. 调试与验证命令

### 检查当前安装状态
```powershell
# 注册表
Get-ItemProperty "HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" -EA SilentlyContinue | Select Url, Flags, Id

# AppData 插件目录
dir "$env:APPDATA\com.openflux.app\data\plugins\excel\"

# manifest.xml 内容检查（应 ~4602 bytes，有效 XML）
(Get-Item "$env:APPDATA\com.openflux.app\data\plugins\excel\manifest.xml").Length
Get-Content "$env:APPDATA\com.openflux.app\data\plugins\excel\manifest.xml" | Select -First 3
```

### 检查 WEF 缓存
```powershell
# 查找所有与 OpenFlux GUID 相关的缓存文件
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef" -Recurse -EA SilentlyContinue |
    Where-Object { $_.Name -match 'a1b2c3d4' }

# 查看 AddinInfo Omex 索引
dir "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef\AddinInfo\1\omex\Excel\" -EA SilentlyContinue
```

### 手动完全清理（紧急恢复）
```powershell
# 1. 关闭 Excel
Stop-Process -Name EXCEL -Force -EA SilentlyContinue

# 2. 删除注册表
Remove-Item "HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{a1b2c3d4-e5f6-7890-abcd-ef1234567890}" -Force -EA SilentlyContinue

# 3. 清理 WEF 缓存中的 OpenFlux 文件
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\Office\16.0\Wef" -Recurse -Force -EA SilentlyContinue |
    Where-Object { $_.Name -match 'a1b2c3d4' } |
    Remove-Item -Force -Recurse -EA SilentlyContinue

# 4. 删除 manifest 并创建 .disabled 标记
Remove-Item "$env:APPDATA\com.openflux.app\data\plugins\excel\manifest.xml" -Force -EA SilentlyContinue
New-Item "$env:APPDATA\com.openflux.app\data\plugins\excel\manifest.xml.disabled" -ItemType File -Force

# 5. 验证
echo "清理完成。重启 OpenFlux 后再重新安装。"
```

---

## 9. 用户操作步骤（End-to-End）

### 安装插件
1. 打开 OpenFlux 客户端
2. 在左侧侧边栏底部 **Connect** 区域找到 **Excel 插件**
3. 将开关拨到 **ON**（蓝色）
4. 等待约 3-5 秒，看到成功提示
5. **关闭并重新打开 Excel**
6. 在 Excel 中：**插入 → 加载项 → 我的加载项 → 共享文件夹** 标签页
7. 找到 **OpenFlux Agent** → 点击 **添加**
8. 插件面板将在右侧打开

### 卸载插件
1. 在 Connect 区域找到 **Excel 插件**，将开关拨到 **OFF**
2. 在确认对话框中点击 **卸载**
3. 等待约 5-10 秒（需关闭 Excel 进程）
4. 看到成功提示后，**重新打开 Excel**
5. 验证插件已不在「共享文件夹」中出现

### 重新安装（卸载后）
- 直接将开关重新拨到 **ON** 即可，无需其他操作
- 无需重启 OpenFlux（Rust install 函数直接从 resources 复制 manifest）
