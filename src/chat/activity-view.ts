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
    if (typeof item.command === 'string' && item.command.trim()) return 'cli';
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
    const fullToolName = item.tool?.trim().toLowerCase() || '';
    if (/(?:^|[./:_-])windows(?:$|[./:_-])/.test(fullToolName)
        && (/(?:^|[./:_-])(?:system|powershell|shell|cmd)(?:$|[./:_-])/.test(fullToolName)
            || /\b(?:powershell|shell|cmd|command)\b|执行命令|运行命令|系统命令/i.test(item.title))) return 'cli';
    return 'tool';
}

function isGeneratedToolCheckpoint(item: ActivityItemState): boolean {
    return item.kind === 'checkpoint' && /^阶段\s*\d+\s*已完成[：:]/.test(item.title.trim());
}

function timelineItems(state: TurnActivityState): ActivityItemState[] {
    return state.items.filter(item => !isGeneratedToolCheckpoint(item));
}

function renderedTimelineItems(state: TurnActivityState, allItems: ActivityItemState[]): ActivityItemState[] {
    return state.collapsed ? [] : allItems;
}

const NARRATIVE_KINDS = new Set<string>(['commentary', 'checkpoint', 'guidance', 'goal_update']);

/** One purpose-derived group: a narrative row and the actions it explains. */
interface ActivityGroup {
    id: string;
    header?: ActivityItemState;
    /** A row that must stay visible on its own (approval prompts, model rows). */
    standalone?: ActivityItemState;
    members: ActivityItemState[];
}

/**
 * Group actions by purpose, not by tool: every narrative row (the agent saying
 * what it is about to do) opens a group, and the actions that follow belong to
 * it until the next narrative row. An action that carries a phaseId joins that
 * phase even when rows interleave. Approvals stay standalone so a prompt is
 * never hidden inside a collapsed group.
 */
function groupTimeline(items: ActivityItemState[]): ActivityGroup[] {
    const groups: ActivityGroup[] = [];
    let current: ActivityGroup | undefined;
    for (const item of items) {
        if (NARRATIVE_KINDS.has(item.kind)) {
            current = { id: item.id, header: item, members: [] };
            groups.push(current);
            continue;
        }
        if (item.kind === 'approval' || item.kind === 'model') {
            groups.push({ id: item.id, standalone: item, members: [] });
            continue;
        }
        const declared = item.phaseId ? groups.find(group => group.header?.id === item.phaseId) : undefined;
        if (declared) {
            declared.members.push(item);
            continue;
        }
        if (!current) {
            current = { id: `implicit-${item.id}`, members: [] };
            groups.push(current);
        }
        current.members.push(item);
    }
    return groups;
}

/** What an action did, in the user's vocabulary, for the group summary line. */
function actionVerb(item: ActivityItemState): string {
    const title = item.title || '';
    if (item.kind === 'subagent' || displayCategory(item) === 'subagent') return t('activity.group_subagent');
    if (/^(读取文件|解析文件|Read file|Parse file)/.test(title)) return t('activity.group_read');
    if (/^(写入文件|追加文件|复制文件|移动文件|删除文件|创建目录|Write file|Append file|Copy file|Move file|Delete file|Create folder)/.test(title)) return t('activity.group_edit');
    if (/^(列出目录|检查文件|List folder|Inspect file)/.test(title)) return t('activity.group_inspect');
    if (/browser[ _]control|浏览器/i.test(title) || /browser/i.test(item.tool || '')) return t('activity.group_browser');
    if (/^(搜索|读取网页|执行 project search|Search|Read webpage)/.test(title)) return t('activity.group_search');
    if (displayCategory(item) === 'cli' || /^(执行命令|执行本地命令|运行|构建|Run |Build )/.test(title)) return t('activity.group_command');
    const cut = title.search(/[：:]/);
    return (cut > 0 ? title.slice(0, cut) : title).trim().slice(0, 24) || t('activity.group_default');
}

/** Members of a phase split by what they did; each kind folds separately. */
function splitByVerb(group: ActivityGroup): Array<{ verb: string; members: ActivityItemState[] }> {
    const buckets = new Map<string, ActivityItemState[]>();
    for (const item of group.members) {
        const verb = actionVerb(item);
        const bucket = buckets.get(verb);
        if (bucket) bucket.push(item);
        else buckets.set(verb, [item]);
    }
    return [...buckets.entries()].map(([verb, members]) => ({ verb, members }));
}

