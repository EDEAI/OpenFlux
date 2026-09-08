import type { GatewayClient, ScheduledTaskView, SchedulerTaskInput, TaskRunView } from '../gateway-client';
import { escapeHtml } from '../utils/format';
import { formatCountdown, formatTriggerDisplay } from '../utils/scheduler-format';
import { schedulerCopy, type SchedulerCopyKey } from './copy';
import { filterTasks, hasUnreadRun, scheduleDraft, triggerFromDraft, type ScheduleDraft, type TaskFilter } from './model';

type SchedulerApi = Pick<GatewayClient, 'getSchedulerTasks' | 'getSchedulerRuns' | 'createSchedulerTask' | 'updateSchedulerTask' | 'pauseSchedulerTask' | 'resumeSchedulerTask' | 'deleteSchedulerTask' | 'triggerSchedulerTask'>;
export interface SchedulerConversation { id: string; title: string; agentId?: string; }
export interface SchedulerPageOptions {
    api(): SchedulerApi | null;
    sessions(): Promise<SchedulerConversation[]>;
    currentSessionId?(): string | undefined;
    locale(): string;
    onTasks(tasks: ScheduledTaskView[]): void;
    onSelect(taskId: string | null): void;
    openChat(sessionId?: string, agentId?: string, run?: TaskRunView): Promise<void>;
    createInChat(prompt: string): void;
    confirm(message: string): Promise<boolean>;
    notify(message: string): void;
}

