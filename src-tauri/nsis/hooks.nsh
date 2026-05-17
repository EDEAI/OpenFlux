; OpenFlux NSIS install/uninstall hooks
; Features:
;   1. Bundle app-local VC++ CRT runtime for systems without VC++ installed
;   2. Auto-add install dir to user PATH
;   3. Bundle Python 3.11 embeddable + uv for Agent coding tasks
;   4. Auto-uninstall previous version before installing
;   5. Clean up PATH entry on uninstall, app data is always preserved
;
; Technical notes:
;   - Only modifies user-level PATH (HKCU\Environment\Path), no system-level changes
;   - Uses UNINSTKEY registry markers to track PATH modification state
;   - PREUNINSTALL saves markers before registry deletion, POSTUNINSTALL performs cleanup
;   - Supports SimpChinese (2052) and English (1033) via LangString

; Global variables for cross-hook state
Var PathWasModified
Var PathEntryToRemove

; ============================================================
; Bilingual strings (auto-selected by system locale)
; ============================================================
LangString OF_PYTHON_SETUP      1033 "Setting up bundled Python environment..."
LangString OF_PYTHON_SETUP      2052 "正在配置内置 Python 环境..."
LangString OF_PYTHON_READY      1033 "Python environment ready."
LangString OF_PYTHON_READY      2052 "Python 环境配置完成。"
LangString OF_UNINSTALL_FOUND   1033 "Found existing installation, uninstalling silently..."
LangString OF_UNINSTALL_FOUND   2052 "检测到旧版本，正在自动卸载..."
LangString OF_UNINSTALL_DONE    1033 "Previous version uninstalled."
LangString OF_UNINSTALL_DONE    2052 "旧版本已卸载完成。"
LangString OF_PATH_EXISTS       1033 "OpenFlux path already in user PATH, skipping."
LangString OF_PATH_EXISTS       2052 "OpenFlux 路径已存在于 PATH 中，跳过。"
LangString OF_PATH_ADDED        1033 "Added OpenFlux to user PATH."
LangString OF_PATH_ADDED        2052 "已将 OpenFlux 添加到用户 PATH。"
LangString OF_PATH_REMOVED      1033 "Removed OpenFlux path from user PATH."
LangString OF_PATH_REMOVED      2052 "已从用户 PATH 中移除 OpenFlux 路径。"
LangString OF_DATA_PRESERVED    1033 "App data preserved."
LangString OF_DATA_PRESERVED    2052 "用户数据已保留。"
LangString OF_MIGRATE_SESSIONS  1033 "Migrating session history from legacy path..."
LangString OF_MIGRATE_SESSIONS  2052 "正在迁移历史会话数据到新路径..."
LangString OF_MIGRATE_DONE      1033 "Session history migration complete."
LangString OF_MIGRATE_DONE      2052 "历史会话数据迁移完成。"


; ============================================================
; VC++ Runtime: app-local CRT DLLs for embedding compatibility
; ============================================================
!define OPENFLUX_VC_RUNTIME_DIR "${__FILEDIR__}\..\resources\windows\vc-runtime"

!macro OpenFluxCopyVcRuntime
  SetOutPath "$INSTDIR"
  File "/oname=concrt140.dll" "${OPENFLUX_VC_RUNTIME_DIR}\concrt140.dll"
  File "/oname=msvcp140.dll" "${OPENFLUX_VC_RUNTIME_DIR}\msvcp140.dll"
  File "/oname=msvcp140_1.dll" "${OPENFLUX_VC_RUNTIME_DIR}\msvcp140_1.dll"
  File "/oname=msvcp140_2.dll" "${OPENFLUX_VC_RUNTIME_DIR}\msvcp140_2.dll"
  File "/oname=msvcp140_atomic_wait.dll" "${OPENFLUX_VC_RUNTIME_DIR}\msvcp140_atomic_wait.dll"
  File "/oname=msvcp140_codecvt_ids.dll" "${OPENFLUX_VC_RUNTIME_DIR}\msvcp140_codecvt_ids.dll"
  File "/oname=vccorlib140.dll" "${OPENFLUX_VC_RUNTIME_DIR}\vccorlib140.dll"
  File "/oname=vcruntime140.dll" "${OPENFLUX_VC_RUNTIME_DIR}\vcruntime140.dll"
  File "/oname=vcruntime140_1.dll" "${OPENFLUX_VC_RUNTIME_DIR}\vcruntime140_1.dll"
!macroend

!macro OpenFluxDeleteVcRuntime
  Delete "$INSTDIR\concrt140.dll"
  Delete "$INSTDIR\msvcp140.dll"
  Delete "$INSTDIR\msvcp140_1.dll"
  Delete "$INSTDIR\msvcp140_2.dll"
  Delete "$INSTDIR\msvcp140_atomic_wait.dll"
  Delete "$INSTDIR\msvcp140_codecvt_ids.dll"
  Delete "$INSTDIR\vccorlib140.dll"
  Delete "$INSTDIR\vcruntime140.dll"
  Delete "$INSTDIR\vcruntime140_1.dll"
