use serde::Deserialize;
use std::path::PathBuf;

/// Application config (read from openflux.yaml and server-config.json)
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub config_dir: PathBuf,
}

/// Remote connection config in openflux.yaml
#[derive(Deserialize, Default)]
struct YamlConfig {
    remote: Option<RemoteConfig>,
}

#[derive(Deserialize, Default)]
struct RemoteConfig {
    host: Option<String>,
    port: Option<u16>,
    token: Option<String>,
}

/// Load configuration
pub fn load_config(_app: &tauri::AppHandle) -> Result<AppConfig, Box<dyn std::error::Error>> {
    // Default config directory: next to the executable
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    // Try to read openflux.yaml
    let yaml_path = exe_dir.join("openflux.yaml");
    let yaml_config: YamlConfig = if yaml_path.exists() {
        let content = std::fs::read_to_string(&yaml_path)?;
        serde_yaml::from_str(&content).unwrap_or_default()
    } else {
        YamlConfig::default()
    };

    let remote = yaml_config.remote.unwrap_or_default();

    Ok(AppConfig {
        host: remote.host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port: remote.port.unwrap_or(18801),
        token: remote.token,
        config_dir: exe_dir,
    })
}
