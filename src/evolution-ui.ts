/**
 * Evolution UI Module
 * 前端进化交互：确认弹窗 + 设置面板「进化」tab 数据加载
 */

import type { GatewayClient, EvolutionConfirmRequest } from './gateway-client';

let _client: GatewayClient | null = null;

/**
 * 初始化进化 UI 系统
 */
export function initEvolutionUI(client: GatewayClient): void {
    _client = client;
    injectConfirmStyles();
    injectConfirmDialog();
    injectEvolutionTabStyles();
    injectForgeToastContainer();

    // 监听确认请求
    client.onEvolutionConfirm((request) => {
        showConfirmDialog(request, (approved) => {
            client.respondEvolutionConfirm(request.requestId, approved);
            // 工具确认后（无论批准还是取消），延迟刷新进化 Tab 数据
            if (approved) {
                setTimeout(() => loadEvolutionData(client), 1500);
            }
        });
    });

    // 监听锻造建议
    client.onForgeSuggestion((suggestion) => {
        showForgeSuggestion(client, suggestion);
    });

    // 绑定设置面板「进化」tab 刷新
    bindEvolutionTab(client);

    console.log('[EvolutionUI] Initialized');
}

/**
 * 刷新进化 tab 数据（外部可调用，切换到进化 tab 时触发）
 */
export async function refreshEvolutionTab(): Promise<void> {
    if (!_client) return;
    await loadEvolutionData(_client);
}

// ========================
// 设置面板「进化」tab
// ========================

function bindEvolutionTab(client: GatewayClient): void {
    const refreshBtn = document.getElementById('evo-refresh-btn');
    refreshBtn?.addEventListener('click', () => loadEvolutionData(client));

    // 监听 settings tab 切换，自动刷新
    document.querySelectorAll('.settings-tab[data-tab="evolution"]').forEach(tab => {
        tab.addEventListener('click', () => loadEvolutionData(client));
    });

    // 监听技能安装/卸载事件，实时刷新
    client.onSkillsUpdated(() => loadEvolutionData(client));

    // 事件委托：卸载/删除（只绑定一次）
    document.getElementById('settings-tab-evolution')?.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('[data-evo-action]') as HTMLElement;
        if (!btn) return;
        const action = btn.dataset.evoAction;
        const listItem = btn.closest('.evo-list-item') as HTMLElement;
        if (!listItem) return;

        // 已在确认状态，不重复触发
        if (btn.dataset.confirming === 'true') return;

        // 第一次点击：显示内联确认 UI
        if (!btn.dataset.confirmed) {
            btn.dataset.confirming = 'true';
            const originalText = btn.textContent || '';

            // 替换按钮为确认/取消
            const btnContainer = document.createElement('div');
            btnContainer.className = 'evo-confirm-inline';
            btnContainer.innerHTML = `
                <button class="evo-list-item-btn evo-btn-confirm" data-role="yes">确认${originalText}</button>
                <button class="evo-list-item-btn evo-btn-cancel" data-role="no">取消</button>
            `;
            btn.style.display = 'none';
            btn.parentElement?.appendChild(btnContainer);

            // 3秒后自动取消
            const autoCancel = setTimeout(() => {
                btnContainer.remove();
                btn.style.display = '';
                delete btn.dataset.confirming;
            }, 3000);

            btnContainer.querySelector('[data-role="no"]')?.addEventListener('click', (ev) => {
                ev.stopPropagation();
                clearTimeout(autoCancel);
                btnContainer.remove();
                btn.style.display = '';
                delete btn.dataset.confirming;
            });

            btnContainer.querySelector('[data-role="yes"]')?.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                clearTimeout(autoCancel);
                btnContainer.innerHTML = '<span class="evo-inline-status">处理中...</span>';
                try {
                    if (action === 'uninstall-skill') {
                        const slug = btn.dataset.slug;
                        if (slug) await client.uninstallSkill(slug);
                    } else if (action === 'delete-tool') {
                        const name = btn.dataset.name;
                        if (name) await client.deleteCustomTool(name);
                    } else if (action === 'delete-forged') {
                        const id = btn.dataset.forgedId;
                        if (id) await client.deleteForgedSkill(id);
                    }
                    // 成功反馈
                    listItem.style.opacity = '0.5';
                    listItem.style.transition = 'opacity 0.3s';
                    btnContainer.innerHTML = '<span class="evo-inline-status evo-status-done">✓ 已删除</span>';
                    setTimeout(() => loadEvolutionData(client), 600);
                } catch (err: any) {
                    btnContainer.innerHTML = `<span class="evo-inline-status evo-status-error">失败: ${escHtml(err.message || '未知错误')}</span>`;
                    setTimeout(() => {
                        btnContainer.remove();
                        btn.style.display = '';
                        delete btn.dataset.confirming;
                    }, 2000);
                }
            });
            return;
        }
    });
}

