import { t } from '../i18n/index';
import {
    getTurnActivityDuration,
    isTurnActivityTerminal,
    reduceTurnActivity,
    setTurnActivityCollapsed,
    type ActivityItemState,
    type AgentEventV1,
    type TurnActivityState,
} from './activity-state';

function turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
}

function formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return t('activity.duration_hms', hours, minutes, seconds);
    if (minutes > 0) return t('activity.duration_ms', minutes, seconds);
    return t('activity.duration_s', seconds);
}

function statusLabel(state: TurnActivityState): string {
    const duration = formatDuration(getTurnActivityDuration(state));
    if (state.status === 'completed') return t('activity.processed', duration);
    if (state.status === 'failed') return t('activity.failed', duration);
    if (state.status === 'interrupted') return t('activity.interrupted', duration);
    return t('activity.processing', duration);
}

function itemStatusLabel(item: ActivityItemState): string {
    if (item.status === 'completed') return t('activity.item_completed');
    if (item.status === 'failed') return t('activity.item_failed');
    if (item.status === 'waiting') return t('activity.item_waiting');
    return t('activity.item_running');
}

const CLI_TOOL_NAMES = new Set([
    'process',
    'shell',
    'terminal',
    'powershell',
    'cmd',
    'bash',
    'exec',
    'exec_command',
    'shell_command',
]);

const SUBAGENT_TOOL_NAMES = new Set([
    'spawn_agent',
    'sessions_spawn',
    'send_message_to_agent',
    'wait_agent',
]);

type ActivityDisplayCategory =
    | 'model'
    | 'commentary'
    | 'guidance'
    | 'goal_update'
    | 'cli'
    | 'tool'
    | 'subagent'
    | 'approval'
    | 'checkpoint';

export interface ActivityApprovalPrompt {
    requestId: string;
    sessionId?: string;
    turnId?: string;
    toolName: string;
    risk: string;
    reason: string;
    argsPreview: string;
}

interface PendingActivityApproval {
    prompt: ActivityApprovalPrompt;
    onDecision: (approved: boolean) => void;
    settled: boolean;
    decision?: boolean;
}

function normalizedToolName(item: ActivityItemState): string {
    const tool = item.tool?.trim().toLowerCase() ?? '';
    const segments = tool.split(/[./:]/);
    return segments[segments.length - 1] ?? tool;
}

function visibleItemDetail(item: ActivityItemState): string | undefined {
    const detail = item.detail?.trim();
    if (!detail || item.status !== 'completed') return detail || undefined;

    // Older persisted events may contain a generic result such as
    // "已完成 filesystem". The completed marker already communicates that
    // state, so keep only result details that add useful information.
    let remainder = detail.toLocaleLowerCase();
    const toolNames = new Set([
        item.tool?.trim().toLocaleLowerCase() ?? '',
        normalizedToolName(item),
    ]);
    for (const toolName of toolNames) {
        if (!toolName) continue;
        remainder = remainder.split(toolName).join('');
    }
    remainder = remainder.replace(/[\s:：,，.。;；!！()（）[\]【】_\-/\\]+/g, '');
    if (new Set(['已完成', '完成', '完成了', 'done', 'completed', 'success', 'succeeded']).has(remainder)) {
        return undefined;
    }
    return detail;
}

function displayCategory(item: ActivityItemState): ActivityDisplayCategory {
    if (item.kind === 'model') return 'model';
    if (item.kind === 'commentary') return 'commentary';
    if (item.kind === 'guidance') return 'guidance';
    if (item.kind === 'goal_update') return 'goal_update';
    if (item.kind === 'checkpoint') return 'checkpoint';
    if (item.kind === 'approval') return 'approval';
    if (item.kind === 'subagent') return 'subagent';

    const toolName = normalizedToolName(item);
    if (SUBAGENT_TOOL_NAMES.has(toolName)) return 'subagent';
    if (CLI_TOOL_NAMES.has(toolName)) return 'cli';
    return 'tool';
}

function isGeneratedToolCheckpoint(item: ActivityItemState): boolean {
    return item.kind === 'checkpoint' && /^阶段\s*\d+\s*已完成[：:]/.test(item.title.trim());
}

const LIVE_ITEM_LIMIT = 10;

function timelineItems(state: TurnActivityState): ActivityItemState[] {
    return state.items.filter(item => !isGeneratedToolCheckpoint(item));
}

