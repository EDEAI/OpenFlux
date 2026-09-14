import type { ApprovalMode, LocalEntityView, Session } from '../gateway-client';
import { DEFAULT_AGENT_ICON } from '../agent-icons';
import { renderAgentIcon } from '../utils/format';

export const DEFAULT_ASSISTANT_ID = 'main';

export interface ConversationOwner {
    id: string;
    name: string;
    kind: 'assistant' | 'agent' | 'project';
    icon?: string;
}

export interface NewConversationGateway {
    createSession(
        title?: string,
        cloudChatroomId?: number,
        cloudAgentName?: string,
        agentId?: string,
        approvalMode?: ApprovalMode,
    ): Promise<Session>;
    updateSessionOwner(sessionId: string, ownerId: string): Promise<Session>;
}

export interface NewConversationControllerOptions {
    gateway: NewConversationGateway;
    getEntities(): readonly LocalEntityView[] | Promise<readonly LocalEntityView[]>;
    getApprovalMode?(): ApprovalMode;
    activate(session: Session, owner: ConversationOwner): void | Promise<void>;
    reconcile?(session: Session, owner: ConversationOwner): void | Promise<void>;
    reportError?(error: unknown): void;
}

function normalizedName(value: string | undefined): string {
    return (value || '').trim().toLocaleLowerCase();
}

/** Resolve the one non-project owner used by the global New conversation action. */
export function resolveDefaultAssistant(entities: readonly LocalEntityView[]): LocalEntityView {
    const agents = entities.filter(entity => entity.kind !== 'project');
    const assistant = agents.find(entity => entity.default === true)
        || agents.find(entity => entity.id === DEFAULT_ASSISTANT_ID)
        || agents.find(entity => normalizedName(entity.name) === 'openflux assistant');

    if (!assistant) {
        throw new Error('OpenFlux Assistant is unavailable.');
    }
    return assistant;
}

/** List every valid local conversation owner, with the default Assistant first. */
export function listConversationOwners(entities: readonly LocalEntityView[]): ConversationOwner[] {
    const assistant = resolveDefaultAssistant(entities);
    const projects = entities
        .filter(entity => entity.kind === 'project')
        .map(entity => ({ id: entity.id, name: entity.name, kind: 'project' as const, ...(entity.icon ? { icon: entity.icon } : {}) }));
    const agents = entities
        .filter(entity => entity.kind !== 'project' && entity.id !== assistant.id)
        .map(entity => ({ id: entity.id, name: entity.name, kind: 'agent' as const, ...(entity.icon ? { icon: entity.icon } : {}) }));

    return [
        { id: assistant.id, name: assistant.name || 'OpenFlux Assistant', kind: 'assistant', ...(assistant.icon ? { icon: assistant.icon } : {}) },
        ...projects,
        ...agents,
    ];
}

export function resolveConversationOwner(
    entities: readonly LocalEntityView[],
    ownerId?: string | null,
): ConversationOwner {
    const owners = listConversationOwners(entities);
    if (!ownerId) return owners[0];

    const owner = owners.find(candidate => candidate.id === ownerId);
    if (!owner) throw new Error('The selected conversation owner is unavailable.');
    return owner;
}

/**
 * Orchestrates the two user flows without depending on main.ts:
 * - the global action immediately creates a conversation in OpenFlux Assistant;
 * - the conversation-level owner picker can move it to any Agent or project.
 */
export class NewConversationController {
    private createPromise: Promise<Session> | null = null;

    constructor(private readonly options: NewConversationControllerOptions) {}

    async create(ownerId?: string | null): Promise<Session> {
        if (this.createPromise) return this.createPromise;

        const pending = this.createInternal(ownerId);
        this.createPromise = pending;
        try {
            return await pending;
        } finally {
            this.createPromise = null;
        }
    }

