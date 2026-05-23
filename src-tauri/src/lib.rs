pub mod commands;
pub mod config;
pub mod plugin_server;
pub mod tray;

use std::sync::Mutex;
use tauri::Manager;

/// 递归复制目录（src → dst），dst 不存在时自动创建
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦到已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化系统托盘
            tray::setup_tray(app)?;

            // 加载配置
            let config = config::load_config(app.handle())?;
            app.manage(config);

            // 初始化 Gateway sidecar 状态
            app.manage(Mutex::new(commands::gateway::GatewaySidecar::new()));

            // 自动启动 Gateway sidecar（异步，不阻塞 UI 线程）
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 让窗口先渲染 loading 界面
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                // 使用 spawn_blocking 避免同步 I/O 阻塞 tokio 运行时
                let handle = app_handle.clone();
                let result = tokio::task::spawn_blocking(move || {
                    commands::gateway::start_gateway_sidecar(&handle)
                }).await;
                match result {
                    Ok(Ok(())) => eprintln!("[OpenFlux] Gateway sidecar started"),
                    Ok(Err(e)) => eprintln!("[OpenFlux] Gateway sidecar start failed: {}", e),
                    Err(e) => eprintln!("[OpenFlux] Gateway sidecar task error: {}", e),
                }
            });

            // 启动 Plugin 静态文件服务器（Rust 原生，端口 18802）
            let plugins_dir = {
                let workspace = app.handle()
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                // 与 Gateway 的 workspacePath 保持一致：app_data_dir/data/plugins
                workspace.join("data").join("plugins")
            };

            // 每次启动都从资源目录更新 Excel 插件文件（覆盖式），确保版本升级后立即生效
            // 插件目录仅 ~64KB，覆盖开销可忽略
            // 注意：若 manifest.xml.disabled 标记文件存在，说明用户已卸载插件，跳过复制
            //       （不管 manifest.xml 是否也存在，.disabled 标记优先）
            if let Ok(resource_dir) = app.handle().path().resource_dir() {
                let excel_src  = resource_dir.join("resources").join("plugins").join("excel");
                let excel_dest = plugins_dir.join("excel");
                if excel_src.exists() {
                    let manifest_disabled = excel_dest.join("manifest.xml.disabled");
                    if manifest_disabled.exists() {
                        eprintln!("[OpenFlux] Excel plugin uninstalled by user — skipping auto-copy");
                    } else {
                        if let Err(e) = copy_dir_all(&excel_src, &excel_dest) {
                            eprintln!("[OpenFlux] Failed to update Excel plugin: {}", e);
                        } else {
                            eprintln!("[OpenFlux] Excel plugin updated at {:?}", excel_dest);
                        }
                    }
                }
                // Word plugin — same auto-copy pattern
                let word_src  = resource_dir.join("resources").join("plugins").join("word");
                let word_dest = plugins_dir.join("word");
                if word_src.exists() {
                    let manifest_disabled = word_dest.join("manifest.xml.disabled");
                    if manifest_disabled.exists() {
                        eprintln!("[OpenFlux] Word plugin uninstalled by user — skipping auto-copy");
                    } else {
                        if let Err(e) = copy_dir_all(&word_src, &word_dest) {
                            eprintln!("[OpenFlux] Failed to update Word plugin: {}", e);
                        } else {
                            eprintln!("[OpenFlux] Word plugin updated at {:?}", word_dest);
                        }
                    }
                }
            }

            tauri::async_runtime::spawn(async move {
                plugin_server::start(plugins_dir, 18802).await;
            });

            eprintln!("[OpenFlux] Started v0.6.0 (gateway starting async)");
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // macOS: 点击红灯按钮时隐藏窗口到托盘，而非退出应用
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if cfg!(target_os = "macos") {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 应用关闭时停止 Gateway sidecar
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    if let Err(e) = commands::gateway::stop_gateway_sidecar(app) {
                        eprintln!("[OpenFlux] Gateway sidecar stop failed: {}", e);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::window::window_minimize,
            commands::window::window_maximize,
            commands::window::window_close,
            commands::window::window_flash_frame,
            commands::file::file_exists,
            commands::file::file_read,
            commands::file::file_open,
            commands::file::file_reveal,
            commands::file::file_save_as,
            commands::file::save_temp_image,
            commands::gateway::get_gateway_config,
            commands::gateway::start_gateway,
            commands::gateway::stop_gateway,
            commands::gateway::restart_gateway,
            commands::system::app_relaunch,
            commands::excel_plugin::excel_plugin_install,
            commands::excel_plugin::excel_plugin_uninstall,
            commands::excel_plugin::excel_plugin_status,
            commands::word_plugin::word_plugin_install,
            commands::word_plugin::word_plugin_uninstall,
            commands::word_plugin::word_plugin_status,
        ])
        .build(tauri::generate_context!())
        .expect("OpenFlux failed to build")
        .run(|app, event| {
            // 应用退出时先确保 kill gateway（兑底托盘退出路径）
            if let tauri::RunEvent::Exit = event {
                let _ = commands::gateway::stop_gateway_sidecar(app);
            }
        });
}