function renderedTimelineItems(state: TurnActivityState, allItems: ActivityItemState[]): ActivityItemState[] {
    if (state.collapsed) return [];
    if (isTurnActivityTerminal(state) || allItems.length <= LIVE_ITEM_LIMIT) return allItems;

    const recent = allItems.slice(-LIVE_ITEM_LIMIT);
    const recentIds = new Set(recent.map(item => item.id));
    const pendingApprovals = allItems.filter(item => (
        item.kind === 'approval'
        && item.status === 'waiting'
        && !recentIds.has(item.id)
    ));
    return [...pendingApprovals, ...recent]
        .sort((a, b) => a.firstSeq - b.firstSeq || (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function categoryLabel(category: ActivityDisplayCategory): string {
    return t(`activity.kind_${category}`);
}

function markerForCategory(category: ActivityDisplayCategory): string {
    if (category === 'guidance') return '\u21b3';
    if (category === 'goal_update') return '\u21bb';
    if (category === 'model') return '●';
    if (category === 'checkpoint') return '✓';
    if (category === 'approval') return '!';
    if (category === 'subagent') return '◇';
    if (category === 'cli') return '›';
    if (category === 'tool') return '↗';
    return '·';
}

function appendApprovalField(
    container: HTMLElement,
    labelText: string,
    valueText: string,
    valueClassName = '',
): void {
    const row = document.createElement('div');
    row.className = 'agent-activity-approval-field';

    const label = document.createElement('span');
    label.className = 'agent-activity-approval-field-label';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = `agent-activity-approval-field-value${valueClassName ? ` ${valueClassName}` : ''}`;
    value.textContent = valueText;
    row.append(label, value);
    container.appendChild(row);
}

function renderApprovalPrompt(
    content: HTMLElement,
    item: ActivityItemState,
    approval: PendingActivityApproval | undefined,
    onDecision: (requestId: string, approved: boolean) => void,
): void {
    content.querySelector('.agent-activity-approval-prompt')?.remove();
    if (!approval) return;

    const { prompt } = approval;
    const panel = document.createElement('div');
    panel.className = 'agent-activity-approval-prompt';
    panel.dataset.approvalRequestId = prompt.requestId;

    const heading = document.createElement('div');
    heading.className = 'agent-activity-approval-heading';

    const headingText = document.createElement('span');
    headingText.className = 'agent-activity-approval-heading-text';
    headingText.textContent = t('activity.approval_required');

    const tool = document.createElement('code');
    tool.className = 'agent-activity-approval-tool';
    tool.textContent = prompt.toolName;
    heading.append(headingText, tool);
    panel.appendChild(heading);

    appendApprovalField(panel, t('activity.approval_risk'), prompt.risk, 'is-risk');
    appendApprovalField(panel, t('activity.approval_reason'), prompt.reason);

    const args = document.createElement('div');
    args.className = 'agent-activity-approval-args';
    const argsLabel = document.createElement('div');
    argsLabel.className = 'agent-activity-approval-field-label';
    argsLabel.textContent = t('activity.approval_arguments');
    const argsPreview = document.createElement('pre');
    argsPreview.textContent = prompt.argsPreview;
    args.append(argsLabel, argsPreview);
    panel.appendChild(args);

    const isTerminal = item.status === 'completed' || item.status === 'failed';
    if (approval.settled) {
        const decision = document.createElement('div');
        decision.className = `agent-activity-approval-decision ${approval.decision ? 'approved' : 'denied'}`;
        decision.textContent = approval.decision
            ? t('activity.approval_allowed')
            : t('activity.approval_denied');
        panel.appendChild(decision);
    } else if (!isTerminal) {
        const actions = document.createElement('div');
        actions.className = 'agent-activity-approval-actions';

        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'agent-activity-approval-button deny';
        deny.textContent = t('activity.approval_deny');
        deny.addEventListener('click', () => onDecision(prompt.requestId, false));

        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'agent-activity-approval-button allow';
        allow.textContent = t('activity.approval_allow');
        allow.addEventListener('click', () => onDecision(prompt.requestId, true));

        actions.append(deny, allow);
        panel.appendChild(actions);
    }

    content.appendChild(panel);
}

function updateItemElement(
    element: HTMLElement,
    item: ActivityItemState,
    approval: PendingActivityApproval | undefined,
    onApprovalDecision: (requestId: string, approved: boolean) => void,
): void {
    const category = displayCategory(item);
    element.className = `agent-activity-item kind-${item.kind} category-${category} status-${item.status}`;
    element.dataset.itemId = item.id;

    let marker = element.querySelector('.agent-activity-item-marker') as HTMLSpanElement | null;
    let content = element.querySelector('.agent-activity-item-content') as HTMLDivElement | null;
    let status = element.querySelector('.agent-activity-item-status') as HTMLSpanElement | null;

    if (!marker || !content || !status) {
        element.replaceChildren();
        marker = document.createElement('span');
        marker.className = 'agent-activity-item-marker';
        marker.setAttribute('aria-hidden', 'true');
        content = document.createElement('div');
        content.className = 'agent-activity-item-content';
        status = document.createElement('span');
        status.className = 'agent-activity-item-status';
        element.append(marker, content, status);
    }

    marker.textContent = markerForCategory(category);

    let heading = content.querySelector('.agent-activity-item-heading') as HTMLDivElement | null;
    let title = content.querySelector('.agent-activity-item-title') as HTMLDivElement | null;
    let badge = content.querySelector('.agent-activity-item-kind') as HTMLSpanElement | null;
    if (!heading || !title || !badge) {
        content.replaceChildren();
        heading = document.createElement('div');
        heading.className = 'agent-activity-item-heading';
        badge = document.createElement('span');
        badge.className = 'agent-activity-item-kind';
        title = document.createElement('div');
        title.className = 'agent-activity-item-title';
        heading.append(badge, title);
        content.appendChild(heading);
    }
    badge.textContent = categoryLabel(category);
    title.textContent = item.title;

    let detail = content.querySelector('.agent-activity-item-detail') as HTMLDivElement | null;
    const visibleDetail = visibleItemDetail(item);
    if (visibleDetail) {
        if (!detail) {
            detail = document.createElement('div');
            detail.className = 'agent-activity-item-detail';
            content.append(detail);
        }
        detail.textContent = visibleDetail;
    } else {
        detail?.remove();
    }

    const visibleStatus = item.status === 'completed' ? '' : itemStatusLabel(item);
    status.textContent = visibleStatus;
    status.title = visibleStatus;
    status.hidden = !visibleStatus;
    renderApprovalPrompt(content, item, approval, onApprovalDecision);
}

export class ActivityViewController {
    private readonly states = new Map<string, TurnActivityState>();
    private readonly elements = new Map<string, HTMLElement>();
    private readonly approvals = new Map<string, PendingActivityApproval>();
    private readonly timerId: number;
    private scrollFrameId: number | null = null;
    private autoFollowPausedUntil = 0;

    constructor(private readonly container: HTMLElement) {
        this.timerId = window.setInterval(() => this.refreshRunningHeaders(), 1000);
    }

    applyEvent(event: AgentEventV1, activeSessionId: string | null): TurnActivityState {
        const key = turnKey(event.sessionId, event.turnId);
        const state = reduceTurnActivity(this.states.get(key), event);
        this.states.set(key, state);

        if (event.sessionId === activeSessionId) this.renderState(state, event.item?.id);
        return state;
    }

    /** Reduce a durable event without attaching its card to the current DOM. */
    cacheEvent(event: AgentEventV1): TurnActivityState {
        return this.applyEvent(event, null);
    }

    /** Attach one known turn and return its root so history paging can position it. */
    restoreTurn(sessionId: string, turnId: string): HTMLElement | null {
        const state = this.states.get(turnKey(sessionId, turnId));
        if (!state) return null;
        this.renderState(state);
        return this.elements.get(turnKey(sessionId, turnId)) || null;
    }

    presentApproval(prompt: ActivityApprovalPrompt, onDecision: (approved: boolean) => void): void {
        const current = this.approvals.get(prompt.requestId);
        if (current) {
            current.prompt = prompt;
            if (!current.settled) current.onDecision = onDecision;
        } else {
            this.approvals.set(prompt.requestId, {
                prompt,
                onDecision,
                settled: false,
            });
        }
        this.renderApprovalMatches(prompt.requestId, true);
    }

    clearApproval(requestId: string): void {
        if (!this.approvals.delete(requestId)) return;
        this.renderApprovalMatches(requestId);
    }

    hasRunningTurn(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        return this.getSessionStates(sessionId).some(state => !isTurnActivityTerminal(state));
    }

    restoreRunningSession(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        const running = this.getSessionStates(sessionId).filter(state => !isTurnActivityTerminal(state));
        for (const state of running) this.renderState(state);
        return running.length > 0;
    }

    /**
     * Reattach every cached turn for a session after the message container has
     * been rebuilt. Session events can arrive while history is loading; that
     * render replaces the container DOM, but the reduced states remain valid.
     * Restoring terminal turns as well as running turns keeps the final
     * Processed card visible without requiring a second session switch.
     */
    restoreSession(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        const states = this.getSessionStates(sessionId);
        for (const state of states) this.renderState(state);
        return states.length > 0;
    }

    clearSession(sessionId: string): void {
        const sessionApprovalIds = new Set<string>();
        for (const [key, state] of this.states.entries()) {
            if (state.sessionId !== sessionId) continue;
            for (const item of state.items) {
                if (item.id.startsWith('approval-')) {
                    sessionApprovalIds.add(item.id.slice('approval-'.length));
                }
            }
            this.states.delete(key);
            this.elements.get(key)?.remove();
            this.elements.delete(key);
        }
        for (const [requestId, approval] of this.approvals.entries()) {
            if (approval.prompt.sessionId === sessionId || sessionApprovalIds.has(requestId)) {
                this.approvals.delete(requestId);
            }
        }
    }

    destroy(): void {
        window.clearInterval(this.timerId);
        if (this.scrollFrameId !== null) cancelAnimationFrame(this.scrollFrameId);
        this.states.clear();
        this.elements.clear();
        this.approvals.clear();
    }

    pauseAutoFollow(durationMs = 1400): void {
        this.autoFollowPausedUntil = Math.max(
            this.autoFollowPausedUntil,
            Date.now() + Math.max(0, durationMs),
        );
        if (this.scrollFrameId !== null) {
            cancelAnimationFrame(this.scrollFrameId);
            this.scrollFrameId = null;
        }
    }

    private getSessionStates(sessionId: string): TurnActivityState[] {
        return [...this.states.values()]
            .filter(state => state.sessionId === sessionId)
            .sort((a, b) => a.startedAt - b.startedAt);
    }

    private ensureRoot(state: TurnActivityState): HTMLElement {
        const key = turnKey(state.sessionId, state.turnId);
        let root = this.elements.get(key);
        if (root?.isConnected) return root;

        root = document.createElement('section');
        root.className = 'agent-activity';
        root.dataset.sessionId = state.sessionId;
        root.dataset.turnId = state.turnId;
        root.innerHTML = `
            <button class="agent-activity-header" type="button" aria-expanded="true">
                <span class="agent-activity-state-icon" aria-hidden="true"></span>
                <span class="agent-activity-title"></span>
                <span class="agent-activity-count"></span>
                <span class="agent-activity-chevron" aria-hidden="true"></span>
            </button>
            <div class="agent-activity-body">
                <div class="agent-activity-empty hidden">
                    <span class="agent-activity-empty-marker" aria-hidden="true"></span>
                    <span class="agent-activity-empty-text"></span>
                </div>
                <div class="agent-activity-items"></div>
                <div class="agent-activity-summary"></div>
            </div>
        `;
        root.querySelector('.agent-activity-header')?.addEventListener('click', () => {
            const current = this.states.get(key);
            if (!current) return;
            const next = setTurnActivityCollapsed(current, !current.collapsed);
            this.states.set(key, next);
            this.renderState(next);
        });

        const streamingMessage = this.container.querySelector('#streaming-message');
        if (streamingMessage) this.container.insertBefore(root, streamingMessage);
        else this.container.appendChild(root);
        this.elements.set(key, root);
        return root;
    }

    private renderState(state: TurnActivityState, changedItemId?: string): void {
        const key = turnKey(state.sessionId, state.turnId);
        const hadAttachedRoot = this.elements.get(key)?.isConnected === true;
        const shouldFollowPage = !hadAttachedRoot && this.isNearBottom();
        const root = this.ensureRoot(state);

        const header = root.querySelector('.agent-activity-header') as HTMLButtonElement;
        const title = root.querySelector('.agent-activity-title') as HTMLSpanElement;
        const count = root.querySelector('.agent-activity-count') as HTMLSpanElement;
        const empty = root.querySelector('.agent-activity-empty') as HTMLDivElement;
        const emptyText = root.querySelector('.agent-activity-empty-text') as HTMLSpanElement;
        const items = root.querySelector('.agent-activity-items') as HTMLDivElement;
        const summary = root.querySelector('.agent-activity-summary') as HTMLDivElement;

        // Keep explanations, Tool/CLI calls and results in one chronological
        // timeline. Grouping mechanics elsewhere changes the perceived order.
        const visibleItems = timelineItems(state);
        const renderedItems = renderedTimelineItems(state, visibleItems);
        const isLiveWindow = state.status === 'running' && !state.collapsed;
        const isHistoryView = isTurnActivityTerminal(state) && !state.collapsed;
        root.className = [
            'agent-activity',
            `status-${state.status}`,
            state.collapsed ? 'collapsed' : '',
            isLiveWindow ? 'live-window' : '',
            isHistoryView ? 'history-view' : '',
        ].filter(Boolean).join(' ');

        header.setAttribute('aria-expanded', String(!state.collapsed));
        title.textContent = statusLabel(state);
        count.textContent = visibleItems.length > 0 ? t('activity.step_count', visibleItems.length) : '';
        const isPreparing = state.status === 'running' && visibleItems.length === 0;
        emptyText.textContent = t('activity.preparing');
        empty.classList.toggle('hidden', !isPreparing);

        const shouldFollowItems = isLiveWindow && this.isItemsNearBottom(items);
        const existing = new Map<string, HTMLElement>();
        items.querySelectorAll<HTMLElement>(':scope > .agent-activity-item').forEach(element => {
            if (element.dataset.itemId) existing.set(element.dataset.itemId, element);
        });

        for (const [index, item] of renderedItems.entries()) {
            let element = existing.get(item.id);
            const isNew = !element;
            if (!element) element = document.createElement('div');
            // Live events patch only their own row. Full restores/toggles still
            // refresh every row, but preserve existing node identity and order.
            if (isNew || !changedItemId || changedItemId === item.id) {
                updateItemElement(
                    element,
                    item,
                    this.approvalForItem(state, item),
                    (requestId, approved) => this.resolveApproval(requestId, approved),
                );
            }
            const currentAtIndex = items.children.item(index);
            if (currentAtIndex !== element) items.insertBefore(element, currentAtIndex || null);
            existing.delete(item.id);
        }
        for (const stale of existing.values()) stale.remove();

        summary.textContent = state.summary ?? '';
        summary.classList.toggle('hidden', !state.summary);
        if (shouldFollowItems) this.requestItemsBottomScroll(items);
        if (shouldFollowPage) this.requestBottomScroll();
    }

    private isItemsNearBottom(items: HTMLElement, threshold = 48): boolean {
        return items.scrollHeight - items.scrollTop - items.clientHeight <= threshold;
    }

    private requestItemsBottomScroll(items: HTMLElement): void {
        requestAnimationFrame(() => {
            if (items.isConnected) items.scrollTop = items.scrollHeight;
        });
    }

    private isNearBottom(threshold = 160): boolean {
        if (Date.now() < this.autoFollowPausedUntil) return false;
        const distance = this.container.scrollHeight
            - this.container.scrollTop
            - this.container.clientHeight;
        return distance <= threshold;
    }

    private requestBottomScroll(): void {
        if (Date.now() < this.autoFollowPausedUntil) return;
        if (this.scrollFrameId !== null) return;
        this.scrollFrameId = requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.container.scrollTop = this.container.scrollHeight;
        });
    }

    private approvalForItem(
        state: TurnActivityState,
        item: ActivityItemState,
    ): PendingActivityApproval | undefined {
        if (item.kind !== 'approval' || !item.id.startsWith('approval-')) return undefined;
        const requestId = item.id.slice('approval-'.length);
        const approval = this.approvals.get(requestId);
        if (!approval) return undefined;
        if (approval.prompt.sessionId && approval.prompt.sessionId !== state.sessionId) return undefined;
        if (approval.prompt.turnId && approval.prompt.turnId !== state.turnId) return undefined;
        return approval;
    }

    private resolveApproval(requestId: string, approved: boolean): void {
        const approval = this.approvals.get(requestId);
        if (!approval || approval.settled) return;

        approval.settled = true;
        approval.decision = approved;
        this.renderApprovalMatches(requestId);
        approval.onDecision(approved);
    }

    private renderApprovalMatches(requestId: string, reveal = false): void {
        const itemId = `approval-${requestId}`;
        for (const [key, current] of this.states.entries()) {
            let state = current;
            if (!state.items.some(item => item.id === itemId)) continue;
            if (reveal && state.collapsed) {
                state = setTurnActivityCollapsed(state, false);
                this.states.set(key, state);
            }
            const root = this.elements.get(key);
            if (!root?.isConnected) continue;
            this.renderState(state);
            if (reveal) {
                const prompt = [...root.querySelectorAll<HTMLElement>('[data-approval-request-id]')]
                    .find(element => element.dataset.approvalRequestId === requestId);
                prompt?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    private refreshRunningHeaders(): void {
        for (const [key, state] of this.states.entries()) {
            if (state.status !== 'running') continue;
            const root = this.elements.get(key);
            if (!root?.isConnected) continue;
            const title = root.querySelector('.agent-activity-title');
            if (title) title.textContent = statusLabel(state);
        }
    }
}