    private async createInternal(ownerId?: string | null): Promise<Session> {
        const entities = await this.options.getEntities();
        const owner = resolveConversationOwner(entities, ownerId);
        const session = await this.options.gateway.createSession(
            undefined,
            undefined,
            undefined,
            owner.id,
            this.options.getApprovalMode?.(),
        );
        await this.options.activate(session, owner);
        return session;
    }

    private async updateOwner(
        sessionId: string,
        ownerId?: string | null,
    ): Promise<{ session: Session; owner: ConversationOwner }> {
        const entities = await this.options.getEntities();
        const owner = resolveConversationOwner(entities, ownerId);
        const session = await this.options.gateway.updateSessionOwner(sessionId, owner.id);
        return { session, owner };
    }

    async assignToOwner(sessionId: string, ownerId?: string | null): Promise<Session> {
        const { session, owner } = await this.updateOwner(sessionId, ownerId);
        await this.options.activate(session, owner);
        return session;
    }

    /** Bind the top-level action. A click creates the default conversation immediately. */
    bindNewConversationButton(button: HTMLButtonElement): () => void {
        const onClick = async (): Promise<void> => {
            if (button.disabled) return;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            try {
                await this.create();
            } catch (error) {
                this.options.reportError?.(error);
            } finally {
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
        };
        const listener = (): void => { void onClick(); };
        button.addEventListener('click', listener);
        return () => button.removeEventListener('click', listener);
    }

    /**
     * Bind the picker backing select. An empty value means OpenFlux Assistant;
     * project and Agent options use their entity ids.
     */
    bindOwnerSelect(
        select: HTMLSelectElement,
        getSessionId: () => string | null,
        getNavigationRevision: () => unknown = () => undefined,
        onAssigned?: (session: Session, ownerId: string | null) => void | Promise<void>,
    ): () => void {
        const listener = async (): Promise<void> => {
            const sessionId = getSessionId();
            if (!sessionId) return;

            const previous = select.dataset.committedValue || '';
            const ownerId = select.value || null;
            const navigationRevision = getNavigationRevision();
            select.disabled = true;
            select.setAttribute('aria-busy', 'true');
            try {
                const { session, owner } = await this.updateOwner(sessionId, ownerId);
                const stillCurrent = getSessionId() === sessionId
                    && getNavigationRevision() === navigationRevision;
                if (stillCurrent) {
                    await this.options.activate(session, owner);
                    select.dataset.committedValue = select.value;
                    await onAssigned?.(session, ownerId);
                } else {
                    await this.options.reconcile?.(session, owner);
                }
            } catch (error) {
                if (getSessionId() === sessionId) select.value = previous;
                this.options.reportError?.(error);
            } finally {
                select.disabled = false;
                select.removeAttribute('aria-busy');
            }
        };
        const onChange = (): void => { void listener(); };
        select.addEventListener('change', onChange);
        return () => select.removeEventListener('change', onChange);
    }
}

/** Populate the conversation-level owner select without mutating unrelated UI. */
export function renderConversationOwnerSelect(
    select: HTMLSelectElement,
    entities: readonly LocalEntityView[],
    currentOwnerId?: string | null,
    formatProjectLabel: (name: string) => string = name => name,
    formatAgentLabel: (name: string) => string = name => name,
): ConversationOwner[] {
    const owners = listConversationOwners(entities);
    const document = select.ownerDocument;
    select.replaceChildren(...owners.map((owner, index) => {
        const option = document.createElement('option');
        option.value = owner.kind === 'assistant' ? '' : owner.id;
        option.textContent = owner.kind === 'assistant'
            ? owner.name
            : owner.kind === 'project'
                ? formatProjectLabel(owner.name)
                : formatAgentLabel(owner.name);
        option.dataset.ownerId = owner.id;
        option.dataset.ownerKind = owner.kind;
        option.dataset.ownerName = owner.name;
        if (owner.icon) option.dataset.ownerIcon = owner.icon;
        if (owner.id === currentOwnerId || (!currentOwnerId && index === 0)) option.selected = true;
        return option;
    }));

    const current = owners.find(owner => owner.id === currentOwnerId);
    select.value = current && current.kind !== 'assistant' ? current.id : '';
    select.dataset.committedValue = select.value;
    return owners;
}

export interface ConversationOwnerPickerElements {
    root: HTMLElement;
    trigger: HTMLButtonElement;
    label: HTMLElement;
    select: HTMLSelectElement;
    menu: HTMLElement;
    search: HTMLInputElement;
    options: HTMLElement;
    empty: HTMLElement;
    createButton: HTMLButtonElement;
    defaultButton: HTMLButtonElement;
}

export interface ConversationOwnerPickerBinding {
    sync(): void;
    close(restoreFocus?: boolean): void;
    destroy(): void;
}

const OWNER_PROJECT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';

/**
 * Turn the hidden native select into a consistent searchable popup while
 * keeping the existing async owner-update controller as the source of truth.
 */
export function bindConversationOwnerPicker(
    elements: ConversationOwnerPickerElements,
    onCreate: () => void,
): ConversationOwnerPickerBinding {
    const { root, trigger, label, select, menu, search, options, empty, createButton, defaultButton } = elements;
    const document = root.ownerDocument;
    let open = false;

    const selectedOption = (): HTMLOptionElement | undefined =>
        [...select.options].find(option => option.value === select.value);

    const setCheck = (host: HTMLElement, checked: boolean): void => {
        const check = host.querySelector<HTMLElement>('.session-owner-option-check');
        if (check) check.textContent = checked ? '✓' : '';
        host.classList.toggle('is-selected', checked);
        host.setAttribute('aria-pressed', String(checked));
    };

    const ownerRows = (): HTMLButtonElement[] =>
        [...options.querySelectorAll<HTMLButtonElement>('.session-owner-option')];

    const render = (): void => {
        const term = search.value.trim().toLocaleLowerCase();
        const choices = [...select.options].filter(option => {
            if (option.dataset.ownerKind === 'assistant') return false;
            const name = option.dataset.ownerName || option.textContent || '';
            return !term || name.toLocaleLowerCase().includes(term);
        });
        const fragment = document.createDocumentFragment();

        for (const option of choices) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'session-owner-option';
            button.dataset.ownerValue = option.value;
            button.title = option.dataset.ownerName || option.textContent || '';
            button.disabled = select.disabled;

            const icon = document.createElement('span');
            icon.className = 'session-owner-option-icon';
            icon.innerHTML = option.dataset.ownerKind === 'project'
                ? OWNER_PROJECT_ICON
                : renderAgentIcon(option.dataset.ownerIcon || DEFAULT_AGENT_ICON, 18);
            const copy = document.createElement('span');
            copy.className = 'session-owner-option-label';
            copy.textContent = option.dataset.ownerName || option.textContent || '';
            const check = document.createElement('span');
            check.className = 'session-owner-option-check';
            check.setAttribute('aria-hidden', 'true');
            button.append(icon, copy, check);
            setCheck(button, option.value === select.value);
            fragment.append(button);
        }

        options.replaceChildren(fragment);
        empty.classList.toggle('hidden', choices.length > 0);
        createButton.disabled = select.disabled;
        defaultButton.disabled = select.disabled;
        setCheck(defaultButton, select.value === '');
    };