!macroend

; ============================================================
; Python 3.11 Embeddable + uv setup
; Installs to: $INSTDIR\python\base\   (embeddable interpreter, used directly)
;              $INSTDIR\python\uv.exe  (package manager, installs to base site-packages)
;
; Note: No venv is used. Python 3.8+ extension modules (.pyd) fail in venv because
; python311.dll is not found via DLL search path when running venv\Scripts\python.exe.
; Using base\python.exe directly avoids all DLL search path issues.
; ============================================================
!define OPENFLUX_PYTHON_EMBED_ZIP "${__FILEDIR__}\..\resources\python\python-embed.zip"
!define OPENFLUX_UV_EXE           "${__FILEDIR__}\..\resources\python\uv.exe"

!macro OpenFluxSetupPython
  DetailPrint "$(OF_PYTHON_SETUP)"

  ; Create output directory
  CreateDirectory "$INSTDIR\python"
  CreateDirectory "$INSTDIR\python\base"

  ; Extract embeddable Python zip into base/
  SetOutPath "$INSTDIR\python"
  File "/oname=python-embed.zip" "${OPENFLUX_PYTHON_EMBED_ZIP}"
  nsisunz::Unzip "$INSTDIR\python\python-embed.zip" "$INSTDIR\python\base"
  Delete "$INSTDIR\python\python-embed.zip"

  ; Enable site-packages by uncommenting "import site" in the ._pth file
  ; The file is named pythonXYZ._pth (e.g. python311._pth)
  ; We rewrite it to replace "#import site" with "import site"
  FindFirst $0 $1 "$INSTDIR\python\base\python3*._pth"
  ${If} $1 != ""
    Push "$INSTDIR\python\base\$1"   ; file path
    Push "#import site"               ; find
    Push "import site"                ; replace
    Call ReplaceLineInFile
  ${EndIf}
  FindClose $0

  ; Copy uv.exe
  File "/oname=uv.exe" "${OPENFLUX_UV_EXE}"

  DetailPrint "$(OF_PYTHON_READY)"
!macroend

!macro OpenFluxDeletePython
  RMDir /r "$INSTDIR\python"
!macroend

; Helper: replace a line in a text file (in-place)
; Stack: [file_path] [find_str] [replace_str]
Function ReplaceLineInFile
  Exch $R0     ; replace_str
  Exch
  Exch $R1     ; find_str
  Exch
  Exch 2
  Exch $R2     ; file_path
  Push $R3
  Push $R4
  Push $R5

  GetTempFileName $R3
  FileOpen $R4 "$R2" r
  FileOpen $R5 "$R3" w

  loop:
    ClearErrors
    FileRead $R4 $0
    IfErrors done
    StrCpy $1 $0 -2   ; strip \r\n for comparison
    ${If} $1 == $R1
      FileWrite $R5 "$R0$\r$\n"
    ${Else}
      FileWrite $R5 $0
    ${EndIf}
    Goto loop
  done:
  FileClose $R4
  FileClose $R5

  Delete "$R2"
  CopyFiles /SILENT "$R3" "$R2"
  Delete "$R3"

  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; ============================================================
; PREINSTALL: Runs before installation
;   1. Auto-uninstall any existing version silently (preserves user AppData)
;   2. Copy VC++ runtime DLLs
; ============================================================
!macro NSIS_HOOK_PREINSTALL
  ; --- Auto-uninstall previous version ---
  ; Check HKCU first (per-user install), then HKLM (system-wide)
  StrCpy $0 ""
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  ${EndIf}

  ${If} $0 != ""
    DetailPrint "$(OF_UNINSTALL_FOUND)"

    ; Strip surrounding quotes if present (e.g. "C:\Program Files\app\uninstall.exe")
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $1 $0 "" 1          ; remove leading quote
      StrLen $2 $1
      IntOp $2 $2 - 1
      StrCpy $1 $1 $2            ; remove trailing quote
    ${Else}
      StrCpy $1 $0
    ${EndIf}

    ; Run uninstaller silently:
    ;   /S  = silent mode (no UI, no "delete app data?" dialog → data is preserved)
    ;   _?= = keep installer window alive until uninstall finishes
    ExecWait '"$1" /S _?=$INSTDIR'
    Sleep 1500

    DetailPrint "$(OF_UNINSTALL_DONE)"
  ${EndIf}

  !insertmacro OpenFluxCopyVcRuntime
!macroend


