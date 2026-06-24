pub mod commands;
pub mod config;
pub mod brand;
pub mod plugin_server;
pub mod tray;
pub mod utils;
pub mod setup;

use std::sync::{Arc, Mutex};
use tauri::Manager;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

            // Sync Office plugin files (auto-refresh on first install / version upgrade)
            setup::sync_office_plugins(app.handle(), &plugins_dir);

            // Clean up port 3000 possibly held by a leftover old process (old Rust process not fully exited on dev hot-reload)
            #[cfg(target_os = "windows")]
            setup::kill_dev_port_3000();

            tauri::async_runtime::spawn(async move {
                // Ensure dev certs exist before starting so HTTPS 18803 can come up (required by the Office add-in)
                let _ = tokio::task::spawn_blocking(setup::ensure_dev_certs).await;
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
            commands::process_plugin::process_plugin_list_drivers,
            commands::process_plugin::process_plugin_call,
            commands::gw_bridge::gw_bridge_connect,
            commands::gw_bridge::gw_bridge_send,
            commands::gw_bridge::gw_bridge_disconnect,
            commands::update::check_app_update,
        ])
        .build(tauri::generate_context!())
        .expect("OpenFlux failed to build")
        .run(|app, event| {
            // On app exit, make sure the gateway is killed (fallback for the tray-quit path)
            if let tauri::RunEvent::Exit = event {
                let _ = commands::gateway::stop_gateway_sidecar(app);
            }
        });
}
