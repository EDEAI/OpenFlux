; OpenFlux NSIS install/uninstall hooks
; Features:
;   1. Bundle app-local VC++ CRT runtime for systems without VC++ installed
;   2. Detect existing system Node.js and offer to prepend bundled runtime to user PATH
;   3. Clean up PATH entry and app data on uninstall
;
; Technical notes:
;   - Only modifies user-level PATH (HKCU\Environment\Path), no system-level changes
;   - Uses UNINSTKEY registry markers to track PATH modification state
;   - PREUNINSTALL saves markers before registry deletion, POSTUNINSTALL performs cleanup

; Global variables for cross-hook state
Var PathWasModified
Var PathEntryToRemove

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
; PREINSTALL: Runs before installation
; ============================================================
!macro NSIS_HOOK_PREINSTALL
  !insertmacro OpenFluxCopyVcRuntime
!macroend


; ============================================================
; POSTINSTALL: Runs after installation completes
; ============================================================
!macro NSIS_HOOK_POSTINSTALL
  ; Only prompt in non-update mode (auto-update keeps existing settings)
  ${If} $UpdateMode <> 1
    ; Read current user PATH from registry
    ReadRegStr $2 HKCU "Environment" "Path"

    ; Check if $INSTDIR is already in user PATH
    ${If} $2 != ""
      ${StrLoc} $3 "$2" "$INSTDIR" ">"
      ${If} $3 != ""
        ; Already in PATH, skip
        DetailPrint "OpenFlux path already in user PATH, skipping"
        Goto SkipPathOverride
      ${EndIf}
    ${EndIf}

    ; Prompt user to add OpenFlux to PATH
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Add OpenFlux to system PATH?$\n$\n\
      This ensures the bundled Node.js runtime is$\n\
      prioritized, preventing version conflicts.$\n$\n\
      (Only affects current user, auto-cleaned on uninstall)" \
      IDNO SkipPathOverride

    ; --- User chose YES: prepend $INSTDIR to user PATH ---
    ReadRegStr $2 HKCU "Environment" "Path"

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

    DetailPrint "Added $INSTDIR to user PATH"

    SkipPathOverride:
  ${EndIf}
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
      DetailPrint "Removed OpenFlux path from user PATH"
    ${EndIf}
  ${EndIf}

  ; --- Ask user about app data deletion ---
  MessageBox MB_YESNO "Delete application data (chat history, config, model cache)?$\n$\nDirectories to clean:$\n  $APPDATA\com.openflux.app$\n  $PROFILE\.openflux" IDNO SkipRemoveData
    RMDir /r "$APPDATA\com.openflux.app"
    RMDir /r "$PROFILE\.openflux"
    RMDir /r "$APPDATA\OpenFlux"
  SkipRemoveData:
!macroend