use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

const DEFAULT_TIMEOUT_SECS: u64 = 12;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDownload {
    pub url: String,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub brand_id: String,
    #[serde(default)]
    pub channel: String,
    pub version: String,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub min_supported_version: Option<String>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub notes_url: Option<String>,
    #[serde(default)]
    pub download_page: Option<String>,
    #[serde(default)]
    pub downloads: std::collections::HashMap<String, ReleaseDownload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub force_update: bool,
    pub manifest: Option<ReleaseManifest>,
    pub download_url: Option<String>,
    pub download_page: Option<String>,
    pub platform_key: String,
    pub error: Option<String>,
}

fn platform_download_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x64";
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x64";
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
    )))]
    {
        return "unknown";
    }
}

/// Compare dotted numeric versions. Returns true when `latest` is newer than `current`.
fn is_version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.split('.')
            .filter_map(|part| part.split('-').next()?.parse().ok())
            .collect()
    };
    let a = parse(latest);
    let b = parse(current);
    let len = a.len().max(b.len());
    for i in 0..len {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av > bv {
            return true;
        }
        if av < bv {
            return false;
        }
    }
    false
}

fn is_version_older(current: &str, minimum: &str) -> bool {
    is_version_newer(minimum, current)
}

fn fetch_manifest(url: &str) -> Result<ReleaseManifest, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build();
    let response = agent
        .get(url)
        .set("Accept", "application/json")
        .set("User-Agent", "OpenFlux-Updater")
        .call()
        .map_err(|e| format!("request failed: {e}"))?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("HTTP {}", response.status()));
    }
    let value: Value = response
        .into_json()
        .map_err(|e| format!("invalid JSON: {e}"))?;
    serde_json::from_value(value).map_err(|e| format!("invalid manifest: {e}"))
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle, manifest_url: String) -> UpdateCheckResult {
    let current_version = app.package_info().version.to_string();
    let platform_key = platform_download_key().to_string();

    if manifest_url.trim().is_empty() {
        return UpdateCheckResult {
            current_version,
            latest_version: None,
            update_available: false,
            force_update: false,
            manifest: None,
            download_url: None,
            download_page: None,
            platform_key,
            error: Some("update feed URL is empty".into()),
        };
    }

    let url = manifest_url.trim().to_string();
    let fetch_result = tokio::task::spawn_blocking(move || fetch_manifest(&url)).await;

    match fetch_result {
        Ok(Ok(manifest)) => {
            let latest_version = manifest.version.clone();
            let update_available = is_version_newer(&latest_version, &current_version);
            let force_update = manifest
                .min_supported_version
                .as_deref()
                .map(|min| is_version_older(&current_version, min))
                .unwrap_or(false);
            let download_url = manifest
                .downloads
                .get(&platform_key)
                .map(|d| d.url.clone());
            let download_page = manifest.download_page.clone().or(manifest.notes_url.clone());

            UpdateCheckResult {
                current_version,
                latest_version: Some(latest_version),
                update_available,
                force_update,
                manifest: Some(manifest),
                download_url,
                download_page,
                platform_key,
                error: None,
            }
        }
        Ok(Err(err)) => UpdateCheckResult {
            current_version,
            latest_version: None,
            update_available: false,
            force_update: false,
            manifest: None,
            download_url: None,
            download_page: None,
            platform_key,
            error: Some(err),
        },
        Err(err) => UpdateCheckResult {
            current_version,
            latest_version: None,
            update_available: false,
            force_update: false,
            manifest: None,
            download_url: None,
            download_page: None,
            platform_key,
            error: Some(format!("update task failed: {err}")),
        },
    }
}