; ============================================================
; POSTINSTALL: Runs after installation completes
; ============================================================
!macro NSIS_HOOK_POSTINSTALL
  ; --- One-time session migration: ~/.openflux/sessions → %APPDATA%\OpenFlux\sessions ---
  ; Runs only when old path has data AND new path is empty (prevents overwrite on repeat installs)
  StrCpy $0 "$PROFILE\.openflux\sessions"
  StrCpy $1 "$APPDATA\OpenFlux\sessions"

  ${If} ${FileExists} "$0\*.*"
    ; Old sessions exist
    ${IfNot} ${FileExists} "$1\*.*"
      ; New path is empty – pre-copy to new location.
      ; Full migration (agentId remap etc.) is handled by the Gateway on first startup.
      DetailPrint "$(OF_MIGRATE_SESSIONS)"
      CreateDirectory "$1"
      CopyFiles /SILENT "$0\*.*" "$1\"
      DetailPrint "$(OF_MIGRATE_DONE)"
    ${EndIf}
  ${EndIf}

  ; Setup bundled Python + uv
  !insertmacro OpenFluxSetupPython

  ; Auto-add $INSTDIR to user PATH (no prompt)
  ReadRegStr $2 HKCU "Environment" "Path"

  ; Check if $INSTDIR is already in user PATH
  ${If} $2 != ""
    ${StrLoc} $3 "$2" "$INSTDIR" ">"
    ${If} $3 != ""
      DetailPrint "$(OF_PATH_EXISTS)"
      Goto SkipPathOverride
    ${EndIf}
  ${EndIf}

  ; Prepend $INSTDIR to user PATH automatically
  ${If} $2 == ""
    StrCpy $2 "$INSTDIR"
  ${Else}
    StrCpy $2 "$INSTDIR;$2"
  ${EndIf}

  WriteRegExpandStr HKCU "Environment" "Path" "$2"

  ; Save markers for uninstall cleanup
  WriteRegStr SHCTX "${UNINSTKEY}" "PathModified" "1"
  WriteRegStr SHCTX "${UNINSTKEY}" "PathEntry" "$INSTDIR"

  ; Broadcast environment change
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  DetailPrint "$(OF_PATH_ADDED)"

  SkipPathOverride:
!macroend

; ============================================================
; PREUNINSTALL: Runs before uninstall
;   Saves PATH modification markers before DeleteRegKey wipes UNINSTKEY
; ============================================================
!macro NSIS_HOOK_PREUNINSTALL
  ; Save PATH modification markers before DeleteRegKey wipes UNINSTKEY
  StrCpy $PathWasModified "0"
  StrCpy $PathEntryToRemove ""
  ReadRegStr $PathWasModified SHCTX "${UNINSTKEY}" "PathModified"
  ReadRegStr $PathEntryToRemove SHCTX "${UNINSTKEY}" "PathEntry"

  ; Clean up VC++ runtime DLLs
  !insertmacro OpenFluxDeleteVcRuntime

  ; Clean up bundled Python environment
  !insertmacro OpenFluxDeletePython
!macroend

; ============================================================
; POSTUNINSTALL: Runs after uninstall completes
; ============================================================
!macro NSIS_HOOK_POSTUNINSTALL
  ; --- Clean up PATH ---
  ${If} $PathWasModified == "1"
  ${AndIf} $PathEntryToRemove != ""
    ReadRegStr $R2 HKCU "Environment" "Path"

    ${If} $R2 != ""
      ; Try removing "$PathEntryToRemove;" (at beginning)
      StrLen $R3 "$PathEntryToRemove;"
      StrCpy $R4 $R2 $R3
      ${If} $R4 == "$PathEntryToRemove;"
        StrCpy $R2 $R2 "" $R3
        Goto path_cleaned
      ${EndIf}

      ; Try removing ";$PathEntryToRemove" (at end)
      StrLen $R3 ";$PathEntryToRemove"
      StrLen $R6 $R2
      IntOp $R7 0 - $R3
      StrCpy $R4 $R2 "" $R7
      ${If} $R4 == ";$PathEntryToRemove"
        IntOp $R7 $R6 - $R3
        StrCpy $R2 $R2 $R7
        Goto path_cleaned
      ${EndIf}

      ; General replace: ";$PathEntryToRemove;" -> ";" (in middle)
      ${WordReplace} "$R2" ";$PathEntryToRemove;" ";" "+" $R2

      ; Exact match (only entry)
      ${If} $R2 == $PathEntryToRemove
        StrCpy $R2 ""
      ${EndIf}

      path_cleaned:
      ${If} $R2 == ""
        DeleteRegValue HKCU "Environment" "Path"
      ${Else}
        WriteRegExpandStr HKCU "Environment" "Path" "$R2"
      ${EndIf}

      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
      DetailPrint "$(OF_PATH_REMOVED)"
    ${EndIf}
  ${EndIf}

  ; --- App data is automatically preserved (no prompt) ---
  DetailPrint "$(OF_DATA_PRESERVED)"
!macroend