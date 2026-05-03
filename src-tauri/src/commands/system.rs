use serde::Serialize;
use sysinfo::System;
use std::sync::Mutex;

/// JARVIS-style HUD metrics snapshot
#[derive(Debug, Serialize, Clone)]
pub struct SystemMetrics {
    /// CPU usage per core (0.0–100.0)
    pub cpu_cores: Vec<f32>,
    /// Overall CPU usage (0.0–100.0)
    pub cpu_total: f32,
    /// RAM: total bytes
    pub ram_total: u64,
    /// RAM: used bytes
    pub ram_used: u64,
    /// RAM: available bytes
    pub ram_available: u64,
    /// RAM: usage percentage
    pub ram_percent: f32,
    /// Swap: total bytes
    pub swap_total: u64,
    /// Swap: used bytes
    pub swap_used: u64,
    /// List of mounted disks
    pub disks: Vec<DiskInfo>,
    /// Network interfaces (name → bytes received, bytes transmitted)
    pub network: Vec<NetworkInterface>,
    /// System name (e.g. "Afrodita-Studio")
    pub system_name: String,
    /// Host name
    pub host_name: String,
    /// OS kernel version
    pub os_kernel: String,
    /// Time since machine was started (seconds)
    pub uptime: u64,
    /// JARVIS-style loading bar string (e.g. "████░░░░░░ 40%")
    pub cpu_hud_bar: String,
    pub ram_hud_bar: String,
}

/// Information about a mounted disk/partition
#[derive(Debug, Serialize, Clone)]
pub struct DiskInfo {
    pub name: String,
    pub mount_point: String,
    pub total_space: u64,
    pub available_space: u64,
    pub used_space: u64,
    pub usage_percent: f32,
    pub file_system: String,
    /// JARVIS-style HUD bar
    pub hud_bar: String,
}

/// Network interface statistics
#[derive(Debug, Serialize, Clone)]
pub struct NetworkInterface {
    pub name: String,
    pub bytes_received: u64,
    pub bytes_transmitted: u64,
}

/// Refresh interval in seconds (for polling mode)
static REFRESH_INTERVAL: Mutex<u64> = Mutex::new(1);

/// Global sysinfo System instance — persisted across calls for delta computation
static SYSTEM: Mutex<Option<sysinfo::System>> = Mutex::new(None);

/// Internal: get or initialize the global System
fn get_system() -> sysinfo::System {
    let mut global = SYSTEM.lock().unwrap();
    if global.is_none() {
        let mut s = System::new_with_specifics(sysinfo::System::new_all());
        s.refresh_all();
        // Give it a moment to collect baseline
        std::thread::sleep(std::time::Duration::from_millis(200));
        *global = Some(s);
    }
    // Re-create to avoid stale data while keeping the Mutex cheap
    let mut s = System::new_with_specifics(sysinfo::System::new_all());
    s.refresh_all();
    *global = Some(s);
    s
}

/// Build a JARVIS-style ASCII progress bar
fn hud_bar(percent: f32, width: usize) -> String {
    let filled = ((percent / 100.0) * width as f32).round() as usize;
    let empty = width.saturating_sub(filled);
    let filled_str = "█".repeat(filled);
    let empty_str = "░".repeat(empty);
    format!("{} {}%", format!("{}{}", filled_str, empty_str), percent as usize)
}

/// Refresh interval for background polling (default 1s)
#[tauri::command]
pub fn system_set_refresh_interval(seconds: u64) {
    let mut interval = REFRESH_INTERVAL.lock().unwrap();
    *interval = seconds.max(1);
}