    const close = (restoreFocus = false): void => {
        open = false;
        menu.classList.add('hidden');
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
    };

    const setOpen = (next: boolean): void => {
        if (trigger.disabled || root.classList.contains('hidden')) next = false;
        open = next;
        menu.classList.toggle('hidden', !open);
        trigger.setAttribute('aria-expanded', String(open));
        if (!open) return;
        search.value = '';
        render();
        queueMicrotask(() => {
            if (!open) return;
            search.focus();
            options.querySelector<HTMLElement>('.session-owner-option.is-selected')?.scrollIntoView?.({ block: 'nearest' });
        });
    };

    const sync = (): void => {
        const current = selectedOption();
        label.textContent = current?.dataset.ownerName || current?.textContent || '';
        trigger.disabled = select.disabled;
        if (trigger.disabled) close();
        render();
    };

    const choose = (value: string): void => {
        if (select.disabled) return;
        if (select.value === value) {
            close(true);
            return;
        }
        select.value = value;
        sync();
        close();
        const EventConstructor = document.defaultView?.Event;
        if (EventConstructor) select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    };

    const focusRelative = (direction: number): void => {
        const controls = [
            ...ownerRows(),
            createButton,
            defaultButton,
        ].filter(control => !control.disabled);
        if (!controls.length) return;
        const current = controls.indexOf(document.activeElement as HTMLButtonElement);
        const next = current < 0
            ? (direction > 0 ? 0 : controls.length - 1)
            : (current + direction + controls.length) % controls.length;
        controls[next]?.focus();
    };