async function loadEvolutionData(client: GatewayClient): Promise<void> {
    const hintEl = document.getElementById('evo-refresh-hint');
    try {
        if (hintEl) hintEl.textContent = '加载中...';

        // 统计
        const stats = await client.getEvolutionStats();
        const skillsNum = document.getElementById('evo-stat-skills');
        const toolsNum = document.getElementById('evo-stat-tools');
        if (skillsNum) skillsNum.textContent = String(stats.stats.installedSkills);
        if (toolsNum) toolsNum.textContent = String(stats.stats.customTools);

        // 技能列表
        const { skills } = await client.getInstalledSkills();
        const skillsList = document.getElementById('evo-skills-list');
        if (skillsList) {
            if (skills.length === 0) {
                skillsList.innerHTML = '<div class="evo-empty-hint">暂无已安装技能<br><span class="evo-sub-hint">在对话中让 Agent 搜索并安装技能</span></div>';
            } else {
                skillsList.innerHTML = skills.map((s: any) => `
                    <div class="evo-list-item">
                        <div class="evo-list-item-info">
                            <div class="evo-list-item-name">📚 ${escHtml(s.slug)}</div>
                            ${s.description ? `<div class="evo-list-item-desc">${escHtml(s.description)}</div>` : ''}
                            <div class="evo-list-item-meta">${fmtDate(s.installedAt)}</div>
                        </div>
                        <button class="evo-list-item-btn evo-btn-danger" data-evo-action="uninstall-skill" data-slug="${escAttr(s.slug)}">卸载</button>
                    </div>
                `).join('');
            }
        }

        // 工具列表
        const { tools } = await client.getCustomTools();
        const toolsList = document.getElementById('evo-tools-list');
        if (toolsList) {
            if (tools.length === 0) {
                toolsList.innerHTML = '<div class="evo-empty-hint">暂无自定义工具<br><span class="evo-sub-hint">在对话中让 Agent 创建工具</span></div>';
            } else {
                toolsList.innerHTML = tools.map((t: any) => `
                    <div class="evo-list-item">
                        <div class="evo-list-item-info">
                            <div class="evo-list-item-name">
                                🛠️ ${escHtml(t.name)}
                                <span class="evo-tag evo-tag-${t.validatorResult.toLowerCase()}">${escHtml(t.validatorResult)}</span>
                                ${t.confirmed ? '<span class="evo-tag evo-tag-pass">已启用</span>' : '<span class="evo-tag evo-tag-warn">待确认</span>'}
                            </div>
                            <div class="evo-list-item-desc">${escHtml(t.description)}</div>
                            <div class="evo-list-item-meta">${escHtml(t.scriptType)} · ${fmtDate(t.createdAt)}</div>
                        </div>
                        <button class="evo-list-item-btn evo-btn-danger" data-evo-action="delete-tool" data-name="${escAttr(t.name)}">删除</button>
                    </div>
                `).join('');
            }
        }



        // 锻造技能列表
        const { skills: forgedSkills } = await client.getForgedSkills();
        const forgedNum = document.getElementById('evo-stat-forged');
        if (forgedNum) forgedNum.textContent = String(forgedSkills.length);
        const forgedList = document.getElementById('evo-forged-list');
        if (forgedList) {
            if (forgedSkills.length === 0) {
                forgedList.innerHTML = '<div class="evo-empty-hint">暂无锻造技能<br><span class="evo-sub-hint">多轮对话后 Agent 会自动分析并建议技能</span></div>';
            } else {
                forgedList.innerHTML = forgedSkills.map((s: any) => `
                    <div class="evo-list-item">
                        <div class="evo-list-item-info">
                            <div class="evo-list-item-name">
                                ✨ ${escHtml(s.title)}
                                <span class="evo-tag evo-tag-forged">${escHtml(s.category)}</span>
                            </div>
                            <div class="evo-list-item-desc">${escHtml(s.reasoning)}</div>
                            <div class="evo-list-item-meta">锻造于 ${fmtDate(s.createdAt)}</div>
                        </div>
                        <button class="evo-list-item-btn evo-btn-danger" data-evo-action="delete-forged" data-forged-id="${escAttr(s.id)}">删除</button>
                    </div>
                `).join('');
            }
        }

        if (hintEl) hintEl.textContent = '';
    } catch (err) {
        console.error('[EvolutionUI] Load failed:', err);
        if (hintEl) hintEl.textContent = '加载失败';
    }
}

