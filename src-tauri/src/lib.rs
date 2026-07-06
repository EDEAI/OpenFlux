pub mod commands;
pub mod config;
pub mod brand;
pub mod plugin_server;
pub mod tray;
pub mod utils;
pub mod setup;
pub mod splash;

use std::sync::{Arc, Mutex};
use tauri::Manager;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先取编译期上下文（含品牌覆盖后的 identifier），splash 用它定位磁盘上的界面语言偏好
    let context = tauri::generate_context!();

    // 原生启动 splash：必须在 Tauri/WebView2 初始化之前显示，
    // 覆盖「进程启动 → WebView 首帧」的空窗期；前端首帧渲染后 invoke splash_close 关闭
    #[cfg(target_os = "windows")]
    splash::show(&context.config().identifier);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When an instance is already running, focus the existing window
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
            // Initialize the system tray
            tray::setup_tray(app)?;

            // Load configuration
            let config = config::load_config(app.handle())?;
            app.manage(config);

            // Initialize Gateway sidecar state
            app.manage(Mutex::new(commands::gateway::GatewaySidecar::new()));

            // Initialize WebSocket bridge state (used when WebView2 cannot connect directly to ws://127.0.0.1)
            app.manage(Arc::new(Mutex::new(commands::gw_bridge::GwBridgeState::new())));

            // Initialize the Process Plugin Manager (agy / claude / codex / cursor)
            app.manage(commands::process_plugin::ProcessPluginState(
                std::sync::Arc::new(commands::process_plugin::ProcessPluginManager::new())
            ));

            // Auto-start the Gateway sidecar (async, does not block the UI thread)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Let the window render the loading screen first
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                // Use spawn_blocking to avoid blocking the tokio runtime with synchronous I/O
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

            // Start the Plugin static file server (native Rust, port 18802)
            let plugins_dir = {
                let workspace = app.handle()
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                // Keep consistent with the Gateway's workspacePath: app_data_dir/data/plugins
                workspace.join("data").join("plugins")
            };

            // 以下同步重活（PowerShell 杀端口、递归复制插件目录、生成证书）曾直接在
            // setup 里跑：setup 结束前事件循环不启动、WebView 无法初始化，用户只能看
            // 数秒空白窗口。全部挪到 blocking 线程执行，保持原有顺序约束不变：
            // 杀端口 → 同步插件文件 → 证书就绪 → 插件静态服务器启动。
            let plugin_sync_handle = app.handle().clone();
            let plugin_sync_dir = plugins_dir.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || {
                    // Clean up the port possibly held by a leftover old process (dev hot-reload)
                    #[cfg(target_os = "windows")]
                    setup::kill_dev_port_3000();
                    // Sync Office plugin files (auto-refresh on first install / version upgrade)
                    setup::sync_office_plugins(&plugin_sync_handle, &plugin_sync_dir);
                    // Ensure dev certs exist before starting so HTTPS 18803 can come up (required by the Office add-in)
                    setup::ensure_dev_certs();
                }).await;
                plugin_server::start(plugins_dir, 18802).await;
            });



            eprintln!("[OpenFlux] Started v0.6.0 (gateway starting async)");
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // macOS: clicking the red button hides the window to the tray instead of quitting the app
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if cfg!(target_os = "macos") {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // Only stop the Gateway sidecar when the main window is destroyed.
                // Closing auxiliary windows (preview, popups, etc.) should not affect the Gateway.
                tauri::WindowEvent::Destroyed => {
                    if window.label() == "main" {
                        let app = window.app_handle();
                        if let Err(e) = commands::gateway::stop_gateway_sidecar(app) {
                            eprintln!("[OpenFlux] Gateway sidecar stop failed: {}", e);
                        }
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
            commands::system::splash_close,
            commands::system::set_locale_pref,
            brand::get_brand_config,
            commands::excel_plugin::excel_plugin_install,
            commands::excel_plugin::excel_plugin_uninstall,
            commands::excel_plugin::excel_plugin_status,
            commands::word_plugin::word_plugin_install,
            commands::word_plugin::word_plugin_uninstall,
            commands::word_plugin::word_plugin_status,
            commands::powerpoint_plugin::ppt_plugin_install,
            commands::powerpoint_plugin::ppt_plugin_uninstall,
            commands::powerpoint_plugin::ppt_plugin_status,
            commands::chrome_extension::chrome_extension_install,
            commands::chrome_extension::chrome_extension_uninstall,
            commands::chrome_extension::chrome_extension_status,
            commands::process_plugin::process_plugin_list_drivers,
            commands::process_plugin::process_plugin_call,
            commands::gw_bridge::gw_bridge_connect,
            commands::gw_bridge::gw_bridge_send,
            commands::gw_bridge::gw_bridge_disconnect,
            commands::update::check_app_update,
        ])
        .build(context)
        .expect("OpenFlux failed to build")
        .run(|app, event| {
            // On app exit, make sure the gateway is killed (fallback for the tray-quit path)
            if let tauri::RunEvent::Exit = event {
                let _ = commands::gateway::stop_gateway_sidecar(app);
            }
        });
}