/// Get full system metrics snapshot formatted for JARVIS HUD
#[tauri::command]
pub fn system_metrics() -> Result<SystemMetrics, String> {
    let s = get_system();

    let cpu_cores: Vec<f32> = s.cpus().iter().map(|c| c.cpu_usage()).collect();
    let cpu_total = s.global_cpu_usage();

    let ram_total = s.total_memory();
    let ram_used = s.used_memory();
    let ram_available = s.available_memory();
    let ram_percent = if ram_total > 0 {
        (ram_used as f32 / ram_total as f32) * 100.0
    } else {
        0.0
    };

    let swap_total = s.total_swap();
    let swap_used = s.used_swap();

    let disks: Vec<DiskInfo> = sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let available = d.available_space();
            let used = total.saturating_sub(available);
            let percent = if total > 0 {
                (used as f32 / total as f32) * 100.0
            } else {
                0.0
            };
            DiskInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                total_space: total,
                available_space: available,
                used_space: used,
                usage_percent: percent,
                file_system: d.file_system().to_string_lossy().to_string(),
                hud_bar: hud_bar(percent, 10),
            }
        })
        .collect();

    let network: Vec<NetworkInterface> = s
        .networks()
        .iter()
        .map(|(name, data)| NetworkInterface {
            name: name.clone(),
            bytes_received: data.total_received(),
            bytes_transmitted: data.total_transmitted(),
        })
        .collect();

    Ok(SystemMetrics {
        cpu_cores,
        cpu_total,
        ram_total,
        ram_used,
        ram_available,
        ram_percent,
        swap_total,
        swap_used,
        disks,
        network,
        system_name: System::name().unwrap_or_else(|| "Afrodita-Studio".to_string()),
        host_name: System::host_name().unwrap_or_else(|| "rendo-workstation".to_string()),
        os_kernel: System::kernel_version().unwrap_or_else(|| "unknown".to_string()),
        uptime: System::uptime(),
        cpu_hud_bar: hud_bar(cpu_total, 10),
        ram_hud_bar: hud_bar(ram_percent, 10),
    })
}

/// Quick CPU snapshot — lightweight, no disk/network scan
#[tauri::command]
pub fn system_cpu_quick() -> Result<CpuQuick, String> {
    let s = get_system();
    let cores: Vec<f32> = s.cpus().iter().map(|c| c.cpu_usage()).collect();
    Ok(CpuQuick {
        cores,
        total: s.global_cpu_usage(),
        hud_bar: hud_bar(s.global_cpu_usage(), 10),
    })
}

/// Quick RAM snapshot
#[tauri::command]
pub fn system_ram_quick() -> Result<RamQuick, String> {
    let s = get_system();
    let total = s.total_memory();
    let used = s.used_memory();
    let percent = if total > 0 { (used as f32 / total as f32) * 100.0 } else { 0.0 };
    Ok(RamQuick {
        total,
        used,
        available: s.available_memory(),
        percent,
        hud_bar: hud_bar(percent, 10),
    })
}

/// Lightweight CPU snapshot
#[derive(Debug, Serialize)]
pub struct CpuQuick {
    pub cores: Vec<f32>,
    pub total: f32,
    pub hud_bar: String,
}

/// Lightweight RAM snapshot
#[derive(Debug, Serialize)]
pub struct RamQuick {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub percent: f32,
    pub hud_bar: String,
}

/// Minimal process entry for task manager list
#[derive(Debug, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

/// List top N processes by CPU usage
#[tauri::command]
pub fn system_top_processes(limit: usize) -> Result<Vec<ProcessInfo>, String> {
    let s = get_system();
    let mut processes: Vec<ProcessInfo> = s
        .processes()
        .values()
        .map(|p| ProcessInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().to_string(),
            cpu_percent: p.cpu_usage(),
            memory_bytes: p.memory(),
        })
        .collect();

    processes.sort_by(|a, b| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap_or(std::cmp::Ordering::Equal));
    processes.truncate(limit.max(1).min(200));
    Ok(processes)
}

/// Disk space summary for a specific path
#[tauri::command]
pub fn system_disk_for_path(path: String) -> Result<DiskInfo, String> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let path_obj = std::path::Path::new(&path);

    // Find the disk that contains this path (longest mount_point prefix match)
    let best = disks.iter().filter_map(|d| {
        let mp = std::path::Path::new(d.mount_point());
        if path_obj.starts_with(mp) {
            let score = d.mount_point().len();
            Some((score, d))
        } else {
            None
        }
    }).max_by_key(|(score, _)| *score);

    match best {
        Some((_, d)) => {
            let total = d.total_space();
            let available = d.available_space();
            let used = total.saturating_sub(available);
            let percent = if total > 0 { (used as f32 / total as f32) * 100.0 } else { 0.0 };
            Ok(DiskInfo {
                name: d.name().to_string_lossy().to_string(),
                mount_point: d.mount_point().to_string_lossy().to_string(),
                total_space: total,
                available_space: available,
                used_space: used,
                usage_percent: percent,
                file_system: d.file_system().to_string_lossy().to_string(),
                hud_bar: hud_bar(percent, 10),
            })
        }
        None => Err(format!("No disk found for path: {}", path)),
    }
}