// ========================
// 确认弹窗
// ========================

function showConfirmDialog(request: EvolutionConfirmRequest, onRespond: (approved: boolean) => void): void {
    const messagesContainer = document.getElementById('messages');
    if (!messagesContainer) return;

    const badgeClass = request.validationStatus === 'PASS' ? 'evo-tag-pass' : 'evo-tag-warn';
    const badgeText = request.validationStatus === 'PASS' ? '✅ 安全' : '⚠️ 需注意';
    const bodyHtml = request.confirmMessage
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const cardId = `evo-confirm-${Date.now()}`;
    const cardHtml = `
    <div class="message assistant" id="${cardId}">
        <div class="message-bubble">
            <div class="evo-confirm-card">
                <div class="evo-confirm-card-header">
                    <span class="evo-confirm-card-icon">🛠️</span>
                    <span class="evo-confirm-card-title">新工具确认：${escHtml(request.toolName)}</span>
                    <span class="evo-tag ${badgeClass}">${badgeText}</span>
                </div>
                <div class="evo-confirm-card-body">${bodyHtml}</div>
                <div class="evo-confirm-card-actions">
                    <button class="evo-confirm-card-btn evo-confirm-card-btn-cancel" data-action="reject">取消</button>
                    <button class="evo-confirm-card-btn evo-confirm-card-btn-approve" data-action="approve">启用工具</button>
                </div>
            </div>
        </div>
    </div>`;

    messagesContainer.insertAdjacentHTML('beforeend', cardHtml);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    const card = document.getElementById(cardId);
    if (!card) return;

    const handleClick = (e: Event) => {
        const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement;
        if (!btn) return;
        const action = btn.dataset.action;
        card.removeEventListener('click', handleClick);

        const actionsEl = card.querySelector('.evo-confirm-card-actions');
        if (actionsEl) {
            if (action === 'approve') {
                actionsEl.innerHTML = '<span style="color: var(--color-primary, #6366f1); font-size: 13px;">✅ 已启用</span>';
                onRespond(true);
            } else {
                actionsEl.innerHTML = '<span style="color: var(--color-text-secondary, #888); font-size: 13px;">❌ 已取消</span>';
                onRespond(false);
            }
        }
    };
    card.addEventListener('click', handleClick);
}

/** @deprecated overlay dialog no longer used, replaced by in-chat card */
function injectConfirmDialog(): void {
    // no-op: confirm is now rendered inline in chat
}

// ========================
// CSS 注入
// ========================

