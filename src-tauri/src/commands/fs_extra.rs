use serde::Serialize;
use std::path::Path;
use std::fs;
use std::time::UNIX_EPOCH;
use std::os::unix::fs::MetadataExt;
use std::os::windows::fs::MetadataExt as WinMetaExt;

/// File/directory entry returned to the frontend
#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified: u64, // Unix timestamp (seconds)
    pub is_symlink: bool,
}

/// List directory contents
#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let entries = fs::read_dir(path_obj).map_err(|e| e.to_string())?;
    let mut result: Vec<FileEntry> = Vec::new();

    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // skip files we can't read
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let is_symlink = metadata.file_type().is_symlink();
        let is_directory = metadata.is_dir();
        let size = metadata.len();

        // Get modified time
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()))
            .unwrap_or(0);

        result.push(FileEntry {
            name,
            path: full_path,
            is_directory,
            size,
            modified,
            is_symlink,
        });
    }

    Ok(result)
}

/// Copy a file or directory to a destination path
#[tauri::command]
pub async fn fs_copy_entry(source_path: String, dest_path: String) -> Result<(), String> {
    let src = Path::new(&source_path);
    let dst = Path::new(&dest_path);

    if !src.exists() {
        return Err(format!("Source does not exist: {}", source_path));
    }

    if src.is_dir() {
        // Recursive copy directory
        copy_dir_recursive(src, dst).map_err(|e| e.to_string())?;
    } else {
        fs::copy(src, dst).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }

    Ok(())
}

/// Move/rename a file or directory
#[tauri::command]
pub async fn fs_move_entry(source_path: String, dest_path: String) -> Result<(), String> {
    std::fs::rename(&source_path, &dest_path).map_err(|e| e.to_string())
}

/// Delete a file or directory
#[tauri::command]
pub async fn fs_delete_entry(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Create a directory
#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}
