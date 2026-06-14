//! Gateway bundle management.
//!
//! Handles extraction of `gateway-bundle.tar.gz` from Tauri resources
//! into the app data directory, with version-aware re-extraction.

use std::path::{Path, PathBuf};

/// Extract `gateway-bundle.tar.gz` into `dest_dir`.
pub fn extract_gateway_bundle(tar_gz_path: &Path, dest_dir: &Path) -> Result<(), String> {
    eprintln!("[Gateway] Extracting gateway-bundle.tar.gz -> {:?}", dest_dir);

    let file = std::fs::File::open(tar_gz_path)
        .map_err(|e| format!("Failed to open gateway-bundle.tar.gz: {}", e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);

    archive
        .unpack(dest_dir)
        .map_err(|e| format!("Failed to extract tar.gz: {}", e))?;

    eprintln!("[Gateway] Extraction complete");
    Ok(())
}

/// Read the `gateway-build-id.txt` entry from the tar.gz without full extraction.
pub fn extract_build_id_from_bundle(resource_dir: &Path) -> String {
    use std::io::Read;
    let tar_path = resource_dir.join("gateway-bundle.tar.gz");
    let Ok(file) = std::fs::File::open(&tar_path) else {
        return String::new();
    };
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let Ok(entries) = archive.entries() else {
        return String::new();
    };
    for entry in entries.flatten() {
        let Ok(path) = entry.path() else { continue };
        if path.to_string_lossy() == "./gateway-build-id.txt"
            || path.to_string_lossy() == "gateway-build-id.txt"
        {
            let mut content = String::new();
            let mut e = entry;
            let _ = e.read_to_string(&mut content);
            return content;
        }
    }
    String::new()
}

/// Ensure the gateway runtime is extracted and up-to-date in `app_data_dir`.
///
/// Re-extracts when:
/// - The gateway start script is missing (first run).
/// - The app version changed (Tauri app upgraded).
/// - The embedded gateway build ID changed (gateway code updated independently).
///
/// Returns the path to the gateway data directory.
pub fn setup_gateway_runtime(resource_dir: &Path, app_data_dir: &Path) -> Result<PathBuf, String> {
    let gateway_data  = app_data_dir.join("gateway");
    let gateway_script = gateway_data.join("src").join("gateway").join("start.ts");
    let version_file  = gateway_data.join(".version");
    let build_id_file = gateway_data.join("gateway-build-id.txt");
    let app_version   = env!("CARGO_PKG_VERSION");

    let need_extract = if !gateway_script.exists() {
        eprintln!("[Gateway] Gateway script not found, need extraction");
        true
    } else if let Ok(cached_version) = std::fs::read_to_string(&version_file) {
        if cached_version.trim() != app_version {
            eprintln!(
                "[Gateway] App version mismatch: cached={}, app={}, re-extracting",
                cached_version.trim(),
                app_version
            );
            true
        } else {
            false
        }
    } else {
        eprintln!("[Gateway] No version marker found, re-extracting");
        true
    };

    if need_extract {
        let tar_path = resource_dir.join("gateway-bundle.tar.gz");
        if !tar_path.exists() {
            return Err(format!("gateway-bundle.tar.gz not found: {:?}", tar_path));
        }
        if gateway_data.exists() {
            std::fs::remove_dir_all(&gateway_data)
                .map_err(|e| format!("Failed to clean old gateway dir: {}", e))?;
        }
        std::fs::create_dir_all(&gateway_data)
            .map_err(|e| format!("Failed to create gateway dir: {}", e))?;
        extract_gateway_bundle(&tar_path, &gateway_data)?;
        let _ = std::fs::write(&version_file, app_version);
    } else {
        // Same app version — check if gateway build ID changed.
        let new_build_id = extract_build_id_from_bundle(resource_dir);
        let cached_build_id = std::fs::read_to_string(&build_id_file).unwrap_or_default();
        if !new_build_id.is_empty() && new_build_id.trim() != cached_build_id.trim() {
            eprintln!(
                "[Gateway] Gateway build ID changed: cached='{}', new='{}', re-extracting",
                cached_build_id.trim(),
                new_build_id.trim()
            );
            let tar_path = resource_dir.join("gateway-bundle.tar.gz");
            if gateway_data.exists() {
                std::fs::remove_dir_all(&gateway_data)
                    .map_err(|e| format!("Failed to clean old gateway dir: {}", e))?;
            }
            std::fs::create_dir_all(&gateway_data)
                .map_err(|e| format!("Failed to create gateway dir: {}", e))?;
            extract_gateway_bundle(&tar_path, &gateway_data)?;
            let _ = std::fs::write(&version_file, app_version);
        } else {
            eprintln!(
                "[Gateway] Gateway up-to-date (app={}, build_id={})",
                app_version,
                cached_build_id.trim()
            );
        }
    }

    Ok(gateway_data)
}