const paths: Record<string, string> = {
    search: '<circle cx="10.8" cy="10.8" r="7.2"/><path d="m16 16 5 5"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<circle cx="12" cy="12" r="9"/><path d="M9 8v8M15 8v8"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z"/>',
    refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 3m0 7a9 9 0 0 0 16-3"/>',
    arrow: '<path d="M7 17 17 7H7m10 0v10"/>', back: '<path d="m14 6-6 6 6 6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    note: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    flag: '<path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
};
function icon(name: string): string { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.note}</svg>`; }
const readKey = 'openflux-scheduler-read-v1';

function canRunNow(task: ScheduledTaskView): boolean {
    return task.status === 'active'
        || task.status === 'paused'
        || task.status === 'error'
        || (task.status === 'completed' && task.trigger.type === 'once');
}

/** Owns the scheduled-task page, including selection and stale-request guards. */
export class SchedulerPage {
    private tasks: ScheduledTaskView[] = [];
    private conversations: SchedulerConversation[] = [];
    private contentDrafts = new Map<string, { name: string; prompt: string }>();
    private savingContent = new Set<string>();
    private selectedId: string | null = null;
    private filter: TaskFilter = 'all';
    private query = '';
    private readAt: Record<string, number> = {};
    private runs = new Map<string, TaskRunView[]>();
    private runRequests = new Map<string, number>();
    private refreshId = 0;
    private busy = new Set<string>();
    private running = new Set<string>();
    private openingRunId: string | null = null;
    private menu: HTMLElement | null = null;
    private editor: HTMLElement | null = null;
    private list: HTMLElement;
    private detail: HTMLElement;
    private errorHost: HTMLElement;
    private errorMessage = '';

    constructor(private root: HTMLElement, private options: SchedulerPageOptions) {
        try {
            const value: unknown = JSON.parse(localStorage.getItem(readKey) || '{}');
            if (value && typeof value === 'object') for (const [id, time] of Object.entries(value)) {
                if (typeof time === 'number' && Number.isFinite(time)) this.readAt[id] = time;
            }
        } catch { /* Preferences are optional. */ }
        root.classList.add('scheduler-page');
        root.innerHTML = `<div class="sched-layout">
          <section class="sched-list-pane">
            <div class="sched-list-top"><div class="sched-intro"><h1>${this.c('title')}</h1><p>${this.c('subtitle')}</p></div>
              <div class="sched-create-wrap"><button class="sched-create" data-action="create-menu" aria-haspopup="menu" aria-expanded="false">${this.c('create')} ${icon('chevron')}</button></div></div>
            <label class="sched-search">${icon('search')}<input type="search" aria-label="${this.c('search')}" placeholder="${this.c('search')}" /></label>
            <div class="sched-list-toolbar"><div class="sched-filters" role="tablist" aria-label="${this.c('title')}">${(['all', 'active', 'paused', 'completed'] as const).map(filter => `<button role="tab" data-filter="${filter}" aria-selected="${filter === 'all'}" class="${filter === 'all' ? 'is-active' : ''}">${this.c(filter)}</button>`).join('')}</div>
              <button class="sched-mark-read" data-action="mark-read">${icon('check')} ${this.c('mark_read')}</button>
              <button class="sched-icon-button" data-action="refresh" aria-label="${this.c('refresh')}" title="${this.c('refresh')}">${icon('refresh')}</button></div>
            <div class="sched-error" role="alert" hidden></div><div class="sched-task-list"></div><div class="sched-suggestions"></div>
          </section><section class="sched-detail-pane" aria-label="${this.c('details')}" hidden></section>
        </div>`;
        this.list = root.querySelector('.sched-task-list')!;
        this.detail = root.querySelector('.sched-detail-pane')!;
        this.errorHost = root.querySelector('.sched-error')!;
        root.addEventListener('click', event => void this.handleClick(event));
        this.detail.addEventListener('input', event => this.updateContentDraft(event));
        root.querySelector('input[type="search"]')!.addEventListener('input', event => {
            this.query = (event.target as HTMLInputElement).value;
            this.renderList();
        });
        document.addEventListener('pointerdown', event => {
            if (this.menu && !this.menu.contains(event.target as Node)
                && !(event.target as HTMLElement).closest('[aria-haspopup="menu"]')) this.closeMenu();
            if (this.editor?.classList.contains('sched-field-popover') && !this.editor.contains(event.target as Node)
                && !(event.target as HTMLElement).closest('[data-action="edit-session"], [data-action="edit-frequency"]')) this.closeEditor();
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || root.classList.contains('hidden')) return;
            if (this.editor) this.closeEditor(true);
            else if (this.menu) this.closeMenu();
            else this.showList();
        });
        document.addEventListener('locale-changed', () => this.localize());
        window.addEventListener('resize', () => { if (this.editor?.classList.contains('sched-field-popover')) this.closeEditor(); });
        this.detail.addEventListener('wheel', () => { if (this.editor?.classList.contains('sched-field-popover')) this.closeEditor(); }, { passive: true });
        this.renderList();
        this.renderSuggestions();
    }

    private c(key: SchedulerCopyKey): string { return schedulerCopy(this.options.locale(), key); }
    private api(): SchedulerApi {
        const api = this.options.api();
        if (!api) throw new Error(this.c('disconnected'));
        return api;
    }
    private showError(error?: unknown): void {
        this.errorMessage = error instanceof Error ? error.message : error ? String(error) : '';
        for (const host of [this.errorHost, this.detail.querySelector<HTMLElement>('.sched-detail-error')]) {
            if (host) { host.hidden = !this.errorMessage; host.textContent = this.errorMessage; }
        }
    }
    private persistRead(): void {
        try { localStorage.setItem(readKey, JSON.stringify(this.readAt)); } catch { /* Private mode or storage quota. */ }
    }
    private markRead(task: ScheduledTaskView): void {
        if (task.lastRunAt) this.readAt[task.id] = task.lastRunAt;
        this.persistRead();
    }

    async refresh(): Promise<void> {
        const request = ++this.refreshId;
        try {
            const [tasks, conversations] = await Promise.all([this.api().getSchedulerTasks(), this.options.sessions()]);
            if (request !== this.refreshId) return;
            this.tasks = tasks;
            this.conversations = conversations;
            for (const id of this.contentDrafts.keys()) if (!tasks.some(task => task.id === id)) this.contentDrafts.delete(id);
            this.options.onTasks(tasks);
            this.showError();
            if (this.selectedId && !tasks.some(task => task.id === this.selectedId)) this.showList();
            const selected = this.tasks.find(task => task.id === this.selectedId);
            if (selected) this.markRead(selected);
            this.renderList();
            this.renderDetail();
        } catch (error) {
            if (request === this.refreshId) this.showError(error);
        }
    }

    onEvent(event: { type: string; taskId: string }): void {
        if (event.type === 'run_start') this.running.add(event.taskId);
        if (event.type === 'run_complete' || event.type === 'run_failed') this.running.delete(event.taskId);
    }

    showList(): void {
        this.selectedId = null;
        this.options.onSelect(null);
        this.root.classList.remove('has-detail');
        this.detail.hidden = true;
        this.closeMenu();
        this.closeEditor();
        this.renderList();
    }

    selectTask(id: string): void {
        const task = this.tasks.find(item => item.id === id);
        if (!task) return;
        this.selectedId = id;
        this.options.onSelect(id);
        this.markRead(task);
        this.closeMenu();
        this.closeEditor();
        this.root.classList.add('has-detail');
        this.detail.hidden = false;
        this.renderList();
        this.renderDetail();
        void this.refreshRuns(id);
    }

    hide(): void { this.showList(); this.closeEditor(); }

    async refreshRuns(taskId: string): Promise<void> {
        const request = (this.runRequests.get(taskId) || 0) + 1;
        this.runRequests.set(taskId, request);
        try {
            const runs = await this.api().getSchedulerRuns(taskId, 50);
            if (this.runRequests.get(taskId) !== request) return;
            this.runs.set(taskId, runs);
            if (this.selectedId === taskId) this.renderHistory(taskId);
        } catch (error) {
            if (this.selectedId === taskId && this.runRequests.get(taskId) === request) {
                const host = this.detail.querySelector('.sched-history');
                if (host) { host.textContent = error instanceof Error ? error.message : this.c('action_failed'); host.setAttribute('role', 'alert'); }
            }
        }
    }

    updateCountdowns(): void {
        this.root.querySelectorAll<HTMLElement>('[data-next-run]').forEach(el => {
            el.textContent = this.nextRun(Number(el.dataset.nextRun));
        });
    }

    private nextRun(timestamp: number): string {
        if (this.options.locale() !== 'en') return `${this.c('next_run')} ${formatCountdown(timestamp, Date.now())}`;
        const minutes = Math.ceil((timestamp - Date.now()) / 60000);
        if (minutes <= 0) return 'Running soon';
        const unit = minutes >= 1440 ? 'day' : minutes >= 60 ? 'hour' : 'minute';
        const count = unit === 'day' ? Math.ceil(minutes / 1440) : unit === 'hour' ? Math.ceil(minutes / 60) : minutes;
        return `Next run in ${count} ${unit}${count === 1 ? '' : 's'}`;
    }

    private triggerText(task: ScheduledTaskView): string {
        if (this.options.locale() !== 'en') return formatTriggerDisplay(task.trigger);
        const draft = scheduleDraft(task.trigger);
        if (draft.preset === 'once') return new Date(task.trigger.runAt || '').toLocaleString('en');
        if (draft.preset === 'interval') return `Every ${draft.interval} ${this.c(draft.unit === '86400000' ? 'days' : draft.unit === '3600000' ? 'hours' : draft.unit === '60000' ? 'minutes' : draft.unit === '1000' ? 'seconds' : 'milliseconds').toLowerCase()}`;
        if (draft.preset === 'custom') return this.c('custom');
        return `${this.c(draft.preset)} ${draft.preset === 'weekly' ? new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(2024, 0, 7 + Number(draft.weekday))) + ' ' : ''}${draft.time}`;
    }

    private renderList(): void {
        this.root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => {
            const active = button.dataset.filter === this.filter;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });
        const tasks = filterTasks(this.tasks, this.filter, this.query);
        this.list.innerHTML = tasks.length ? tasks.map(task => {
            const unread = hasUnreadRun(task, this.readAt);
            const running = this.running.has(task.id);
            const meta = task.status === 'active' && task.nextRunAt
                ? `<span data-next-run="${task.nextRunAt}">${this.nextRun(task.nextRunAt)}</span>`
                : `<span>${this.c(task.status === 'error' ? 'error' : task.status === 'active' ? 'no_next' : task.status)}</span>`;
            return `<div class="sched-task-row ${task.id === this.selectedId ? 'is-selected' : ''} ${task.status === 'paused' || task.status === 'completed' ? 'is-muted' : ''}" data-task-id="${escapeHtml(task.id)}">
                <button class="sched-task-open" data-action="select" aria-pressed="${task.id === this.selectedId}"><span class="sched-task-indicator is-${running ? 'running' : task.status} ${unread ? 'is-unread' : ''}" title="${this.c(running ? 'running' : task.status)}">${task.status === 'paused' ? icon('play') : task.status === 'completed' ? icon('check') : ''}</span>
                  <span class="sched-task-text"><span class="sched-task-name">${escapeHtml(task.name)}</span><span class="sched-task-meta">${escapeHtml(this.triggerText(task))}<span>·</span>${running ? this.c('running') : meta}</span></span></button>
                <button class="sched-task-menu-button sched-icon-button" data-action="task-menu" aria-label="${this.c('more')}: ${escapeHtml(task.name)}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button></div>`;
        }).join('') : `<div class="sched-empty"><p>${this.c(this.tasks.length ? 'no_results' : 'empty')}</p><span>${this.c(this.tasks.length ? 'no_results_hint' : 'empty_hint')}</span></div>`;
    }

    private renderSuggestions(): void {
        const host = this.root.querySelector('.sched-suggestions')!;
        host.innerHTML = `<h2>${this.c('suggestions')}</h2>${(['daily', 'weekly', 'monitor'] as const).map((key, index) => `<button class="sched-suggestion" data-template="${key}"><span class="sched-suggestion-icon ${['blue', 'purple', 'green'][index]}">${icon(['bell', 'note', 'flag'][index])}</span><span><strong>${this.c(`${key}_title`)}</strong> <small>${this.c(`${key}_schedule`)}</small><p>${this.c(`${key}_description`)}</p></span></button>`).join('')}`;
    }

    private localize(): void {
        this.root.querySelector('.sched-intro h1')!.textContent = this.c('title');
        this.root.querySelector('.sched-intro p')!.textContent = this.c('subtitle');
        const search = this.root.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.placeholder = this.c('search'); search.setAttribute('aria-label', this.c('search'));
        this.root.querySelector('.sched-create')!.innerHTML = `${this.c('create')} ${icon('chevron')}`;
        this.root.querySelector('.sched-mark-read')!.innerHTML = `${icon('check')} ${this.c('mark_read')}`;
        this.root.querySelectorAll<HTMLElement>('[data-filter]').forEach(button => { button.textContent = this.c(button.dataset.filter as TaskFilter); });
        this.renderList(); this.renderSuggestions(); this.renderDetail();
    }

    private conversationLabel(task: ScheduledTaskView): string {
        const sessionId = task.sessionId || this.runs.get(task.id)?.find(run => run.sessionId)?.sessionId;
        return this.conversations.find(session => session.id === sessionId)?.title
            || (sessionId ? `${this.c('linked_chat')} · ${sessionId.slice(0, 12)}` : this.c('chat_after_run'));
    }

    private contentChanged(task: ScheduledTaskView): boolean {
        const draft = this.contentDrafts.get(task.id);
        return !!draft && (draft.name !== task.name || (task.target.type === 'agent' && draft.prompt !== task.target.prompt));
    }

    private fitPrompt(): void {
        const prompt = this.detail.querySelector<HTMLTextAreaElement>('textarea.sched-prompt');
        if (prompt) { prompt.style.height = 'auto'; prompt.style.height = `${Math.max(144, prompt.scrollHeight + 2)}px`; }
    }

    private updateContentDraft(event: Event): void {
        const target = event.target as HTMLElement;
        if (!target.matches('.sched-detail-title, textarea.sched-prompt')) return;
        const task = this.tasks.find(task => task.id === this.selectedId);
        if (!task) return;
        const draft = {
            name: this.detail.querySelector<HTMLInputElement>('.sched-detail-title')!.value,
            prompt: this.detail.querySelector<HTMLTextAreaElement>('textarea.sched-prompt')?.value || '',
        };
        this.contentDrafts.set(task.id, draft);
        if (!this.contentChanged(task) && !this.savingContent.has(task.id)) this.contentDrafts.delete(task.id);
        const save = this.detail.querySelector<HTMLButtonElement>('[data-action="save-content"]')!;
        save.hidden = !this.contentChanged(task) && !this.savingContent.has(task.id);
        this.fitPrompt();
    }

    private async saveContent(id: string): Promise<void> {
        const task = this.tasks.find(task => task.id === id);
        const draft = this.contentDrafts.get(id);
        if (!task || !draft || !this.contentChanged(task) || this.busy.has(id)) return;
        const snapshot = { ...draft };
        const name = snapshot.name.trim();
        const prompt = snapshot.prompt.trim();
        if (!name || (task.target.type === 'agent' && !prompt)) { this.showError(new Error(this.c('required'))); return; }
        this.busy.add(id); this.savingContent.add(id); this.showError(); this.renderDetail();
        try {
            const patch = { ...(name !== task.name ? { name } : {}), ...(task.target.type === 'agent' && prompt !== task.target.prompt ? { target: { ...task.target, prompt } } : {}) };
            if (Object.keys(patch).length) {
                const saved = await this.api().updateSchedulerTask(id, patch);
                this.tasks = this.tasks.map(item => item.id === id ? saved : item);
                this.options.onTasks(this.tasks);
            }
            const latest = this.contentDrafts.get(id);
            if (latest && latest.name === snapshot.name && latest.prompt === snapshot.prompt) this.contentDrafts.delete(id);
            await this.refresh();
        } catch (error) { this.showError(error); }
        finally { this.busy.delete(id); this.savingContent.delete(id); this.renderList(); this.renderDetail(); }
    }

    private renderDetail(): void {
        const task = this.tasks.find(item => item.id === this.selectedId);
        if (!task) return;
        const scroll = this.detail.querySelector('.sched-detail-scroll')?.scrollTop || 0;
        const focused = this.detail.dataset.taskId === task.id && this.detail.contains(document.activeElement) && document.activeElement?.matches('.sched-detail-title, textarea.sched-prompt')
            ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
        const focus = focused ? { selector: focused.classList.contains('sched-detail-title') ? '.sched-detail-title' : 'textarea.sched-prompt', start: focused.selectionStart, end: focused.selectionEnd, scroll: focused.scrollTop } : null;
        const draft = this.contentDrafts.get(task.id);
        this.detail.dataset.taskId = task.id;
        const chat = task.sessionId || this.runs.get(task.id)?.find(run => run.sessionId)?.sessionId;
        this.detail.innerHTML = `<div class="sched-detail-header"><button class="sched-icon-button sched-detail-back" data-action="close-detail" aria-label="${this.c('back')}">${icon('back')}</button><span class="sched-detail-status is-${task.status}">${this.c(this.running.has(task.id) ? 'running' : task.status === 'active' ? 'active_detail' : task.status)}</span>
          <div class="sched-detail-controls" data-task-id="${escapeHtml(task.id)}"><button class="sched-icon-button" data-action="task-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this.c('more')}">${icon('more')}</button>
          ${task.status === 'active' || task.status === 'paused' ? `<button class="sched-icon-button" data-action="${task.status === 'active' ? 'pause' : 'resume'}" title="${this.c(task.status === 'active' ? 'pause' : 'resume')}" aria-label="${this.c(task.status === 'active' ? 'pause' : 'resume')}" ${this.busy.has(task.id) ? 'disabled' : ''}>${icon(task.status === 'active' ? 'pause' : 'play')}</button>` : ''}
          <button class="sched-icon-button" data-action="close-detail" aria-label="${this.c('close')}" title="${this.c('close')}">${icon('close')}</button></div></div>
          <div class="sched-detail-scroll"><div class="sched-title-row"><input class="sched-detail-title" aria-label="${this.c('name')}" maxlength="160" value="${escapeHtml(draft?.name ?? task.name)}" /><button class="sched-inline-save sched-primary" data-action="save-content" ${this.contentChanged(task) || this.savingContent.has(task.id) ? '' : 'hidden'} ${this.busy.has(task.id) ? 'disabled' : ''}>${this.c(this.savingContent.has(task.id) ? 'creating' : 'save_inline')}</button></div>
          <p class="sched-error sched-detail-error" role="alert" ${this.errorMessage ? '' : 'hidden'}>${escapeHtml(this.errorMessage)}</p>
          ${task.target.type === 'agent' ? `<textarea class="sched-prompt" aria-label="${this.c('prompt')}" maxlength="50000">${escapeHtml(draft?.prompt ?? task.target.prompt ?? '')}</textarea>` : `<div class="sched-prompt" tabindex="0">${escapeHtml(`${this.c('workflow')}: ${task.target.workflowId || ''}`)}</div>`}
          ${task.status === 'error' ? `<p class="sched-error">${this.c('task_error')}</p>` : ''}
          <section class="sched-section"><h3>${this.c('details')}</h3><div class="sched-field-group"><div class="sched-field-row"><span>${this.c('runs_in')}</span><button data-action="edit-session" aria-haspopup="dialog" ${this.busy.has(task.id) ? 'disabled' : ''}>${escapeHtml(this.conversationLabel(task))} ${icon('chevron')}</button></div></div></section>
          <section class="sched-section"><h3>${this.c('frequency')}<button class="sched-icon-button" data-action="edit-frequency" aria-haspopup="dialog" aria-label="${this.c('edit_schedule')}" title="${this.c('edit_schedule')}" ${this.busy.has(task.id) ? 'disabled' : ''}>${icon('edit')}</button></h3>
          <div class="sched-field-group"><div class="sched-field-row"><span>${this.c('repeat')}</span><button data-action="edit-frequency" aria-haspopup="dialog" ${this.busy.has(task.id) ? 'disabled' : ''}>${escapeHtml(this.triggerText(task))} ${icon('chevron')}</button></div></div></section>
          <section class="sched-section"><h3>${this.c('history')}<button class="sched-icon-button" data-action="refresh-runs" aria-label="${this.c('refresh')}">${icon('refresh')}</button></h3><div class="sched-history"></div></section></div>
          <div class="sched-detail-footer"><button class="sched-open-chat" data-action="open-chat" ${chat ? `data-session-id="${escapeHtml(chat)}"` : 'disabled'} title="${chat ? this.c('open_chat') : this.c('no_chat')}">${this.c('open_chat')} ${icon('arrow')}</button></div>`;
        this.detail.querySelector('.sched-detail-scroll')!.scrollTop = scroll;
        this.fitPrompt();
        if (focus) {
            const input = this.detail.querySelector<HTMLInputElement | HTMLTextAreaElement>(focus.selector);
            if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(focus.start, focus.end); input.scrollTop = focus.scroll; }
        }
        this.renderHistory(task.id);
    }

    private renderHistory(taskId: string): void {
        if (this.selectedId !== taskId) return;
        const host = this.detail.querySelector('.sched-history');
        if (!host) return;
        const runs = this.runs.get(taskId);
        host.innerHTML = !runs ? `<p class="sched-empty">${this.c('loading')}</p>` : !runs.length ? `<p class="sched-empty">${this.c('no_runs')}</p>` : runs.map(run => {
            const date = new Date(run.startedAt).toLocaleString(this.options.locale() === 'en' ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return `<button class="sched-history-item sched-history-link" data-action="open-run" data-run-id="${escapeHtml(run.id)}" ${this.openingRunId === run.id ? 'disabled aria-busy="true"' : ''} title="${this.c('open_run')}"><span class="sched-task-indicator is-${run.status}"></span><span class="sched-history-name">${escapeHtml(run.taskName)}<small>${this.c(this.openingRunId === run.id ? 'locating_run' : run.status === 'completed' ? 'success' : run.status === 'failed' ? 'failed' : 'running')}</small></span><time datetime="${new Date(run.startedAt).toISOString()}" title="${escapeHtml(new Date(run.startedAt).toLocaleString())}">${escapeHtml(date)}</time>${icon('arrow')}</button>`;
        }).join('');
        const task = this.tasks.find(item => item.id === taskId);
        const sessionId = task?.sessionId || runs?.find(run => run.sessionId)?.sessionId;
        const open = this.detail.querySelector<HTMLButtonElement>('.sched-open-chat');
        if (open && sessionId) { open.disabled = false; open.dataset.sessionId = sessionId; open.title = this.c('open_chat'); }
    }

    private closeMenu(): void {
        this.menu?.remove(); this.menu = null;
        this.root.querySelectorAll('[aria-expanded="true"][aria-haspopup="menu"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    }

    private openMenu(button: HTMLElement, taskId?: string): void {
        const wasOpen = button.getAttribute('aria-expanded') === 'true';
        this.closeMenu();
        if (wasOpen) return;
        const task = this.tasks.find(item => item.id === taskId);
        const actions: Array<[string, string, SchedulerCopyKey]> = task
            ? [['trigger', 'play', 'run_now'], ['edit', 'edit', 'edit'], ...(task.status === 'active' ? [['pause', 'pause', 'pause']] : task.status === 'paused' ? [['resume', 'play', 'resume']] : []), ['delete', 'trash', 'remove']] as Array<[string, string, SchedulerCopyKey]>
            : [['create', 'note', 'create_task'], ['create-chat', 'arrow', 'create_chat']];
        const menu = document.createElement('div');
        menu.className = 'sched-menu'; menu.setAttribute('role', 'menu');
        if (task) menu.dataset.taskId = task.id;
        menu.innerHTML = actions.map(([action, glyph, key]) => `<button role="menuitem" data-action="${action}" class="${action === 'delete' ? 'is-danger' : ''}" ${task && (this.busy.has(task.id) || (action === 'trigger' && (this.running.has(task.id) || !canRunNow(task)))) ? 'disabled' : ''}>${icon(glyph)} ${this.c(key)}</button>`).join('');
        this.root.append(menu); this.menu = menu; button.setAttribute('aria-expanded', 'true');
        const rect = button.getBoundingClientRect();
        const size = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.right - size.width, window.innerWidth - size.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - size.height - 8))}px`;
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }

    private async handleClick(event: MouseEvent): Promise<void> {
        const target = event.target as HTMLElement;
        if (target.closest('.sched-editor-backdrop, .sched-field-popover')) return;
        const filter = target.closest<HTMLElement>('[data-filter]')?.dataset.filter as TaskFilter | undefined;
        if (filter) { this.filter = filter; this.renderList(); return; }
        const template = target.closest<HTMLElement>('[data-template]')?.dataset.template;
        if (template) { this.openEditor(undefined, template as 'daily' | 'weekly' | 'monitor'); return; }
        const button = target.closest<HTMLElement>('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        const id = button.closest<HTMLElement>('[data-task-id]')?.dataset.taskId || this.selectedId;
        if (action === 'create-menu') { this.openMenu(button); return; }
        if (action === 'task-menu' && id) { this.openMenu(button, id); return; }
        this.closeMenu();
        if (action === 'select' && id) this.selectTask(id);
        else if (action === 'close-detail') this.showList();
        else if (action === 'create') this.openEditor();
        else if (action === 'create-chat') this.options.createInChat(this.c('chat_create_prompt'));
        else if (action === 'edit' && id) this.openEditor(this.tasks.find(task => task.id === id));
        else if ((action === 'edit-session' || action === 'edit-frequency') && id) this.openFieldEditor(button, id, action === 'edit-session' ? 'session' : 'frequency');
        else if (action === 'save-content' && id) await this.saveContent(id);
        else if (action === 'refresh') { await this.refresh(); if (this.selectedId) await this.refreshRuns(this.selectedId); }
        else if (action === 'refresh-runs' && id) await this.refreshRuns(id);
        else if (action === 'mark-read') { this.tasks.forEach(task => this.markRead(task)); this.renderList(); }
        else if (action === 'open-run' && id) {
            const run = this.runs.get(id)?.find(item => item.id === button.dataset.runId);
            if (!run || this.openingRunId === run.id) return;
            this.openingRunId = run.id; this.renderHistory(id);
            try { await this.options.openChat(run.sessionId, this.conversations.find(session => session.id === run.sessionId)?.agentId, run); }
            catch (error) { this.showError(error); }
            finally { if (this.openingRunId === run.id) this.openingRunId = null; this.renderHistory(id); }
        } else if (action === 'open-chat') {
            try { await this.options.openChat(button.dataset.sessionId, this.tasks.find(task => task.id === id)?.agentId); }
            catch (error) { this.showError(error); }
        } else if (id && action && ['pause', 'resume', 'delete', 'trigger'].includes(action)) await this.runAction(id, action);
    }

    private async runAction(id: string, action: string): Promise<void> {
        if (this.busy.has(id)) return;
        if (action === 'delete' && !await this.options.confirm(this.c('delete_confirm'))) return;
        this.busy.add(id); this.renderDetail();
        try {
            const api = this.api();
            let ok = true;
            if (action === 'pause') ok = await api.pauseSchedulerTask(id);
            else if (action === 'resume') ok = await api.resumeSchedulerTask(id);
            else if (action === 'delete') ok = await api.deleteSchedulerTask(id);
            else { const result = await api.triggerSchedulerTask(id); ok = result.accepted; if (ok) this.options.notify(this.c('triggered')); }
            if (!ok) throw new Error(this.c('action_failed'));
            await this.refresh();
            if (this.selectedId === id) await this.refreshRuns(id);
        } catch (error) { this.showError(error); }
        finally { this.busy.delete(id); this.renderList(); this.renderDetail(); }
    }

    private closeEditor(restoreFocus = false): void {
        const field = this.editor?.dataset.field;
        this.editor?.remove(); this.editor = null;
        if (restoreFocus && field) this.detail.querySelector<HTMLButtonElement>(`[data-action="edit-${field}"]`)?.focus();
    }

    showRunResult(run: TaskRunView): void {
        this.closeMenu(); this.closeEditor();
        const overlay = document.createElement('div');
        overlay.className = 'sched-editor-backdrop';
        const date = new Date(run.startedAt).toLocaleString(this.options.locale() === 'en' ? 'en' : 'zh-CN');
        overlay.innerHTML = `<section class="sched-editor sched-run-fallback" role="dialog" aria-modal="true" aria-labelledby="sched-run-result-title"><header><h2 id="sched-run-result-title">${escapeHtml(run.taskName)}</h2><button class="sched-icon-button" data-dismiss aria-label="${this.c('dismiss')}">${icon('close')}</button></header>
          <div class="sched-editor-body"><p class="sched-run-note">${this.c('run_unlinked')}</p><p class="sched-run-note">${escapeHtml(date)} · ${this.c(run.status === 'completed' ? 'success' : run.status === 'failed' ? 'failed' : 'running')}</p>
          <h3>${this.c('run_saved_result')}</h3><div class="sched-run-saved-output">${escapeHtml(run.output || '')}</div>${run.error ? `<p class="sched-error">${escapeHtml(run.error)}</p>` : ''}${!run.output && !run.error ? `<p>${this.c('run_no_result')}</p>` : ''}</div>
          <footer class="sched-editor-footer"><button class="sched-secondary" data-dismiss>${this.c('dismiss')}</button></footer></section>`;
        this.root.append(overlay); this.editor = overlay;
        overlay.querySelectorAll('[data-dismiss]').forEach(button => button.addEventListener('click', () => this.closeEditor()));
        overlay.addEventListener('click', event => { if (event.target === overlay) this.closeEditor(); });
        overlay.addEventListener('keydown', event => {
            if (event.key !== 'Tab') return;
            const buttons = overlay.querySelectorAll<HTMLButtonElement>('button');
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
            else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); }
        });
        overlay.querySelector<HTMLButtonElement>('button')?.focus();
    }

    private openFieldEditor(button: HTMLElement, taskId: string, field: 'session' | 'frequency'): void {
        const task = this.tasks.find(task => task.id === taskId);
        if (!task || this.busy.has(taskId)) return;
        const wasOpen = this.editor?.dataset.taskId === taskId && this.editor.dataset.field === field;
        this.closeEditor();
        if (wasOpen) return;
        const draft = scheduleDraft(task.trigger);
        const popup = document.createElement('div');
        popup.className = 'sched-field-popover'; popup.dataset.field = field; popup.dataset.taskId = taskId;
        popup.innerHTML = `<form class="sched-field-form" role="dialog" aria-labelledby="sched-field-title"><header><h3 id="sched-field-title">${this.c(field === 'session' ? 'runs_in' : 'repeat')}</h3><button type="button" class="sched-icon-button" data-dismiss aria-label="${this.c('cancel')}">${icon('close')}</button></header>
          <div class="sched-field-body">${field === 'session'
                ? `<input class="sched-session-search" type="search" aria-label="${this.c('search_sessions')}" placeholder="${this.c('search_sessions')}" /><div class="sched-session-options"></div>`
                : this.scheduleFields(draft)}<p class="sched-error" role="alert" hidden></p></div>
          ${field === 'frequency' ? `<footer class="sched-field-footer"><button type="button" class="sched-secondary" data-dismiss>${this.c('cancel')}</button><button type="submit" class="sched-primary">${this.c('save_inline')}</button></footer>` : ''}</form>`;
        this.root.append(popup); this.editor = popup;
        const form = popup.querySelector<HTMLFormElement>('form')!;
        const errorHost = popup.querySelector<HTMLElement>('[role="alert"]')!;
        const rect = button.getBoundingClientRect();
        const position = () => {
            if (this.editor !== popup) return;
            const size = popup.getBoundingClientRect();
            popup.style.left = `${Math.max(12, Math.min(rect.right - size.width, window.innerWidth - size.width - 12))}px`;
            const below = rect.bottom + 8;
            const above = rect.top - size.height - 8;
            popup.style.top = `${Math.max(12, below + size.height <= window.innerHeight - 12 ? below : above >= 12 ? above : window.innerHeight - size.height - 12)}px`;
        };
        const showError = (error: unknown) => {
            if (this.editor !== popup) return;
            const message = error instanceof Error ? error.message : this.c('action_failed');
            errorHost.textContent = ['invalid_date', 'invalid_interval', 'invalid_cron', 'invalid_time'].includes(message) ? this.c(message as SchedulerCopyKey) : message;
            errorHost.hidden = false; position();
        };
        const save = async (patch: { sessionId: string } | { trigger: ScheduledTaskView['trigger'] }) => {
            if (this.editor !== popup || this.busy.has(taskId)) return;
            this.busy.add(taskId); errorHost.hidden = true; form.setAttribute('aria-busy', 'true');
            const controls = () => popup.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button:not([data-dismiss])');
            controls().forEach(control => { control.disabled = true; });
            try {
                const saved = await this.api().updateSchedulerTask(taskId, patch);
                this.tasks = this.tasks.map(item => item.id === taskId ? saved : item);
                this.options.onTasks(this.tasks);
                if (this.editor === popup) this.closeEditor();
                await this.refresh();
            } catch (error) { showError(error); }
            finally {
                this.busy.delete(taskId); form.removeAttribute('aria-busy'); controls().forEach(control => { control.disabled = false; });
                this.renderList(); this.renderDetail();
            }
        };
        popup.querySelectorAll('[data-dismiss]').forEach(control => control.addEventListener('click', () => this.closeEditor(true)));
        if (field === 'session') {
            const search = popup.querySelector<HTMLInputElement>('.sched-session-search')!;
            const options = popup.querySelector<HTMLElement>('.sched-session-options')!;
            const renderOptions = () => {
                const term = search.value.trim().toLocaleLowerCase();
                const sessions = this.conversations.filter(session => session.title.toLocaleLowerCase().includes(term));
                const current = this.tasks.find(item => item.id === taskId)?.sessionId;
                options.innerHTML = sessions.length ? sessions.map(session => `<button type="button" class="sched-session-option ${session.id === current ? 'is-selected' : ''}" data-session-id="${escapeHtml(session.id)}" aria-pressed="${session.id === current}" ${this.busy.has(taskId) ? 'disabled' : ''}><span>${escapeHtml(session.title)}</span>${session.id === current ? icon('check') : ''}</button>`).join('')
                    : `<p class="sched-empty">${this.c(term ? 'no_results' : 'no_sessions')}</p>`;
                position();
            };
            renderOptions(); search.addEventListener('input', renderOptions);
            form.addEventListener('submit', event => event.preventDefault());
            options.addEventListener('click', event => {
                const choice = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-session-id]');
                if (!choice || choice.disabled) return;
                const sessionId = choice.dataset.sessionId!;
                if (sessionId === this.tasks.find(item => item.id === taskId)?.sessionId) { this.closeEditor(true); return; }
                void save({ sessionId });
            });
            void this.options.sessions().then(sessions => {
                if (this.editor !== popup) return;
                this.conversations = sessions; renderOptions();
            }).catch(showError);
            search.focus();
        } else {
            this.bindScheduleFields(form, position);
            form.addEventListener('submit', event => {
                event.preventDefault();
                if (this.busy.has(taskId)) return;
                const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
                const changed = { preset: value('preset'), time: value('time'), weekday: value('weekday'), interval: value('interval'), unit: value('unit'), runAt: value('runAt'), expression: value('expression') } as ScheduleDraft;
                if (JSON.stringify(changed) === JSON.stringify(draft)) { this.closeEditor(true); return; }
                try { void save({ trigger: triggerFromDraft(changed) }); } catch (error) { showError(error); }
            });
            form.querySelector<HTMLSelectElement>('select')?.focus();
        }
        position();
    }

    private bindScheduleFields(form: HTMLFormElement, onChange?: () => void): void {
        const syncFields = () => {
            const preset = (form.elements.namedItem('preset') as HTMLSelectElement).value;
            form.querySelectorAll<HTMLElement>('[data-schedule-part]').forEach(el => {
                const part = el.dataset.schedulePart;
                el.hidden = !(part === preset || (part === 'time' && ['daily', 'weekdays', 'weekly'].includes(preset)) || (part === 'weekday' && preset === 'weekly'));
            });
            onChange?.();
        };
        syncFields();
        form.querySelector('select[name="preset"]')!.addEventListener('change', syncFields);
    }

    private scheduleFields(draft: ScheduleDraft): string {
        return `<label class="sched-form-field">${this.c('repeat')}<select name="preset">${(['daily', 'weekdays', 'weekly', 'interval', 'once', 'custom'] as const).map(value => `<option value="${value}" ${draft.preset === value ? 'selected' : ''}>${this.c(value)}</option>`).join('')}</select></label>
          <div class="sched-form-grid" data-schedule-part="time"><label class="sched-form-field">${this.c('time')}<input type="time" name="time" value="${draft.time}" /></label><label class="sched-form-field" data-schedule-part="weekday">${this.c('weekday')}<select name="weekday">${[1, 2, 3, 4, 5, 6, 0].map(day => `<option value="${day}" ${draft.weekday === String(day) ? 'selected' : ''}>${new Intl.DateTimeFormat(this.options.locale() === 'en' ? 'en' : 'zh-CN', { weekday: 'long' }).format(new Date(2024, 0, 7 + day))}</option>`).join('')}</select></label></div>
          <div class="sched-form-grid" data-schedule-part="interval"><label class="sched-form-field">${this.c('every')}<input type="number" name="interval" min="0.001" step="any" value="${draft.interval}" /></label><label class="sched-form-field">${this.c('interval')}<select name="unit">${([['60000', 'minutes'], ['3600000', 'hours'], ['86400000', 'days'], ['1000', 'seconds'], ['1', 'milliseconds']] as const).map(([value, key]) => `<option value="${value}" ${draft.unit === value ? 'selected' : ''}>${this.c(key)}</option>`).join('')}</select></label></div>
          <label class="sched-form-field" data-schedule-part="once">${this.c('date')}<input type="datetime-local" name="runAt" value="${draft.runAt}" /></label>
          <label class="sched-form-field" data-schedule-part="custom">${this.c('cron')}<input name="expression" value="${escapeHtml(draft.expression)}" /><small>${this.c('cron_hint')}</small></label>
          <p class="sched-timezone">${this.c('timezone')} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}</p>`;
    }

    openEditor(task?: ScheduledTaskView, template?: 'daily' | 'weekly' | 'monitor'): void {
        this.closeMenu(); this.closeEditor();
        const draft = scheduleDraft(task?.trigger || (template ? { type: 'cron', expression: template === 'daily' ? '0 8 * * 1-5' : template === 'weekly' ? '0 16 * * 5' : '0 9 * * 1-5' } : undefined));
        const overlay = document.createElement('div');
        overlay.className = 'sched-editor-backdrop';
        const contentDraft = task ? this.contentDrafts.get(task.id) : undefined;
        const name = contentDraft?.name ?? task?.name ?? (template ? this.c(`${template}_title`) : '');
        const prompt = contentDraft?.prompt ?? task?.target.prompt ?? (template ? this.c(`${template}_prompt`) : '');
        const initialSessionId = task ? task.sessionId || '' : this.options.currentSessionId?.() || '';
        overlay.innerHTML = `<form class="sched-editor" role="dialog" aria-modal="true" aria-labelledby="sched-editor-title"><header><h2 id="sched-editor-title">${this.c(task ? 'edit' : 'create_task')}</h2><button type="button" class="sched-icon-button" data-dismiss aria-label="${this.c('cancel')}">${icon('close')}</button></header>
          <div class="sched-editor-body"><label class="sched-form-field">${this.c('name')}<input name="name" maxlength="160" required value="${escapeHtml(name)}" /></label>
          ${task?.target.type === 'workflow' ? `<p>${this.c('workflow')}: ${escapeHtml(task.target.workflowId || '')}</p>` : `<label class="sched-form-field">${this.c('prompt')}<textarea name="prompt" rows="5" required placeholder="${this.c('prompt_placeholder')}">${escapeHtml(prompt)}</textarea></label>`}
          <label class="sched-form-field">${this.c('runs_in')}<select name="sessionId" ${task ? '' : 'required'}></select><small data-session-hint></small></label>
          ${this.scheduleFields(draft)}
          <p class="sched-error" role="alert" hidden></p></div><footer class="sched-editor-footer"><button type="button" class="sched-secondary" data-dismiss>${this.c('cancel')}</button><button type="submit" class="sched-primary">${this.c(task ? 'save' : 'create_task')}</button></footer></form>`;
        this.root.append(overlay); this.editor = overlay;
        const form = overlay.querySelector<HTMLFormElement>('form')!;
        const sessionSelect = form.querySelector<HTMLSelectElement>('[name="sessionId"]')!;
        const fillSessions = (selected: string) => {
            const sessions = [...this.conversations];
            if (task?.sessionId && !sessions.some(session => session.id === task.sessionId)) {
                sessions.push({ id: task.sessionId, title: this.conversationLabel(task) });
            }
            sessionSelect.innerHTML = `<option value="" ${task?.sessionId ? 'disabled' : ''}>${this.c(task && !task.sessionId ? 'chat_after_run' : 'select_chat')}</option>${sessions.map(session => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`).join('')}`;
            sessionSelect.value = sessions.some(session => session.id === selected) ? selected : '';
            const hint = form.querySelector<HTMLElement>('[data-session-hint]')!;
            hint.textContent = sessions.length ? '' : this.c('no_sessions');
            hint.hidden = !!sessions.length;
        };
        fillSessions(initialSessionId);
        let sessionChanged = false;
        sessionSelect.addEventListener('change', () => { sessionChanged = true; });
        void this.options.sessions().then(sessions => {
            if (this.editor !== overlay) return;
            this.conversations = sessions;
            fillSessions(sessionChanged ? sessionSelect.value : initialSessionId);
        }).catch(error => {
            if (this.editor !== overlay) return;
            const hint = form.querySelector<HTMLElement>('[data-session-hint]')!;
            hint.textContent = error instanceof Error ? error.message : this.c('action_failed'); hint.hidden = false;
        });
        this.bindScheduleFields(form);
        overlay.querySelectorAll('[data-dismiss]').forEach(button => button.addEventListener('click', () => this.closeEditor()));
        overlay.addEventListener('click', event => { if (event.target === overlay) this.closeEditor(); });
        overlay.addEventListener('keydown', event => {
            if (event.key !== 'Tab') return;
            const focusable = Array.from(form.querySelectorAll<HTMLElement>('input,textarea,select,button')).filter(el => !el.closest('[hidden]') && !(el as HTMLButtonElement).disabled);
            if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1]?.focus(); }
            else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0]?.focus(); }
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            void this.saveEditor(form, task);
        });
        form.querySelector<HTMLInputElement>('input')?.focus();
    }

    private async saveEditor(form: HTMLFormElement, task?: ScheduledTaskView): Promise<void> {
        const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
        if (submit.disabled) return;
        const errorHost = form.querySelector<HTMLElement>('[role="alert"]')!;
        const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value || '';
        const overlay = this.editor;
        try {
            const name = value('name').trim();
            const prompt = value('prompt').trim();
            if (!name || (task?.target.type !== 'workflow' && !prompt)) throw new Error(this.c('required'));
            const sessionId = value('sessionId');
            if (!sessionId && !task) throw new Error(this.c('session_required'));
            const draft = { preset: value('preset'), time: value('time'), weekday: value('weekday'), interval: value('interval'), unit: value('unit'), runAt: value('runAt'), expression: value('expression') } as ScheduleDraft;
            const triggerChanged = !task || JSON.stringify(draft) !== JSON.stringify(scheduleDraft(task.trigger));
            const trigger = triggerChanged ? triggerFromDraft(draft) : task!.trigger;
            const input: SchedulerTaskInput = { name, trigger, target: task?.target.type === 'workflow' ? task.target : { type: 'agent', prompt }, ...(sessionId ? { sessionId } : {}) };
            submit.disabled = true; submit.textContent = this.c('creating'); errorHost.hidden = true;
            const { sessionId: _sessionId, trigger: _trigger, ...unchangedFields } = input;
            const saved = task ? await this.api().updateSchedulerTask(task.id, { ...unchangedFields, ...(triggerChanged ? { trigger } : {}), ...(sessionId !== (task.sessionId || '') ? { sessionId } : {}) }) : await this.api().createSchedulerTask(input);
            const contentDraft = this.contentDrafts.get(saved.id);
            if (contentDraft && contentDraft.name.trim() === name && contentDraft.prompt.trim() === prompt) this.contentDrafts.delete(saved.id);
            if (this.editor === overlay) {
                this.closeEditor(); this.filter = 'all'; this.query = '';
                (this.root.querySelector('input[type="search"]') as HTMLInputElement).value = '';
                await this.refresh(); this.selectTask(saved.id); this.options.notify(this.c('saved'));
            } else await this.refresh();
        } catch (error) {
            if (this.editor !== overlay) return;
            const message = error instanceof Error ? error.message : this.c('action_failed');
            errorHost.textContent = ['invalid_date', 'invalid_interval', 'invalid_cron', 'invalid_time'].includes(message) ? this.c(message as SchedulerCopyKey) : message;
            errorHost.hidden = false;
        } finally { submit.disabled = false; submit.textContent = this.c(task ? 'save' : 'create_task'); }
    }
}
