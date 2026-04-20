; OpenFlux NSIS install/uninstall hooks
; Features:
;   1. Detect existing system Node.js and offer to prepend bundled runtime to user PATH
;   2. Clean up PATH entry and app data on uninstall
;
; Technical notes:
;   - Only modifies user-level PATH (HKCU\Environment\Path), no system-level changes
;   - Uses UNINSTKEY registry markers to track PATH modification state
;   - PREUNINSTALL saves markers before registry deletion, POSTUNINSTALL performs cleanup

; Global variables for cross-hook state
Var PathWasModified
Var PathEntryToRemove

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

    ; $INSTDIR not in user PATH - offer to add it
    ; Check if there are other Node.js installations that could conflict
    nsExec::ExecToStack 'cmd /c where node.exe 2>nul'
    Pop $0
    Pop $1

    ; Build prompt message based on whether external Node.js exists
    ${If} $0 == 0
    ${AndIf} $1 != ""
      ; Found system Node.js - warn about conflicts
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Detected Node.js runtime on this system:$\n$\n$1$\nOpenFlux includes a dedicated Node.js runtime.$\nTo avoid version conflicts, it is recommended to$\nprioritize the OpenFlux runtime path.$\n$\nAdd OpenFlux path to the beginning of user PATH?$\n(Only affects current user, auto-cleaned on uninstall)" \
        IDNO SkipPathOverride
    ${Else}
      ; No system Node.js found - still offer PATH addition for subprocess compatibility
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "OpenFlux includes a dedicated Node.js runtime.$\nAdding it to PATH ensures all sub-processes use$\nthe correct version.$\n$\nAdd OpenFlux path to user PATH?$\n(Only affects current user, auto-cleaned on uninstall)" \
        IDNO SkipPathOverride
    ${EndIf}

    ; --- User chose YES: prepend $INSTDIR to user PATH ---
    ; Re-read in case it changed
    ReadRegStr $2 HKCU "Environment" "Path"

    ; Prepend
    ${If} $2 == ""
      StrCpy $2 "$INSTDIR"
    ${Else}
      StrCpy $2 "$INSTDIR;$2"
    ${EndIf}

    ; Write to registry (user-level REG_EXPAND_SZ)
    WriteRegExpandStr HKCU "Environment" "Path" "$2"

    ; Save markers for uninstall
    WriteRegStr SHCTX "${UNINSTKEY}" "PathModified" "1"
    WriteRegStr SHCTX "${UNINSTKEY}" "PathEntry" "$INSTDIR"

    ; Broadcast WM_SETTINGCHANGE so new cmd/PowerShell windows pick up the change
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

    DetailPrint "Added $INSTDIR to user PATH (prioritized over system Node.js)"

    SkipPathOverride:
  ${EndIf}
!macroend

; ============================================================
; PREUNINSTALL: Runs before uninstall
;   Saves PATH modification markers before DeleteRegKey wipes UNINSTKEY
; ============================================================
!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $PathWasModified "0"
  StrCpy $PathEntryToRemove ""
  ReadRegStr $PathWasModified SHCTX "${UNINSTKEY}" "PathModified"
  ReadRegStr $PathEntryToRemove SHCTX "${UNINSTKEY}" "PathEntry"
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