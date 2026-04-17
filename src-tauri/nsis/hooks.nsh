; OpenFlux NSIS 卸载钩子
; 功能：卸载时询问用户是否删除应用数据

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

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OpenFluxCopyVcRuntime
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OpenFluxDeleteVcRuntime
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 询问用户是否删除应用数据
  MessageBox MB_YESNO "是否删除应用数据（聊天记录、配置、模型缓存等）？$\n$\n将清理以下目录:$\n  $APPDATA\com.openflux.app$\n  $PROFILE\.openflux" IDNO SkipRemoveData
    ; 删除 Tauri app data 目录
    RMDir /r "$APPDATA\com.openflux.app"
    ; 删除旧版/默认数据目录
    RMDir /r "$PROFILE\.openflux"
    ; 删除日志目录
    RMDir /r "$APPDATA\OpenFlux"
  SkipRemoveData:
!macroend