function injectConfirmStyles(): void {
    if (document.getElementById('evo-confirm-styles')) return;
    const css = `
/* 会话内确认卡片 */
.evo-confirm-card {
    border: 1px solid var(--color-border, rgba(255,255,255,0.08));
    border-radius: var(--radius-md, 12px);
    overflow: hidden;
}
.evo-confirm-card-header {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px;
    background: var(--color-bg-tertiary, rgba(0,0,0,0.15));
    border-bottom: 1px solid var(--color-border, rgba(255,255,255,0.06));
}
.evo-confirm-card-icon { font-size: 18px; flex-shrink: 0; }
.evo-confirm-card-title {
    flex: 1; font-size: 14px; font-weight: 600;
    color: var(--color-text, #e0e0e0);
}
.evo-confirm-card-body {
    font-size: 13px; line-height: 1.7;
    color: var(--color-text-secondary, #a0a0b0);
    padding: 12px 16px; max-height: 200px; overflow-y: auto;
}
.evo-confirm-card-body strong { color: var(--color-text, #e0e0e0); }
.evo-confirm-card-actions {
    display: flex; gap: 10px; justify-content: flex-end;
    padding: 10px 16px;
    border-top: 1px solid var(--color-border, rgba(255,255,255,0.06));
}
.evo-confirm-card-btn {
    padding: 6px 18px; border: none; border-radius: var(--radius-sm, 8px);
    font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s;
}
.evo-confirm-card-btn-cancel {
    background: var(--color-bg-tertiary, rgba(255,255,255,0.06));
    color: var(--color-text-secondary, #a0a0b0);
}
.evo-confirm-card-btn-cancel:hover {
    background: rgba(255,255,255,0.1);
    color: var(--color-text, #e0e0e0);
}
.evo-confirm-card-btn-approve {
    background: var(--color-primary, #6366f1); color: white;
}
.evo-confirm-card-btn-approve:hover { opacity: 0.85; }
`;
    const style = document.createElement('style');
    style.id = 'evo-confirm-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

function injectEvolutionTabStyles(): void {
    if (document.getElementById('evo-tab-styles')) return;
    const css = `
/* 进化 Tab 统计卡片 */
.evo-stats-row { display: flex; gap: 16px; margin-bottom: 20px; }
.evo-stats-card {
    flex: 1; padding: 16px 20px; border-radius: var(--radius-md, 12px);
    background: var(--color-bg-tertiary, rgba(0,0,0,0.15));
    border: 1px solid var(--color-border, rgba(255,255,255,0.06));
    text-align: center;
}
.evo-stats-num { font-size: 28px; font-weight: 700; color: var(--color-primary, #6366f1); }
.evo-stats-label { font-size: 13px; color: var(--color-text-secondary, #a0a0b0); margin-top: 4px; }

/* 列表 */
.evo-list { margin-bottom: 20px; }
.evo-list-item {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 12px 14px; border-radius: var(--radius-md, 10px);
    background: var(--color-bg-tertiary, rgba(0,0,0,0.1));
    border: 1px solid var(--color-border, rgba(255,255,255,0.06));
    margin-bottom: 8px; transition: background 0.2s, border-color 0.2s;
}
.evo-list-item:hover {
    background: var(--color-bg-secondary, rgba(255,255,255,0.04));
    border-color: var(--color-primary, #6366f1);
}
.evo-list-item-info { flex: 1; min-width: 0; }
.evo-list-item-name {
    font-size: 14px; font-weight: 500; color: var(--color-text, #e0e0e0);
    display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
}
.evo-list-item-desc {
    font-size: 13px; color: var(--color-text-secondary, #a0a0b0);
    margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.evo-list-item-meta { font-size: 12px; color: var(--color-text-tertiary, #666); margin-top: 4px; }
.evo-list-item-btn {
    padding: 5px 12px; border: none; border-radius: var(--radius-sm, 6px);
    font-size: 12px; cursor: pointer; flex-shrink: 0; transition: all 0.2s;
}
.evo-btn-danger { background: rgba(239,68,68,0.1); color: #ef4444; }
.evo-btn-danger:hover { background: rgba(239,68,68,0.2); }

/* 标签 */
.evo-tag {
    font-size: 10px; padding: 2px 6px; border-radius: 4px;
    font-weight: 500; display: inline-block;
}
.evo-tag-pass { background: rgba(52,211,153,0.15); color: #34d399; }
.evo-tag-warn { background: rgba(251,191,36,0.15); color: #fbbf24; }
.evo-tag-block { background: rgba(239,68,68,0.15); color: #ef4444; }

/* 空状态 */
.evo-empty-hint {
    text-align: center; padding: 32px 20px;
    color: var(--color-text-secondary, #a0a0b0); font-size: 14px; line-height: 1.8;
}
.evo-sub-hint { font-size: 12px; color: var(--color-text-tertiary, #666); }

/* 锻造标签 */
.evo-tag-forged { background: rgba(99,102,241,0.15); color: var(--color-primary, #818cf8); }
.evo-tag-beta {
    background: linear-gradient(135deg, rgba(124,58,237,0.2), rgba(99,102,241,0.2));
    color: #a78bfa; font-size: 9px; padding: 1px 6px; border-radius: 4px;
    font-weight: 600; letter-spacing: 0.5px; vertical-align: middle; margin-left: 4px;
}

/* 内联确认 UI */
.evo-confirm-inline {
    display: flex; gap: 6px; flex-shrink: 0; align-items: center;
}
.evo-btn-confirm {
    background: rgba(239,68,68,0.15); color: #ef4444;
    font-size: 11px; padding: 4px 10px; border: 1px solid rgba(239,68,68,0.3);
}
.evo-btn-confirm:hover { background: rgba(239,68,68,0.3); }
.evo-btn-cancel {
    background: var(--color-bg-tertiary, rgba(255,255,255,0.06)); color: var(--color-text-secondary, #a0a0b0);
    font-size: 11px; padding: 4px 10px;
}
.evo-btn-cancel:hover { background: rgba(255,255,255,0.1); }
.evo-inline-status {
    font-size: 12px; color: var(--color-text-secondary, #a0a0b0); white-space: nowrap;
}
.evo-status-done { color: #34d399; }
.evo-status-error { color: #ef4444; }
`;
    const style = document.createElement('style');
    style.id = 'evo-tab-styles';
    style.textContent = css;
    document.head.appendChild(style);
}

// ========================
// 锻造建议 Toast
// ========================

function injectForgeToastContainer(): void {
    if (document.getElementById('evo-forge-toast')) return;
    const css = `
.evo-forge-toast {
    position: fixed; bottom: 80px; right: 24px; z-index: 9000;
    width: 360px; max-width: calc(100vw - 48px);
    background: var(--bg-secondary, #1e1e2e);
    border: 1px solid rgba(124,58,237,0.3);
    border-radius: 16px; padding: 20px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4), 0 0 0 1px rgba(124,58,237,0.1);
    transform: translateY(20px); opacity: 0; pointer-events: none;
    transition: all 0.3s cubic-bezier(0.34,1.56,0.64,1);
}
.evo-forge-toast.evo-visible {
    transform: translateY(0); opacity: 1; pointer-events: all;
}
.evo-forge-toast-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
}
.evo-forge-toast-icon {
    font-size: 24px; width: 40px; height: 40px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(124,58,237,0.15); border-radius: 10px;
}
.evo-forge-toast-title {
    font-size: 15px; font-weight: 600; color: var(--text-primary, #e0e0e0);
}
.evo-forge-toast-cat {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: rgba(124,58,237,0.15); color: #a78bfa;
    margin-left: auto;
}
.evo-forge-toast-body {
    font-size: 13px; line-height: 1.6; color: var(--text-secondary, #a0a0b0);
    margin-bottom: 16px;
}
.evo-forge-toast-actions {
    display: flex; gap: 10px; justify-content: flex-end;
}
.evo-forge-toast-btn {
    padding: 8px 20px; border: none; border-radius: 8px;
    font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s;
}
.evo-forge-toast-dismiss {
    background: var(--bg-tertiary, rgba(255,255,255,0.06));
    color: var(--text-secondary, #a0a0b0);
}
.evo-forge-toast-dismiss:hover {
    background: rgba(255,255,255,0.1);
}
.evo-forge-toast-accept {
    background: linear-gradient(135deg, #7c3aed, #6366f1);
    color: white; box-shadow: 0 4px 12px rgba(124,58,237,0.3);
}
.evo-forge-toast-accept:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(124,58,237,0.4);
}
`;
    const style = document.createElement('style');
    style.id = 'evo-forge-toast-styles';
    style.textContent = css;
    document.head.appendChild(style);

    document.body.insertAdjacentHTML('beforeend', '<div id="evo-forge-toast" class="evo-forge-toast"></div>');
}

function showForgeSuggestion(
    client: GatewayClient,
    suggestion: { id: string; title: string; content: string; category: string; reasoning: string },
): void {
    const toast = document.getElementById('evo-forge-toast');
    if (!toast) return;

    toast.innerHTML = `
        <div class="evo-forge-toast-header">
            <div class="evo-forge-toast-icon">✨</div>
            <div class="evo-forge-toast-title">${escHtml(suggestion.title)}</div>
            <span class="evo-forge-toast-cat">${escHtml(suggestion.category)}</span>
        </div>
        <div class="evo-forge-toast-body">${escHtml(suggestion.reasoning)}</div>
        <div class="evo-forge-toast-actions">
            <button class="evo-forge-toast-btn evo-forge-toast-dismiss" id="evo-forge-dismiss">忽略</button>
            <button class="evo-forge-toast-btn evo-forge-toast-accept" id="evo-forge-accept">保存技能</button>
        </div>
    `;

    toast.classList.add('evo-visible');

    const cleanup = () => toast.classList.remove('evo-visible');

    document.getElementById('evo-forge-dismiss')?.addEventListener('click', () => {
        cleanup();
        client.dismissForgeSuggestion().catch(() => {});
    });

    document.getElementById('evo-forge-accept')?.addEventListener('click', async () => {
        cleanup();
        try {
            await client.acceptForgeSuggestion(suggestion);
            console.log('[EvolutionUI] Forge suggestion accepted:', suggestion.title);
            // 接受后刷新进化 Tab 数据
            setTimeout(() => loadEvolutionData(client), 1000);
        } catch (err) {
            console.error('[EvolutionUI] Accept forge failed:', err);
        }
    });

    // 30秒后自动隐藏
    setTimeout(cleanup, 30000);
}

// ========================
// 工具函数
// ========================

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function fmtDate(iso: string): string {
    try {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } catch {
        return iso;
    }
}