/**
 * The summary names the kind only (no counts, no failure text). While the
 * turn is live, the bucket holding the latest action stays "active": its
 * newest step trails the label and the whole line shimmers, so the reader
 * always sees what is happening — also between steps, while the model thinks.
 */
function bucketSummary(verb: string, members: ActivityItemState[], live?: LiveActions): { text: string; current?: string; active: boolean } {
    if (!live) return { text: verb, active: false };
    // Parallel work: every bucket with a step in flight is active and shows
    // its own running step. In a thinking gap (nothing in flight) the bucket
    // of the last started action stays active until a new phase begins.
    // Progress on an older action must not change the representative step.
    const running = members.filter(item => live.runningIds.has(item.id));
    const shown = running.length
        ? running.reduce((best, item) => (item.firstSeq > best.firstSeq ? item : best), running[0])
        : members.find(item => item.id === live.latestId);
    if (!shown) return { text: verb, active: false };
    return { text: verb, current: stepSubject(shown), active: true };
}

/**
 * The part of a step worth showing next to its bucket label: the object of
 * the action ("router/index.ts", the search query, the browser action), not
 * the verb the label already states. Commands show their command text.
 */
function stepSubject(item: ActivityItemState): string {
    if (typeof item.command === 'string' && item.command.trim()) return item.command.trim();
    const title = (item.title || '').trim();
    const cut = title.search(/[：:]\s*/);
    if (cut > 0) {
        const rest = title.slice(cut + 1).replace(/^\s+/, '');
        if (rest) return rest;
    }
    return title;
}

interface LiveActions {
    /** Actions currently in flight (parallel tool calls each count). */
    runningIds: Set<string>;
    /** Last started action in the current phase, when nothing is in flight. */
    latestId?: string;
}

/** What is live in a running turn; undefined once the turn settled. */
function liveActions(state: TurnActivityState, items: ActivityItemState[]): LiveActions | undefined {
    if (isTurnActivityTerminal(state)) return undefined;
    const runningIds = new Set<string>();
    let latest: ActivityItemState | undefined;
    let latestPhaseSeq = -1;
    for (const item of items) {
        if (NARRATIVE_KINDS.has(item.kind)) {
            latestPhaseSeq = Math.max(latestPhaseSeq, item.firstSeq);
            continue;
        }
        if (item.kind === 'approval' || item.kind === 'model') continue;
        if (item.status === 'running' || item.status === 'waiting') runningIds.add(item.id);
        if (!latest || item.firstSeq > latest.firstSeq) latest = item;
    }
    return {
        runningIds,
        latestId: !runningIds.size && latest && latest.firstSeq > latestPhaseSeq ? latest.id : undefined,
    };
}

function categoryLabel(category: ActivityDisplayCategory): string {
    return t(`activity.kind_${category}`);
}

// Fixed SVG geometry only. Event text never participates in this markup.
const CATEGORY_MARKERS: Record<ActivityDisplayCategory, string> = {
    model: '<circle cx="12" cy="12" r="7"/>',
    commentary: '<path fill-rule="evenodd" d="M5 3a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h3l4 3v-3h7a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H5Zm2 5h10v2H7V8Zm0 4h7v2H7v-2Z"/>',
    guidance: '<path d="M4 3h3v8a2 2 0 0 0 2 2h7V9l6 5.5-6 5.5v-4H9a5 5 0 0 1-5-5V3Z"/>',
    goal_update: '<path d="M19.1 4.9 22 2v8h-8l3-3a7 7 0 1 0 1.5 7H22A10 10 0 1 1 19.1 4.9Z"/>',
    cli: '<path fill-rule="evenodd" d="M4 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Zm1.6 4.3L10.3 12l-4.7 4.7-1.4-1.4L7.5 12 4.2 8.7l1.4-1.4ZM12 15h7v2h-7v-2Z"/>',
    tool: '<path d="M14.5 2.4a6 6 0 0 0-7.3 7.5L2.6 14.5a4.9 4.9 0 0 0 6.9 6.9l4.6-4.6a6 6 0 0 0 7.5-7.3l-4.1 4.1-4.1-1-1-4.1 4.1-4.1-2-2ZM5 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/>',
    subagent: '<path d="M9 2h6v6h-2v3h7v4h2v7h-6v-7h2v-2H6v2h2v7H2v-7h2v-4h7V8H9V2Z"/>',
    approval: '<path fill-rule="evenodd" d="m12 2 9 4v6c0 5-5 8.5-9 10-4-1.5-9-5-9-10V6l9-4Zm-1 5v7h2V7h-2Zm0 9v2h2v-2h-2Z"/>',
    checkpoint: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm5.7 5.7 1.4 1.4L10 18.2l-5.1-5.1 1.4-1.4L10 15.4l7.7-7.7Z"/>',
};

