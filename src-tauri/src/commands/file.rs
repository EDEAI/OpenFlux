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


/// One entry in a directory listing.
#[derive(Serialize, Debug)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Last-modified time in epoch milliseconds; `None` when unavailable.
    pub modified: Option<u64>,
    pub is_hidden: bool,
}

/// Result of listing a directory. `truncated` tells the UI that the folder
/// holds more entries than were returned.
#[derive(Serialize, Debug)]
pub struct DirListResult {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
    pub total: usize,
    pub truncated: bool,
}

/// Directories with more entries than this are cut short: serialising tens of
/// thousands of rows over IPC stalls the UI, and no one browses that far.
const DIR_LIST_LIMIT: usize = 2000;

#[cfg(windows)]
fn entry_is_hidden(path: &Path, name: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    if name.starts_with('.') {
        return true;
    }
    std::fs::metadata(path)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn entry_is_hidden(_path: &Path, name: &str) -> bool {
    name.starts_with('.')
}

/// List a directory. Read-only: the panel's file view never creates, renames
/// or deletes anything, so no counterpart write command exists.
#[tauri::command]
pub async fn dir_list(dir_path: String, show_hidden: bool) -> Result<DirListResult, String> {
    read_dir_listing(&dir_path, show_hidden)
}

/// The listing itself, kept synchronous so it is directly testable.
fn read_dir_listing(dir_path: &str, show_hidden: bool) -> Result<DirListResult, String> {
    use std::fs;
    use std::time::UNIX_EPOCH;

    let path = Path::new(dir_path);
    if !path.exists() {
        return Err(format!("目录不存在: {}", dir_path));
    }
    if !path.is_dir() {
        return Err(format!("不是目录: {}", dir_path));
    }

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut total = 0usize;

    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        // A single unreadable entry (a permission-denied junction, a file
        // removed mid-scan) must not fail the whole listing.
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let entry_path = entry.path();
        let hidden = entry_is_hidden(&entry_path, &name);
        if hidden && !show_hidden {
            continue;
        }

        total += 1;
        if entries.len() >= DIR_LIST_LIMIT {
            continue;
        }

        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { metadata.as_ref().map(|m| m.len()).unwrap_or(0) };
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        entries.push(DirEntryInfo {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            size,
            modified,
            is_hidden: hidden,
        });
    }

    // Directories first, then case-insensitive name order, so the listing
    // matches what every file manager shows.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListResult {
        path: path.to_string_lossy().into_owned(),
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        truncated: total > entries.len(),
        entries,
        total,
    })
}

#[cfg(test)]
mod dir_list_tests {
    use super::*;
    use std::fs;

    struct TempTree(std::path::PathBuf);

    impl TempTree {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("openflux-dir-list-{}", name));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp tree");
            Self(dir)
        }

        fn dir(&self, name: &str) -> &Self {
            fs::create_dir_all(self.0.join(name)).expect("create dir");
            self
        }

        fn file(&self, name: &str, contents: &str) -> &Self {
            fs::write(self.0.join(name), contents).expect("write file");
            self
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(result: &DirListResult) -> Vec<&str> {
        result.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_directories_first_then_names_case_insensitively() {
        let tree = TempTree::new("order");
        tree.file("Beta.txt", "b").file("alpha.txt", "a").dir("zeta").dir("Alpha");

        let result = read_dir_listing(&tree.path(), false).expect("listing");
        assert_eq!(names(&result), vec!["Alpha", "zeta", "alpha.txt", "Beta.txt"]);
        assert!(result.entries[0].is_dir);
        assert!(!result.entries[2].is_dir);
    }

    #[test]
    fn hides_dotfiles_unless_asked() {
        let tree = TempTree::new("hidden");
        tree.file("visible.txt", "v").file(".secret", "s").dir(".git");

        let visible = read_dir_listing(&tree.path(), false).expect("listing");
        assert_eq!(names(&visible), vec!["visible.txt"]);
        assert_eq!(visible.total, 1, "filtered entries are not counted");

        let all = read_dir_listing(&tree.path(), true).expect("listing");
        assert_eq!(names(&all), vec![".git", ".secret", "visible.txt"]);
        assert!(all.entries.iter().find(|e| e.name == ".secret").unwrap().is_hidden);
    }

    #[test]
    fn reports_sizes_and_a_parent() {
        let tree = TempTree::new("meta");
        tree.file("data.txt", "0123456789").dir("sub");

        let result = read_dir_listing(&tree.path(), false).expect("listing");
        let file = result.entries.iter().find(|e| e.name == "data.txt").unwrap();
        assert_eq!(file.size, 10);
        assert!(file.modified.is_some());

        let dir_entry = result.entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(dir_entry.size, 0, "directories report no size");

        assert!(result.parent.is_some());
        assert!(!result.truncated);
    }

    #[test]
    fn rejects_missing_paths_and_files() {
        let tree = TempTree::new("errors");
        tree.file("a.txt", "a");

        let missing = read_dir_listing(&tree.0.join("nope").to_string_lossy(), false);
        assert!(missing.unwrap_err().contains("目录不存在"));

        let not_a_dir = read_dir_listing(&tree.0.join("a.txt").to_string_lossy(), false);
        assert!(not_a_dir.unwrap_err().contains("不是目录"));
    }
}
