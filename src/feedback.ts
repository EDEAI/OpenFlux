/**
 * 反馈窗口独立脚本
 * 运行在 Tauri WebviewWindow 中的独立页面
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

// 窗口控制
document.getElementById('fb-minimize')?.addEventListener('click', () => appWindow.minimize());
document.getElementById('fb-close')?.addEventListener('click', () => appWindow.close());
document.getElementById('fb-cancel')?.addEventListener('click', () => appWindow.close());

// 标题栏拖拽
const headerEl = document.querySelector('.fb-header');
if (headerEl) {
    headerEl.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        appWindow.startDragging();
    });
}

// 反馈逻辑
function initFeedback(): void {
    const titleInput = document.getElementById('fb-title') as HTMLInputElement;
    const contentInput = document.getElementById('fb-content') as HTMLTextAreaElement;
    const contactInput = document.getElementById('fb-contact') as HTMLInputElement;

    const fileInput = document.getElementById('fb-file-input') as HTMLInputElement;
    const addFileBtn = document.getElementById('fb-add-file');
    const fileListEl = document.getElementById('fb-file-list')!;
    const hintEl = document.getElementById('fb-hint')!;
    const submitBtn = document.getElementById('fb-submit') as HTMLButtonElement;
    const typeBtns = document.querySelectorAll('.fb-type-btn');

    let feedbackType = 'bug_report';
    let selectedFiles: File[] = [];

    // 类型切换
    typeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            typeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            feedbackType = (btn as HTMLElement).dataset.type || 'bug_report';
        });
    });

    // 附件
    addFileBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
        if (!fileInput.files) return;
        for (const file of Array.from(fileInput.files)) {
            if (selectedFiles.length >= 6) {
                setHint('附件数量不能超过6个', 'error');
                break;
            }
            if (file.size > 10 * 1024 * 1024) {
                setHint(`附件过大（最大10MB）：${file.name}`, 'error');
                continue;
            }
            selectedFiles.push(file);
        }
        fileInput.value = '';
        renderFiles();
    });

    function renderFiles(): void {
        fileListEl.innerHTML = '';
        selectedFiles.forEach((file, idx) => {
            const item = document.createElement('div');
            item.className = 'fb-file-item';
            const sizeMB = (file.size / 1024 / 1024).toFixed(1);
            item.innerHTML = `<span class="fname">${file.name} (${sizeMB}MB)</span><button class="fremove" data-idx="${idx}">&times;</button>`;
            fileListEl.appendChild(item);
        });
        fileListEl.querySelectorAll('.fremove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
                selectedFiles.splice(idx, 1);
                renderFiles();
            });
        });
    }

    function setHint(msg: string, cls: string): void {
        hintEl.textContent = msg;
        hintEl.className = 'fb-hint' + (cls ? ` ${cls}` : '');
    }

    // 提交
    submitBtn.addEventListener('click', async () => {
        if (!titleInput.value.trim()) { setHint('请输入标题', 'error'); return; }
        if (!contentInput.value.trim()) { setHint('请输入详细描述', 'error'); return; }

        submitBtn.disabled = true;
        setHint('提交中...', '');

        try {


            const payload: Record<string, any> = {
                feedback_type: feedbackType,
                title: titleInput.value.trim(),
                content: contentInput.value.trim(),
                source: 'openflux-desktop',

                client_platform: 'desktop',
                client_os: navigator.platform?.toLowerCase().includes('win') ? 'windows'
                    : navigator.platform?.toLowerCase().includes('mac') ? 'macos' : 'linux',
            };

            // 版本号
            try {
                const { getVersion } = await import('@tauri-apps/api/app');
                payload.app_version = await getVersion();
            } catch { /* non-Tauri */ }

            // NexusAI 账号（从 localStorage 读取，主窗口登录时已存储）
            // NexusAI 账号
            const savedUsername = localStorage.getItem('nexusai-username');
            if (savedUsername) payload.nexus_account = savedUsername;

            if (contactInput.value.trim()) payload.contact = contactInput.value.trim();

            const formData = new FormData();
            formData.append('payload', JSON.stringify(payload));
            for (const file of selectedFiles) {
                formData.append('files', file);
            }

            const resp = await fetch('https://openflux.io/console/api/feedback/submit', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`${resp.status}: ${errText}`);
            }

            const result = await resp.json();
            console.log('[Feedback] Submitted:', result);
            setHint('反馈提交成功，感谢您的反馈！', 'success');

            // 2 秒后自动关闭
            setTimeout(() => appWindow.close(), 2000);
        } catch (err) {
            console.error('[Feedback] Error:', err);
            setHint(String(err), 'error');
            submitBtn.disabled = false;
        }
    });
}

initFeedback();
