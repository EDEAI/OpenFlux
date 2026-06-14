//! Optional brand/theme configuration (brand.json) read at runtime.
//!
//! If `resources/.brands/brand.json` exists in the resource directory, this module
//! reads it and passes it through to the frontend (the `get_brand_config` command),
//! for customizations like colors / language / feature visibility. When the file is
//! absent it falls back to the built-in default config (the original look), without
//! affecting day-to-day development.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Fixed relative path of the brand config under the resource directory.
const BRAND_REL_PATH: [&str; 2] = [".brands", "brand.json"];

/// Built-in default config (fallback when there is no brand.json). Runtime fields only.
fn default_brand() -> Value {
    json!({
        "brandId": "openflux",
        "app": {
            "productName": "OpenFlux",
            "windowTitle": "OpenFlux"
        },
        "theme": {
            "primaryColor": "#6366f1",
            "mode": "light"
        },
        "language": {
            "enabled": ["zh", "en"],
            "default": "zh",
            "lockLanguage": false
        },
        "workModes": {
            "enabled": ["standalone", "router", "managed"],
            "default": "standalone",
            "lockMode": false
        },
        "audio": {
            "playbackEnabled": true
        },
        "features": {
            "scheduler": true,
            "wechatIntegration": true,
            "showcaseGallery": true,
            "codingAgents": false
        },
        "links": {},
        "strings": {}
    })
}

/// Parse debug-time environment variable overrides (only effective when set; handy for
/// debugging a brand look via `tauri dev` without packaging):
/// - `OPENFLUX_BRAND_FILE`: absolute path to brand.json (most explicit);
/// - otherwise `OPENFLUX_BRAND` (+ optional `OPENFLUX_BRANDS_DIR`): read from `<dir>/<brand>/brand.json`.
fn load_brand_from_env() -> Option<Value> {
    let file = if let Ok(f) = std::env::var("OPENFLUX_BRAND_FILE") {
        std::path::PathBuf::from(f)
    } else if let Ok(brand) = std::env::var("OPENFLUX_BRAND") {
        let dir = std::env::var("OPENFLUX_BRANDS_DIR").ok()?;
        std::path::PathBuf::from(dir).join(&brand).join("brand.json")
    } else {
        return None;
    };
    match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) => {
                eprintln!("[OpenFlux] (调试覆盖) 已加载品牌配置: {:?}", file);
                Some(v)
            }
            Err(e) => {
                eprintln!("[OpenFlux] (调试覆盖) 品牌配置解析失败({:?}): {}", file, e);
                None
            }
        },
        Err(e) => {
            eprintln!("[OpenFlux] (调试覆盖) 无法读取品牌配置({:?}): {}", file, e);
            None
        }
    }
}

/// Read the brand config: debug-time env override > `resources/.brands/brand.json` > default brand.
pub fn load_brand(app: &AppHandle) -> Value {
    if let Some(v) = load_brand_from_env() {
        return v;
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let mut path = resource_dir;
        for seg in BRAND_REL_PATH {
            path = path.join(seg);
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => {
                    eprintln!("[OpenFlux] 已加载品牌配置: {:?}", path);
                    return v;
                }
                Err(e) => eprintln!("[OpenFlux] 品牌配置解析失败({:?}): {}", path, e),
            }
        }
    }
    eprintln!("[OpenFlux] 未发现品牌配置，使用核心默认品牌");
    default_brand()
}

/// Called when the frontend starts up to get the (runtime) brand config.
#[tauri::command]
pub fn get_brand_config(app: AppHandle) -> Value {
    load_brand(&app)
}
