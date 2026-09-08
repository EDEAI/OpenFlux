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

/// Ensure the bundled macOS Python framework is extracted into app data.
///
/// Python is kept in a tarball inside the signed application so Tauri does not
/// flatten framework symlinks while copying resources. The runtime is extracted
/// once per application version and is never taken from the host machine.
#[cfg(target_os = "macos")]
pub fn setup_python_runtime(resource_dir: &Path, app_data_dir: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let archive_path = resource_dir.join("python-runtime.tar.gz");
    if !archive_path.is_file() {
        return Err(format!(
            "Bundled macOS Python runtime not found: {:?}",
            archive_path
        ));
    }

    let python_dir = app_data_dir.join("python");
    let python_exe = python_dir.join("base").join("bin").join("python3");
    let version_file = python_dir.join(".openflux-runtime-version");
    let app_version = env!("CARGO_PKG_VERSION");
    let cached_version = std::fs::read_to_string(&version_file).unwrap_or_default();
    let need_extract = !python_exe.is_file() || cached_version.trim() != app_version;

    if need_extract {
        let staging_root = app_data_dir.join(".python-runtime-extracting");
        if staging_root.exists() {
            std::fs::remove_dir_all(&staging_root)
                .map_err(|e| format!("Failed to clean Python staging directory: {}", e))?;
        }
        std::fs::create_dir_all(&staging_root)
            .map_err(|e| format!("Failed to create Python staging directory: {}", e))?;

        eprintln!(
            "[Gateway] Extracting python-runtime.tar.gz -> {:?}",
            staging_root
        );
        let file = std::fs::File::open(&archive_path)
            .map_err(|e| format!("Failed to open python-runtime.tar.gz: {}", e))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&staging_root)
            .map_err(|e| format!("Failed to extract python-runtime.tar.gz: {}", e))?;

        let staged_python = staging_root.join("python");
        let staged_exe = staged_python.join("base").join("bin").join("python3");
        if !staged_exe.is_file() {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(format!(
                "Bundled Python archive has an invalid layout; missing {:?}",
                staged_exe
            ));
        }

        if python_dir.exists() {
            std::fs::remove_dir_all(&python_dir)
                .map_err(|e| format!("Failed to clean old Python runtime: {}", e))?;
        }
        std::fs::rename(&staged_python, &python_dir)
            .map_err(|e| format!("Failed to activate Python runtime: {}", e))?;
        let _ = std::fs::remove_dir_all(&staging_root);
        std::fs::write(&version_file, app_version)
            .map_err(|e| format!("Failed to write Python runtime version: {}", e))?;
    } else {
        eprintln!("[Gateway] Python runtime up-to-date (app={})", app_version);
    }

    let metadata = std::fs::metadata(&python_exe)
        .map_err(|e| format!("Failed to inspect bundled Python executable: {}", e))?;
    if metadata.permissions().mode() & 0o111 == 0 {
        std::fs::set_permissions(&python_exe, std::fs::Permissions::from_mode(0o755)).map_err(
            |e| {
                format!(
                    "Failed to mark bundled Python executable as executable: {}",
                    e
                )
            },
        )?;
    }

    eprintln!("[Gateway] Bundled Python ready: {:?}", python_exe);
    Ok(app_data_dir.to_path_buf())
}
