//! 可选品牌/主题配置（brand.json）运行时读取。
//!
//! 若资源目录存在 `resources/.brands/brand.json`，本模块读取并透传给前端
//! （`get_brand_config` 命令），用于换色/语言/功能显隐等定制；
//! 文件不存在时回退到内置默认配置（原版外观），不影响日常开发。

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 资源目录下品牌配置的固定相对路径。
const BRAND_REL_PATH: [&str; 2] = [".brands", "brand.json"];

/// 内置默认配置（无 brand.json 时回退）。仅含运行时字段。
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
            "enabled": ["standalone", "team", "hosted"],
            "default": "standalone",
            "lockMode": false
        },
        "audio": {
            "playbackEnabled": true
        },
        "features": {
            "scheduler": true,
            "wechatIntegration": true,
            "showcaseGallery": true
        },
        "links": {},
        "strings": {}
    })
}

/// 解析调试期环境变量覆盖（仅在设置时生效，便于 `tauri dev` 调试某套品牌外观，无需打包）：
/// - `OPENFLUX_BRAND_FILE`：brand.json 的绝对路径（最显式）；
/// - 否则 `OPENFLUX_BRAND`(+ 可选 `OPENFLUX_BRANDS_DIR`)：从 `<dir>/<brand>/brand.json` 读取。
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

/// 读取品牌配置：调试期环境变量覆盖 > `resources/.brands/brand.json` > 默认品牌。
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

/// 前端启动时调用，获取（运行时）品牌配置。
#[tauri::command]
pub fn get_brand_config(app: AppHandle) -> Value {
    load_brand(&app)
}
