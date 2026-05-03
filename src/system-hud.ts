/**
 * Afrodita System Metrics HUD
 * JARVIS-style system monitoring overlay
 * Displays CPU, RAM, Disk, Network via Tauri system_metrics commands
 */

import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiskInfo {
    name: string;
    mount_point: string;
    total_space: number;
    available_space: number;
    used_space: number;
    usage_percent: number;
    file_system: string;
    hud_bar: string;
}

export interface NetworkInterface {
    name: string;
    bytes_received: number;
    bytes_transmitted: number;
}

export interface SystemMetrics {
    cpu_cores: number[];
    cpu_total: number;
    ram_total: number;
    ram_used: number;
    ram_available: number;
    ram_percent: number;
    swap_total: number;
    swap_used: number;
    disks: DiskInfo[];
    network: NetworkInterface[];
    system_name: string;
    host_name: string;
    os_kernel: string;
    uptime: number;
    cpu_hud_bar: string;
    ram_hud_bar: string;
}

export interface CpuQuick {
    cores: number[];
    total: number;
    hud_bar: string;
}

export interface RamQuick {
    total: number;
    used: number;
    available: number;
    percent: number;
    hud_bar: string;
}

export interface ProcessInfo {
    pid: number;
    name: string;
    cpu_percent: number;
    memory_bytes: number;
}

// ─── HUD Overlay ─────────────────────────────────────────────────────────────

let hudPanel: HTMLElement | null = null;
let hudInterval: ReturnType<typeof setInterval> | null = null;

/** Format bytes to human readable string */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Format uptime in human readable form */
export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    return parts.join(' ') || '<1m';
}

