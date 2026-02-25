; OpenFlux NSIS 卸载钩子
; 功能：卸载时询问用户是否删除应用数据

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
