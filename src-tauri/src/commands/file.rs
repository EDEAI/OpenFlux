use serde::Serialize;
use std::path::Path;
use crate::utils::base64 as b64;

/// Check whether a file exists
#[tauri::command]
pub async fn file_exists(file_path: String) -> Result<bool, String> {
    Ok(Path::new(&file_path).exists())
}

/// Read file contents.
/// Returns a UTF-8 string for text files, base64 for binary files.
#[derive(Serialize)]
pub struct FileReadResult {
    pub content: String,
    pub mime_type: String,
    pub is_binary: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn file_read(file_path: String) -> Result<FileReadResult, String> {
    use std::fs;

    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let size = metadata.len();

    // Determine whether it is binary based on the extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let binary_exts = [
        "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg",
        "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm",
        "mp3", "wav", "ogg", "flac", "aac",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "zip", "rar", "7z", "tar", "gz",
        "exe", "dll", "so", "dylib",
    ];

    let image_exts = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg"];

    let is_binary = binary_exts.contains(&ext.as_str());

    let mime_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "ts" => "text/typescript",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "xml" => "text/xml",
        "yaml" | "yml" => "text/yaml",
        _ => if is_binary { "application/octet-stream" } else { "text/plain" },
    }
    .to_string();

    if is_binary {
        // Image files: return a base64 data URI
        if image_exts.contains(&ext.as_str()) {
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let mut encoded = String::new();
            encoded.push_str(&format!("data:{};base64,", mime_type));
            let b64str = b64::encode(&data);
            encoded.push_str(&b64str);
            Ok(FileReadResult {
                content: encoded,
                mime_type,
                is_binary: true,
                size,
            })
        } else if ext == "xlsx" || ext == "xls" {
            // Excel files: return base64-encoded raw data; the frontend parses it with SheetJS
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64str = b64::encode(&data);
            Ok(FileReadResult {
                content: b64str,
                mime_type,
                is_binary: true,
                size,
            })
        } else if ext == "docx" {
            // DOCX files: return base64-encoded raw data; the frontend parses it with mammoth.js
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64str = b64::encode(&data);
            Ok(FileReadResult {
                content: b64str,
                mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
                is_binary: true,
                size,
            })
        } else if ext == "pptx" || ext == "ppt" {
            // PPTX files: return base64-encoded raw data; the frontend parses and previews it
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64str = b64::encode(&data);
            Ok(FileReadResult {
                content: b64str,
                mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string(),
                is_binary: true,
                size,
            })
        } else if ext == "pdf" {
            // PDF files: return base64-encoded raw data; the frontend previews it in an iframe
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64str = b64::encode(&data);
            Ok(FileReadResult {
                content: b64str,
                mime_type,
                is_binary: true,
                size,
            })
        } else {
            // Do not read the contents of other binary files
            Ok(FileReadResult {
                content: String::new(),
                mime_type,
                is_binary: true,
                size,
            })
        }
    } else {
        // Text files
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        Ok(FileReadResult {
            content,
            mime_type,
            is_binary: false,
            size,
        })
    }
}

/// Open a file with the system default program
#[tauri::command]
pub async fn file_open(file_path: String) -> Result<(), String> {
    open::that(&file_path).map_err(|e| e.to_string())
}

/// Reveal a file in the file manager
#[tauri::command]
pub async fn file_reveal(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if let Some(_parent) = path.parent() {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .args(["/select,", &file_path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-R", &file_path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            open::that(parent.to_str().unwrap_or("")).map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        Err("无法获取父目录".to_string())
    }
}

/// Save a file to another location (Save As)
#[tauri::command]
pub async fn file_save_as(source_path: String, dest_path: String) -> Result<(), String> {
    std::fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Save base64 image data to the system temp directory and return the absolute path.
/// Used by the clipboard screenshot-paste feature.
#[tauri::command]
pub async fn save_temp_image(data_base64: String, ext: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Decode base64
    let bytes = b64::decode(&data_base64).map_err(|e| format!("base64 decode error: {}", e))?;

    // Generate a unique filename
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ext = if ext.starts_with('.') { ext } else { format!(".{}", ext) };
    let filename = format!("openflux_paste_{}{}", ts, ext);

    // Write to the system temp directory
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(&filename);
    std::fs::write(&file_path, &bytes).map_err(|e| format!("write error: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

// Base64 encode/decode has moved to crate::utils::base64