/** Build a JARVIS-style mini-bar for a single value */
export function miniBar(percent: number, width = 8): string {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

// ─── Tauri Bridge ─────────────────────────────────────────────────────────────

export async function getSystemMetrics(): Promise<SystemMetrics> {
    return invoke<SystemMetrics>('system_metrics');
}

export async function getCpuQuick(): Promise<CpuQuick> {
    return invoke<CpuQuick>('system_cpu_quick');
}

export async function getRamQuick(): Promise<RamQuick> {
    return invoke<RamQuick>('system_ram_quick');
}

export async function getTopProcesses(limit = 10): Promise<ProcessInfo[]> {
    return invoke<ProcessInfo[]>('system_top_processes', { limit });
}

export async function getDiskForPath(path: string): Promise<DiskInfo> {
    return invoke<DiskInfo>('system_disk_for_path', { path });
}

export function setRefreshInterval(seconds: number): Promise<void> {
    return invoke<void>('system_set_refresh_interval', { seconds });
}

// ─── HUD Panel ────────────────────────────────────────────────────────────────

/**
 * Show the JARVIS-style system metrics HUD overlay.
 * @param updateIntervalMs Polling interval in milliseconds (default 2000)
 */
export function showSystemHUD(updateIntervalMs = 2000): void {
    hideSystemHUD();

    hudPanel = document.createElement('div');
    hudPanel.id = 'afrodita-syshud';
    hudPanel.innerHTML = buildHUDHTML();
    document.body.appendChild(hudPanel);

    // Close button
    hudPanel.querySelector('.syshud-close')?.addEventListener('click', hideSystemHUD);

    // Attach inner events
    attachHUDEvents();

    // Start polling
    refreshHUD();
    hudInterval = setInterval(refreshHUD, updateIntervalMs);
}

export function hideSystemHUD(): void {
    if (hudInterval) {
        clearInterval(hudInterval);
        hudInterval = null;
    }
    if (hudPanel) {
        hudPanel.remove();
        hudPanel = null;
    }
}

export function isHUDVisible(): boolean {
    return hudPanel !== null;
}

async function refreshHUD(): Promise<void> {
    if (!hudPanel) return;
    try {
        const m = await getSystemMetrics();
        updateHUDMetrics(m);
    } catch (e) {
        console.error('[Afrodita-SysHUD] refresh failed:', e);
    }
}

function updateHUDMetrics(m: SystemMetrics): void {
    if (!hudPanel) return;

    // CPU
    const cpuEl = hudPanel.querySelector('.syshud-cpu-total');
    if (cpuEl) {
        cpuEl.textContent = `${m.cpu_total.toFixed(1)}%`;
        (cpuEl as HTMLElement).style.setProperty('--fill', String(m.cpu_total / 100));
    }

    const cpuBarEl = hudPanel.querySelector('.syshud-cpu-bar');
    if (cpuBarEl) cpuBarEl.textContent = m.cpu_hud_bar;

    const cpuCoresEl = hudPanel.querySelector('.syshud-cpu-cores');
    if (cpuCoresEl) {
        (cpuCoresEl as HTMLElement).textContent = m.cpu_cores
            .map((c, i) => `${i}:${c.toFixed(0)}%`)
            .join('  ');
    }

    // RAM
    const ramEl = hudPanel.querySelector('.syshud-ram-used');
    if (ramEl) ramEl.textContent = `${formatBytes(m.ram_used)} / ${formatBytes(m.ram_total)}`;

    const ramPctEl = hudPanel.querySelector('.syshud-ram-pct');
    if (ramPctEl) ramPctEl.textContent = `${m.ram_percent.toFixed(1)}%`;

    const ramBarEl = hudPanel.querySelector('.syshud-ram-bar');
    if (ramBarEl) ramBarEl.textContent = m.ram_hud_bar;

    const ramAvailEl = hudPanel.querySelector('.syshud-ram-avail');
    if (ramAvailEl) ramAvailEl.textContent = `${formatBytes(m.ram_available)} dostupných`;

    // Disks
    const diskListEl = hudPanel.querySelector('.syshud-disks');
    if (diskListEl) {
        diskListEl.innerHTML = m.disks.map(d => `
            <div class="syshud-disk">
                <span class="syshud-disk-name">${d.mount_point}</span>
                <span class="syshud-disk-bar">${d.hud_bar}</span>
                <span class="syshud-disk-pct">${d.usage_percent.toFixed(0)}%</span>
                <span class="syshud-disk-space">${formatBytes(d.available_space)} volných z ${formatBytes(d.total_space)}</span>
            </div>
        `).join('');
    }

    // Network
    const netEl = hudPanel.querySelector('.syshud-net');
    if (netEl) {
        netEl.innerHTML = m.network.slice(0, 4).map(n => `
            <div class="syshud-net-iface">
                <span class="syshud-net-name">${n.name}</span>
                <span class="syshud-net-rx">↓ ${formatBytes(n.bytes_received)}</span>
                <span class="syshud-net-tx">↑ ${formatBytes(n.bytes_transmitted)}</span>
            </div>
        `).join('');
    }

    // System info
    const uptimeEl = hudPanel.querySelector('.syshud-uptime');
    if (uptimeEl) uptimeEl.textContent = `↑ ${formatUptime(m.uptime)}`;

    const kernelEl = hudPanel.querySelector('.syshud-kernel');
    if (kernelEl) kernelEl.textContent = m.os_kernel.split(' ')[0];
}

function buildHUDHTML(): string {
    return `
    <style>
    #afrodita-syshud {
        position: fixed;
        bottom: 80px;
        right: 20px;
        width: 340px;
        background: rgba(4, 8, 12, 0.92);
        border: 1px solid rgba(64, 196, 255, 0.35);
        border-radius: 12px;
        padding: 14px 16px;
        font-family: 'Courier New', monospace;
        font-size: 12px;
        color: #40c4ff;
        z-index: 99999;
        box-shadow: 0 0 24px rgba(64, 200, 255, 0.15), 0 0 48px rgba(64, 200, 255, 0.05);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
    }
    #afrodita-syshud .syshud-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
        border-bottom: 1px solid rgba(64, 200, 255, 0.2);
        padding-bottom: 8px;
    }
    #afrodita-syshud .syshud-title {
        font-size: 11px;
        color: rgba(64, 200, 255, 0.7);
        letter-spacing: 2px;
        text-transform: uppercase;
    }
    #afrodita-syshud .syshud-close {
        background: none;
        border: none;
        color: rgba(64, 200, 255, 0.5);
        cursor: pointer;
        font-size: 14px;
        padding: 0 2px;
    }
    #afrodita-syshud .syshud-close:hover { color: #40c4ff; }
    #afrodita-syshud .syshud-section { margin-bottom: 8px; }
    #afrodita-syshud .syshud-label { color: rgba(64, 200, 255, 0.5); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
    #afrodita-syshud .syshud-value { color: #e0f7ff; font-size: 13px; font-weight: bold; }
    #afrodita-syshud .syshud-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    #afrodita-syshud .syshud-bar { color: #40c4ff; letter-spacing: -1px; font-size: 11px; }
    #afrodita-syshud .syshud-cpu-cores { font-size: 10px; color: rgba(64, 200, 255, 0.6); margin-top: 2px; }
    #afrodita-syshud .syshud-disk { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
    #afrodita-syshud .syshud-disk-name { width: 60px; color: rgba(64, 200, 255, 0.7); font-size: 11px; }
    #afrodita-syshud .syshud-disk-bar { color: #40c4ff; font-size: 10px; }
    #afrodita-syshud .syshud-disk-pct { width: 32px; text-align: right; color: #e0f7ff; font-size: 11px; }
    #afrodita-syshud .syshud-disk-space { width: 100%; color: rgba(64, 200, 255, 0.5); font-size: 10px; padding-left: 66px; }
    #afrodita-syshud .syshud-net-iface { display: flex; gap: 8px; margin-bottom: 3px; font-size: 11px; }
    #afrodita-syshud .syshud-net-name { width: 70px; color: rgba(64, 200, 255, 0.7); }
    #afrodita-syshud .syshud-net-rx { color: #69f0ae; }
    #afrodita-syshud .syshud-net-tx { color: #ff8a65; }
    #afrodita-syshud .syshud-footer { border-top: 1px solid rgba(64, 200, 255, 0.15); padding-top: 6px; margin-top: 4px; display: flex; justify-content: space-between; }
    #afrodita-syshud .syshud-uptime, #afrodita-syshud .syshud-kernel { font-size: 10px; color: rgba(64, 200, 255, 0.4); }
    #afrodita-syshud .syshud-mini-btn {
        background: rgba(64, 200, 255, 0.08);
        border: 1px solid rgba(64, 200, 255, 0.25);
        border-radius: 6px;
        color: rgba(64, 200, 255, 0.7);
        font-size: 10px;
        padding: 4px 8px;
        cursor: pointer;
        margin-top: 6px;
        width: 100%;
    }
    #afrodita-syshud .syshud-mini-btn:hover { background: rgba(64, 200, 255, 0.15); color: #40c4ff; }
    #afrodita-syshud .syshud-procs { display: none; }
    #afrodita-syshud .syshud-procs.visible { display: block; }
    #afrodita-syshud .syshud-proc-row { display: flex; justify-content: space-between; font-size: 10px; color: rgba(64, 200, 255, 0.6); margin-bottom: 2px; }
    </style>
    <div class="syshud-header">
        <span class="syshud-title">◈ SYSHUD · AFRODITA</span>
        <button class="syshud-close">✕</button>
    </div>
    <div class="syshud-section">
        <div class="syshud-row">
            <span class="syshud-label">CPU</span>
            <span class="syshud-value syshud-cpu-total">—</span>
        </div>
        <div class="syshud-bar syshud-cpu-bar">░░░░░░░░░░</div>
        <div class="syshud-cpu-cores"></div>
    </div>
    <div class="syshud-section">
        <div class="syshud-row">
            <span class="syshud-label">RAM</span>
            <span class="syshud-value syshud-ram-used">—</span>
        </div>
        <div class="syshud-bar syshud-ram-bar">░░░░░░░░░░</div>
        <div class="syshud-row">
            <span></span>
            <span class="syshud-label syshud-ram-pct">—</span>
        </div>
        <div class="syshud-label syshud-ram-avail">—</div>
    </div>
    <div class="syshud-section">
        <div class="syshud-label">DISKY</div>
        <div class="syshud-disks"></div>
    </div>
    <div class="syshud-section">
        <div class="syshud-label">SÍŤ</div>
        <div class="syshud-net"></div>
    </div>
    <div class="syshud-footer">
        <span class="syshud-uptime">—</span>
        <span class="syshud-kernel">—</span>
    </div>
    <button class="syshud-mini-btn syshud-proc-btn">⊕ Top Processy</button>
    <div class="syshud-procs"></div>
    `;
}

async function attachHUDEvents(): Promise<void> {
    if (!hudPanel) return;

    const procBtn = hudPanel.querySelector('.syshud-proc-btn');
    const procEl = hudPanel.querySelector('.syshud-procs');

    procBtn?.addEventListener('click', async () => {
        if (!hudPanel) return;
        const procs = await getTopProcesses(8);
        const procEl = hudPanel.querySelector('.syshud-procs');
        if (procEl) {
            procEl.classList.toggle('visible');
            procEl.innerHTML = procs.map(p => `
                <div class="syshud-proc-row">
                    <span>${p.name.substring(0, 18)}</span>
                    <span>${p.cpu_percent.toFixed(0)}%</span>
                    <span>${formatBytes(p.memory_bytes)}</span>
                </div>
            `).join('');
        }
    });
}

// ─── Compact Version (for embedding in existing UI) ───────────────────────────

/** Returns HTML string for a compact system status bar (for embedding in HUD or status area) */
export function compactMetricsHTML(m: SystemMetrics): string {
    return `
        <span class="afro-metrics-compact">
            CPU <span class="am-cpu">${m.cpu_hud_bar}</span>
            RAM <span class="am-ram">${m.ram_hud_bar}</span>
            ${m.disks.map(d => `${d.mount_point} <span class="am-disk">${d.hud_bar}</span>`).join(' ')}
        </span>
    `;
}
