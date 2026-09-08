use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

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
    let parse = |value: &str| semver::Version::parse(value.trim().trim_start_matches('v'));
    match (parse(latest), parse(current)) {
        (Ok(latest), Ok(current)) => latest > current,
        _ => false,
    }
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
            let download_url = manifest.downloads.get(&platform_key).map(|d| d.url.clone());
            let download_page = manifest
                .download_page
                .clone()
                .or(manifest.notes_url.clone());

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

/// A checked, signature-bearing Tauri update waiting for the user's one-time confirmation.
/// The legacy manifest remains responsible for release notes and minimum-version policy;
/// this pending object is sourced from the separate signed updater feed.
#[derive(Default)]
pub struct PendingAppUpdate(pub Mutex<Option<Update>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateMetadata {
    pub current_version: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum SignedUpdateEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Downloaded,
    Verified,
}

fn validate_signed_feed_url(url: &tauri::Url) -> Result<(), String> {
    if url.scheme() == "https" {
        return Ok(());
    }

    #[cfg(debug_assertions)]
    {
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if url.scheme() == "http" && local {
            return Ok(());
        }
    }

    Err("signed updater feed must use HTTPS".into())
}

fn same_version(left: &str, right: &str) -> bool {
    let parse = |value: &str| semver::Version::parse(value.trim().trim_start_matches('v'));
    matches!((parse(left), parse(right)), (Ok(left), Ok(right)) if left == right)
}

/// Check the signed updater feed only after the user chooses to update. The expected
/// version comes from the legacy feed so a stale or mismatched signed feed cannot install
/// an unexpected release.
#[tauri::command]
pub async fn prepare_signed_app_update(
    app: AppHandle,
    pending: State<'_, PendingAppUpdate>,
    manifest_url: String,
    expected_version: String,
) -> Result<Option<SignedUpdateMetadata>, String> {
    let endpoint: tauri::Url = manifest_url
        .trim()
        .parse()
        .map_err(|e| format!("invalid signed updater feed URL: {e}"))?;
    validate_signed_feed_url(&endpoint)?;

    // Never reuse a previously checked update after the release policy has changed.
    *pending
        .0
        .lock()
        .map_err(|_| "pending updater state is unavailable".to_string())? = None;

    let cleanup_handle = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .timeout(std::time::Duration::from_secs(30))
        .on_before_exit(move || {
            let _ = super::gateway::stop_gateway_sidecar(&cleanup_handle);
            cleanup_handle.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    if !same_version(&update.version, &expected_version) {
        return Err(format!(
            "signed updater feed version {} does not match announced version {}",
            update.version, expected_version
        ));
    }

    let metadata = SignedUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
    };
    *pending
        .0
        .lock()
        .map_err(|_| "pending updater state is unavailable".to_string())? = Some(update);
    Ok(Some(metadata))
}

/// Download, signature-check, install and relaunch a previously prepared update.
#[tauri::command]
pub async fn install_signed_app_update(
    app: AppHandle,
    pending: State<'_, PendingAppUpdate>,
    on_event: Channel<SignedUpdateEvent>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "pending updater state is unavailable".to_string())?
        .take()
        .ok_or_else(|| "there is no prepared update".to_string())?;

    let progress_channel = on_event.clone();
    let downloaded_channel = on_event.clone();
    let mut started = false;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    let _ = progress_channel.send(SignedUpdateEvent::Started { content_length });
                    started = true;
                }
                let _ = progress_channel.send(SignedUpdateEvent::Progress { chunk_length });
            },
            move || {
                let _ = downloaded_channel.send(SignedUpdateEvent::Downloaded);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // Update::download returns only after the Ed25519 signature has been validated.
    let _ = on_event.send(SignedUpdateEvent::Verified);
    update.install(bytes).map_err(|e| e.to_string())?;

    // Windows exits from Update::install and the NSIS /R argument relaunches the app.
    // Other desktop platforms need an explicit restart after the bundle is replaced.
    #[cfg(not(target_os = "windows"))]
    app.restart();

    #[cfg(target_os = "windows")]
    let _ = app;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_version_newer, same_version, validate_signed_feed_url};

    #[test]
    fn compares_semver_prereleases_correctly() {
        assert!(is_version_newer("1.0.0", "1.0.0-beta.1"));
        assert!(is_version_newer("1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(!is_version_newer("1.0.0-beta.1", "1.0.0"));
    }

    #[test]
    fn accepts_v_prefix_when_matching_signed_feed() {
        assert!(same_version("v1.0.1", "1.0.1"));
        assert!(!same_version("1.0.2", "1.0.1"));
    }

    #[test]
    fn rejects_non_https_remote_feeds() {
        let remote: tauri::Url = "http://example.com/update.json".parse().unwrap();
        assert!(validate_signed_feed_url(&remote).is_err());
        let secure: tauri::Url = "https://openflux.io/update.json".parse().unwrap();
        assert!(validate_signed_feed_url(&secure).is_ok());
    }
}