    const onTriggerClick = (event: Event): void => {
        event.stopPropagation();
        setOpen(!open);
    };
    const onTriggerKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setOpen(true);
    };
    const onSearchInput = (): void => render();
    const onSearchKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusRelative(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Enter') {
            const rows = ownerRows();
            if (rows.length === 1) {
                event.preventDefault();
                choose(rows[0]!.dataset.ownerValue || '');
            }
        }
    };
    const onOptionsClick = (event: Event): void => {
        const target = event.target as Element | null;
        const button = target?.closest<HTMLButtonElement>('.session-owner-option');
        if (button) choose(button.dataset.ownerValue || '');
    };
    const onMenuKeydown = (event: KeyboardEvent): void => {
        if (event.target === search) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            focusRelative(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const controls = [...ownerRows(), createButton, defaultButton].filter(control => !control.disabled);
            controls[event.key === 'Home' ? 0 : controls.length - 1]?.focus();
        }
    };
    const onDocumentPointerDown = (event: Event): void => {
        const target = event.target;
        const NodeConstructor = document.defaultView?.Node;
        if (NodeConstructor && target instanceof NodeConstructor && !root.contains(target)) close();
    };
    const onCreateClick = (): void => {
        close();
        onCreate();
    };
    const onDefaultClick = (): void => choose('');
    const onSelectChange = (): void => sync();
    const onWindowResize = (): void => close();

    trigger.addEventListener('click', onTriggerClick);
    trigger.addEventListener('keydown', onTriggerKeydown);
    search.addEventListener('input', onSearchInput);
    search.addEventListener('keydown', onSearchKeydown);
    options.addEventListener('click', onOptionsClick);
    menu.addEventListener('keydown', onMenuKeydown);
    createButton.addEventListener('click', onCreateClick);
    defaultButton.addEventListener('click', onDefaultClick);
    select.addEventListener('change', onSelectChange);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.defaultView?.addEventListener('resize', onWindowResize);

    const MutationObserverConstructor = document.defaultView?.MutationObserver;
    const observer = MutationObserverConstructor ? new MutationObserverConstructor(sync) : undefined;
    observer?.observe(select, { attributes: true, childList: true, subtree: true });
    sync();

    return {
        sync,
        close,
        destroy: () => {
            observer?.disconnect();
            trigger.removeEventListener('click', onTriggerClick);
            trigger.removeEventListener('keydown', onTriggerKeydown);
            search.removeEventListener('input', onSearchInput);
            search.removeEventListener('keydown', onSearchKeydown);
            options.removeEventListener('click', onOptionsClick);
            menu.removeEventListener('keydown', onMenuKeydown);
            createButton.removeEventListener('click', onCreateClick);
            defaultButton.removeEventListener('click', onDefaultClick);
            select.removeEventListener('change', onSelectChange);
            document.removeEventListener('pointerdown', onDocumentPointerDown, true);
            document.defaultView?.removeEventListener('resize', onWindowResize);
        },
    };
}
