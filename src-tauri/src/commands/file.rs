use serde::Serialize;
use std::path::Path;

/// 检查文件是否存在
#[tauri::command]
pub async fn file_exists(file_path: String) -> Result<bool, String> {
    Ok(Path::new(&file_path).exists())
}

/// 读取文件内容
/// 对于文本文件返回 UTF-8 字符串，对于二进制文件返回 base64
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

    // 根据扩展名判断是否为二进制
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
        // 图片文件：返回 base64 data URI
        if image_exts.contains(&ext.as_str()) {
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let mut encoded = String::new();
            encoded.push_str(&format!("data:{};base64,", mime_type));
            let b64 = base64_encode(&data);
            encoded.push_str(&b64);
            Ok(FileReadResult {
                content: encoded,
                mime_type,
                is_binary: true,
                size,
            })
        } else if ext == "xlsx" || ext == "xls" {
            // Excel 文件：返回 base64 编码的原始数据，前端用 SheetJS 解析
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64 = base64_encode(&data);
            Ok(FileReadResult {
                content: b64,
                mime_type,
                is_binary: true,
                size,
            })
        } else if ext == "docx" {
            // DOCX 文件：返回 base64 编码的原始数据，前端用 mammoth.js 解析
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64 = base64_encode(&data);
            Ok(FileReadResult {
                content: b64,
                mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document".to_string(),
                is_binary: true,
                size,
            })
        } else if ext == "pptx" || ext == "ppt" {
            // PPTX 文件：返回 base64 编码的原始数据，前端解析预览
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64 = base64_encode(&data);
            Ok(FileReadResult {
                content: b64,
                mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation".to_string(),
                is_binary: true,
                size,
            })
        } else if ext == "pdf" {
            // PDF 文件：返回 base64 编码的原始数据，前端用 iframe 预览
            let data = fs::read(path).map_err(|e| e.to_string())?;
            let b64 = base64_encode(&data);
            Ok(FileReadResult {
                content: b64,
                mime_type,
                is_binary: true,
                size,
            })
        } else {
            // 其他二进制文件不读取内容
            Ok(FileReadResult {
                content: String::new(),
                mime_type,
                is_binary: true,
                size,
            })
        }
    } else {
        // 文本文件
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        Ok(FileReadResult {
            content,
            mime_type,
            is_binary: false,
            size,
        })
    }
}

/// 用系统默认程序打开文件
#[tauri::command]
pub async fn file_open(file_path: String) -> Result<(), String> {
    open::that(&file_path).map_err(|e| e.to_string())
}

/// 在文件管理器中定位文件
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

/// 文件另存为
#[tauri::command]
pub async fn file_save_as(source_path: String, dest_path: String) -> Result<(), String> {
    std::fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 将 base64 图片数据保存到系统临时目录，返回绝对路径
/// 用于剪贴板截图粘贴功能
#[tauri::command]
pub async fn save_temp_image(data_base64: String, ext: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // 解码 base64
    let bytes = base64_decode(&data_base64).map_err(|e| format!("base64 decode error: {}", e))?;

    // 生成唯一文件名
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let ext = if ext.starts_with('.') { ext } else { format!(".{}", ext) };
    let filename = format!("openflux_paste_{}{}", ts, ext);

    // 写入系统临时目录
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(&filename);
    std::fs::write(&file_path, &bytes).map_err(|e| format!("write error: {}", e))?;

    Ok(file_path.to_string_lossy().into_owned())
}

/// 简易 Base64 解码
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [0xFFu8; 256];
    for (i, &c) in CHARS.iter().enumerate() {
        table[c as usize] = i as u8;
    }

    let input = input.as_bytes();
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;

    for &c in input {
        if c == b'=' { break; }
        let val = table[c as usize];
        if val == 0xFF { continue; }
        buf = (buf << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buf >> bits) as u8);
        }
    }

    Ok(result)
}

/// 简易 Base64 编码（无外部依赖）
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}