function markerForCategory(category: ActivityDisplayCategory): string {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${CATEGORY_MARKERS[category]}</svg>`;
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

/**
 * One-line action rows clip what does not fit. A row that clips gets an
 * "expand" link so the hidden part is one click away; the link disappears
 * again when the row fits (wider panel, shorter text).
 */
const overflowWatcher = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(entries => {
        for (const entry of entries) syncActionOverflow(entry.target as HTMLElement);
    })
    : null;

function syncActionOverflow(heading: HTMLElement): void {
    const row = heading.closest('.agent-activity-item') as HTMLElement | null;
    const toggle = heading.querySelector('.agent-activity-item-expand') as HTMLButtonElement | null;
    if (!row || !toggle) return;
    const expanded = row.classList.contains('expanded');
    const clipped = !expanded && Array.from(
        heading.querySelectorAll<HTMLElement>('.agent-activity-item-title, .agent-activity-item-command, .agent-activity-item-detail'),
    ).some(el => el.scrollWidth > el.clientWidth + 1);
    toggle.hidden = !(clipped || expanded);
    toggle.textContent = expanded ? t('activity.collapse') : t('activity.expand');
}

function ensureExpandToggle(heading: HTMLElement, row: HTMLElement): void {
    let toggle = heading.querySelector('.agent-activity-item-expand') as HTMLButtonElement | null;
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'agent-activity-item-expand';
        toggle.hidden = true;
        toggle.addEventListener('click', event => {
            event.stopPropagation();
            row.classList.toggle('expanded');
            syncActionOverflow(heading);
        });
        overflowWatcher?.observe(heading);
    }
    // Keep the link last so it always sits at the row's right edge.
    heading.append(toggle);
    syncActionOverflow(heading);
}

function updateItemElement(
    element: HTMLElement,
    item: ActivityItemState,
    approval: PendingActivityApproval | undefined,
    onApprovalDecision: (requestId: string, approved: boolean) => void,
): void {
    const category = displayCategory(item);
    const wasExpanded = element.classList.contains('expanded');
    element.className = `agent-activity-item kind-${item.kind} category-${category} status-${item.status}${wasExpanded ? ' expanded' : ''}`;
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

    if (marker.dataset.icon !== category || !marker.firstElementChild) {
        marker.innerHTML = markerForCategory(category);
        marker.dataset.icon = category;
    }

    // Guidance is user-authored text inside the durable execution timeline.
    // Reuse chat bubble styles while retaining the activity row's identity.
    if (category === 'guidance') {
        let message = content.querySelector<HTMLDivElement>('.message.user');
        let text = message?.querySelector<HTMLDivElement>('.markdown-body');
        if (!message || !text) {
            content.replaceChildren();
            message = document.createElement('div');
            message.className = 'message user';
            const label = document.createElement('div');
            label.className = 'follow-up-message-label';
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            text = document.createElement('div');
            text.className = 'markdown-body agent-activity-item-title';
            bubble.append(text);
            message.append(label, bubble);
            content.append(message);
        }
        message.querySelector('.follow-up-message-label')!.textContent = `↳ ${t('follow_up.steer_badge')}`;
        text.textContent = item.title;
        status.textContent = '';
        status.hidden = true;
        return;
    }

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

    // Command and result detail live on the heading row: an action reads as
    // one line, and only narrative items (commentary, checkpoints…) wrap.
    let command = content.querySelector<HTMLElement>('code.agent-activity-item-command');
    if (typeof item.command === 'string' && item.command.trim()) {
        if (!command) {
            command = document.createElement('code');
            command.className = 'agent-activity-item-command';
            title.after(command);
        }
        command.textContent = item.command;
        command.title = item.command;
    } else {
        command?.remove();
    }

    let detail = content.querySelector('.agent-activity-item-detail') as HTMLSpanElement | null;
    const visibleDetail = visibleItemDetail(item);
    if (visibleDetail) {
        if (!detail) {
            detail = document.createElement('span');
            detail.className = 'agent-activity-item-detail';
        }
        heading.append(detail);
        detail.textContent = visibleDetail;
        detail.title = visibleDetail;
    } else {
        detail?.remove();
    }

    // Action rows carry no trailing done/failed label: the outcome is already
    // in the row itself. Only in-flight states are worth announcing.
    const settled = item.status === 'completed' || item.status === 'failed';
    const visibleStatus = settled ? '' : itemStatusLabel(item);
    status.textContent = visibleStatus;
    status.title = visibleStatus;
    status.hidden = !visibleStatus;
    if (item.kind === 'action') ensureExpandToggle(heading, element);
    renderApprovalPrompt(content, item, approval, onApprovalDecision);
}

export class ActivityViewController {
    private readonly states = new Map<string, TurnActivityState>();
    private readonly elements = new Map<string, HTMLElement>();
    private readonly approvals = new Map<string, PendingActivityApproval>();
    /** Purpose groups the reader has opened; everything else stays folded. */
    private readonly expandedGroups = new Set<string>();
    /** Final output arrived before the corresponding terminal activity event. */
    private readonly collapseAfterOutputPending = new Set<string>();
    /** Each turn auto-collapses once; a later manual expansion must remain open. */
    private readonly autoCollapseConsumed = new Set<string>();
    private readonly timerId: number;
    private scrollFrameId: number | null = null;
    private autoFollowPausedUntil = 0;

    constructor(private readonly container: HTMLElement) {
        this.timerId = window.setInterval(() => this.refreshRunningHeaders(), 1000);
    }

    applyEvent(event: AgentEventV1, activeSessionId: string | null): TurnActivityState {
        const key = turnKey(event.sessionId, event.turnId);
        let state = reduceTurnActivity(this.states.get(key), event);
        if (isTurnActivityTerminal(state)
            && this.collapseAfterOutputPending.has(key)
            && !this.autoCollapseConsumed.has(key)) {
            state = this.consumeAutoCollapse(key, state);
        }
        this.states.set(key, state);

        if (event.sessionId === activeSessionId) this.renderState(state, event.item?.id);
        return state;
    }

    /** Reduce a durable event without attaching its card to the current DOM. */
    cacheEvent(event: AgentEventV1, outputCommitted = false): TurnActivityState {
        const key = turnKey(event.sessionId, event.turnId);
        let state = this.applyEvent(event, null);
        // Hydration can observe the terminal event before the matching message
        // snapshot. Only consume the one-time collapse when that output is
        // present in the same loaded history window.
        if (outputCommitted && isTurnActivityTerminal(state) && !this.autoCollapseConsumed.has(key)) {
            state = this.consumeAutoCollapse(key, state);
            this.states.set(key, state);
        }
        return state;
    }

    /**
     * Collapse a turn only after its final assistant output has been committed
     * to the conversation DOM. If completion events arrive in the opposite
     * order, remember the hand-off and collapse when the terminal event lands.
     */
    collapseAfterOutput(sessionId: string, turnId?: string): boolean {
        let state: TurnActivityState | undefined;
        let key: string;

        if (turnId) {
            key = turnKey(sessionId, turnId);
            state = this.states.get(key);
        } else {
            const sessionStates = this.getSessionStates(sessionId);
            state = sessionStates[sessionStates.length - 1];
            // Without an identity, only settle the latest turn when it is
            // already terminal. Never arm an arbitrary running turn: a newer
            // submission may have started before a delayed completion arrives.
            if (!state || !isTurnActivityTerminal(state)) return false;
            key = turnKey(state.sessionId, state.turnId);
        }

        if (this.autoCollapseConsumed.has(key)) return false;
        if (!state || !isTurnActivityTerminal(state)) {
            this.collapseAfterOutputPending.add(key);
            return false;
        }

        const collapsed = this.consumeAutoCollapse(key, state);
        this.states.set(key, collapsed);
        if (this.elements.get(key)?.isConnected) this.renderState(collapsed);
        return true;
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
        const sessionKeyPrefix = `${sessionId}\u0000`;
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
            this.collapseAfterOutputPending.delete(key);
            this.autoCollapseConsumed.delete(key);
        }
        // collapseAfterOutput can be called before the first activity event.
        // Clear those not-yet-materialized keys when their session is removed.
        for (const key of this.collapseAfterOutputPending) {
            if (key.startsWith(sessionKeyPrefix)) this.collapseAfterOutputPending.delete(key);
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
        this.collapseAfterOutputPending.clear();
        this.autoCollapseConsumed.clear();
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

    private consumeAutoCollapse(key: string, state: TurnActivityState): TurnActivityState {
        this.collapseAfterOutputPending.delete(key);
        this.autoCollapseConsumed.add(key);
        return setTurnActivityCollapsed(state, true);
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
                <span class="agent-activity-chevron" aria-hidden="true"></span>
            </button>
            <div class="agent-activity-body">
                <div class="agent-activity-items"></div>
                <div class="agent-activity-summary"></div>
            </div>
        `;
        root.querySelector('.agent-activity-header')?.addEventListener('click', () => {
            const current = this.states.get(key);
            if (!current) return;
            const next = setTurnActivityCollapsed(current, !current.collapsed);
            this.states.set(key, next);
            // Manual disclosure must keep the header under the pointer. A long
            // expansion should never jump the reader to the end of the process.
            this.renderState(next, undefined, false);
        });

        // Scheduled turns persist both a trigger marker and a final reply with
        // the same turn ID. Anchor to the last matching reply so the process
        // remains between the trigger and its result after history reloads.
        const assistantAnchor = [...this.container.querySelectorAll<HTMLElement>('.message.assistant[data-turn-id]')]
            .filter(message => message.dataset.turnId === state.turnId)
            .pop();
        const streamingMessage = this.container.querySelector('#streaming-message');
        if (assistantAnchor) this.container.insertBefore(root, assistantAnchor);
        else if (streamingMessage) this.container.insertBefore(root, streamingMessage);
        else this.container.appendChild(root);
        this.elements.set(key, root);
        return root;
    }

    private renderState(
        state: TurnActivityState,
        changedItemId?: string,
        followConversation = true,
    ): void {
        // Activity rows participate in the conversation's own document flow.
        // Preserve page-follow only while the reader remains near the bottom.
        const shouldFollowPage = followConversation && this.isNearBottom();
        const root = this.ensureRoot(state);

        const header = root.querySelector('.agent-activity-header') as HTMLButtonElement;
        const title = root.querySelector('.agent-activity-title') as HTMLSpanElement;
        const items = root.querySelector('.agent-activity-items') as HTMLDivElement;
        const summary = root.querySelector('.agent-activity-summary') as HTMLDivElement;

        // Keep explanations, Tool/CLI calls and results in one chronological
        // timeline. Grouping mechanics elsewhere changes the perceived order.
        const visibleItems = timelineItems(state);
        const renderedItems = renderedTimelineItems(state, visibleItems);
        const isHistoryView = isTurnActivityTerminal(state) && !state.collapsed;
        root.className = [
            'agent-activity',
            `status-${state.status}`,
            state.collapsed ? 'collapsed' : '',
            isHistoryView ? 'history-view' : '',
        ].filter(Boolean).join(' ');

        header.setAttribute('aria-expanded', String(!state.collapsed));
        title.textContent = statusLabel(state);

        const existingRows = new Map<string, HTMLElement>();
        items.querySelectorAll<HTMLElement>('.agent-activity-item').forEach(element => {
            if (element.dataset.itemId) existingRows.set(element.dataset.itemId, element);
        });
        const existingGroups = new Map<string, HTMLElement>();
        items.querySelectorAll<HTMLElement>(':scope > .agent-activity-group').forEach(element => {
            if (element.dataset.groupId) existingGroups.set(element.dataset.groupId, element);
        });

        const renderRow = (item: ActivityItemState): HTMLElement => {
            let element = existingRows.get(item.id);
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
            existingRows.delete(item.id);
            return element;
        };

        // Rows are laid out as purpose groups: the narrative row that states
        // the intent, a one-line summary of what was done for it, and the
        // individual steps folded underneath until the reader opens them.
        const groups = groupTimeline(renderedItems);
        const live = liveActions(state, renderedItems);
        for (const [index, group] of groups.entries()) {
            let wrapper = existingGroups.get(group.id);
            if (!wrapper) {
                wrapper = document.createElement('div');
                wrapper.className = 'agent-activity-group';
                wrapper.dataset.groupId = group.id;
            }
            existingGroups.delete(group.id);
            this.renderGroup(wrapper, group, renderRow, live);
            const currentAtIndex = items.children.item(index);
            if (currentAtIndex !== wrapper) items.insertBefore(wrapper, currentAtIndex || null);
        }
        for (const stale of existingGroups.values()) stale.remove();
        for (const stale of existingRows.values()) stale.remove();

        summary.textContent = state.summary ?? '';
        summary.classList.toggle('hidden', !state.summary);
        if (shouldFollowPage) this.requestBottomScroll();
    }

    private renderGroup(
        wrapper: HTMLElement,
        group: ActivityGroup,
        renderRow: (item: ActivityItemState) => HTMLElement,
        live?: LiveActions,
    ): void {
        const place = (element: HTMLElement, parent: HTMLElement, index: number) => {
            const currentAtIndex = parent.children.item(index);
            if (currentAtIndex !== element) parent.insertBefore(element, currentAtIndex || null);
        };
        let slot = 0;
        if (group.standalone) place(renderRow(group.standalone), wrapper, slot++);
        if (group.header) place(renderRow(group.header), wrapper, slot++);

        // One folded bucket per kind of action (reads, edits, commands,
        // browser...), each with its own chevron; kinds are never mixed.
        const buckets = splitByVerb(group);
        const existingBuckets = new Map<string, HTMLElement>();
        wrapper.querySelectorAll<HTMLElement>(':scope > .agent-activity-bucket').forEach(element => {
            if (element.dataset.bucketId) existingBuckets.set(element.dataset.bucketId, element);
        });
        wrapper.classList.toggle('has-members', buckets.length > 0);
        for (const bucket of buckets) {
            const bucketId = `${group.id}::${bucket.verb}`;
            let element = existingBuckets.get(bucketId);
            existingBuckets.delete(bucketId);
            if (!element) {
                const created = document.createElement('div');
                created.className = 'agent-activity-bucket';
                created.dataset.bucketId = bucketId;
                const summary = document.createElement('button');
                summary.type = 'button';
                summary.className = 'agent-activity-group-summary';
                // Text first, chevron after it (a right chevron that turns down when open).
                summary.innerHTML = '<span class="agent-activity-group-current" hidden></span><span class="agent-activity-group-text"></span><span class="agent-activity-group-chevron" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>';
                summary.addEventListener('click', () => {
                    if (this.expandedGroups.has(bucketId)) this.expandedGroups.delete(bucketId);
                    else this.expandedGroups.add(bucketId);
                    this.applyGroupExpansion(created, bucketId);
                });
                const body = document.createElement('div');
                body.className = 'agent-activity-group-body';
                created.append(summary, body);
                element = created;
            }
            const summary = element.querySelector<HTMLElement>(':scope > .agent-activity-group-summary')!;
            const body = element.querySelector<HTMLElement>(':scope > .agent-activity-group-body')!;
            const { text, current, active } = bucketSummary(bucket.verb, bucket.members, live);
            const textEl = summary.querySelector<HTMLElement>('.agent-activity-group-text');
            if (textEl) textEl.textContent = text;
            const currentEl = summary.querySelector<HTMLElement>('.agent-activity-group-current');
            if (currentEl) {
                currentEl.textContent = current ?? '';
                currentEl.hidden = !current;
                // Trails the chevron: label › running step.
                summary.append(currentEl);
            }
            summary.setAttribute('aria-label', current ? `${text} — ${current}` : text);
            summary.classList.toggle('is-active', active);
            bucket.members.forEach((item, index) => place(renderRow(item), body, index));
            place(element, wrapper, slot++);
            this.applyGroupExpansion(element, bucketId);
        }
        for (const stale of existingBuckets.values()) stale.remove();
    }

    private applyGroupExpansion(bucket: HTMLElement, bucketId: string): void {
        const expanded = this.expandedGroups.has(bucketId);
        const body = bucket.querySelector<HTMLElement>(':scope > .agent-activity-group-body');
        const summary = bucket.querySelector<HTMLElement>(':scope > .agent-activity-group-summary');
        if (body) body.hidden = !expanded;
        if (summary) {
            summary.setAttribute('aria-expanded', String(expanded));
            summary.title = t(expanded ? 'activity.collapse' : 'activity.expand');
        }
        bucket.classList.toggle('expanded', expanded);
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
