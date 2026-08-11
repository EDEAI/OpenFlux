const USER_MESSAGE_SELECTOR = ':scope > .message.user[data-message-id]';

export function summarizeUserMessage(
    text: string,
    maxChars = 72,
    fallback = '附件消息',
): string {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (!normalized) return fallback;

    const characters = Array.from(normalized);
    if (characters.length <= maxChars) return normalized;
    return `${characters.slice(0, Math.max(1, maxChars)).join('')}…`;
}

export function userMessageIndexRatio(index: number, total: number): number {
    if (total <= 0) return 0;
    if (total === 1) return 0.5;
    return Math.min(1, Math.max(0, index / (total - 1)));
}

export function findCurrentUserMessageIndex(
    messageTops: readonly number[],
    viewportAnchor: number,
): number {
    if (messageTops.length === 0) return -1;

    let current = 0;
    for (let index = 0; index < messageTops.length; index += 1) {
        if (messageTops[index] > viewportAnchor) break;
        current = index;
    }
    return current;
}

export function distributeMarkerPositions(
    ratios: readonly number[],
    availableHeight: number,
    requestedGap = 10,
): number[] {
    if (ratios.length === 0 || availableHeight <= 0) return [];
    if (ratios.length === 1) return [availableHeight / 2];

    const gap = Math.min(requestedGap, availableHeight / (ratios.length - 1));
    const positions = ratios.map(ratio => Math.min(1, Math.max(0, ratio)) * availableHeight);

    for (let index = 1; index < positions.length; index += 1) {
        positions[index] = Math.max(positions[index], positions[index - 1] + gap);
    }
    positions[positions.length - 1] = Math.min(availableHeight, positions[positions.length - 1]);
    for (let index = positions.length - 2; index >= 0; index -= 1) {
        positions[index] = Math.min(positions[index], positions[index + 1] - gap);
    }

    if (positions[0] < 0) {
        const shift = -positions[0];
        for (let index = 0; index < positions.length; index += 1) positions[index] += shift;
    }
    return positions;
}

export interface UserMessageNavigatorOptions {
    previewMaxChars?: number;
    minimumMessages?: number;
    scrollBehavior?: ScrollBehavior;
    onNavigate?: () => void;
}

export class UserMessageNavigator {
    private readonly list: HTMLDivElement;
    private readonly preview: HTMLDivElement;
    private readonly mutationObserver: MutationObserver;
    private readonly resizeObserver: ResizeObserver | null;
    private readonly previewMaxChars: number;
    private readonly minimumMessages: number;
    private readonly scrollBehavior: ScrollBehavior;
    private readonly onNavigate?: () => void;
    private messageElements: HTMLElement[] = [];
    private layoutFrameId: number | null = null;
    private activeIndex = -1;
    private destroyed = false;

    constructor(
        private readonly messagesContainer: HTMLElement,
        private readonly rail: HTMLElement,
        options: UserMessageNavigatorOptions = {},
    ) {
        this.previewMaxChars = options.previewMaxChars ?? 72;
        this.minimumMessages = options.minimumMessages ?? 2;
        this.scrollBehavior = options.scrollBehavior ?? 'smooth';
        this.onNavigate = options.onNavigate;

        this.list = document.createElement('div');
        this.list.className = 'user-message-rail-list';
        this.rail.replaceChildren(this.list);
        this.rail.setAttribute('aria-label', '对话快速导航');

        this.preview = document.createElement('div');
        this.preview.className = 'user-message-rail-preview';
        this.preview.setAttribute('role', 'tooltip');
        document.body.appendChild(this.preview);

        this.rail.addEventListener('click', this.handleClick);
        this.rail.addEventListener('pointerover', this.handlePointerOver);
        this.rail.addEventListener('pointerout', this.handlePointerOut);
        this.rail.addEventListener('focusin', this.handleFocusIn);
        this.rail.addEventListener('focusout', this.handleFocusOut);
        this.rail.addEventListener('wheel', this.handleWheel, { passive: false });
        this.messagesContainer.addEventListener('scroll', this.handleScroll, { passive: true });
        window.addEventListener('resize', this.handleWindowResize);

        this.mutationObserver = new MutationObserver(() => this.refresh());
        this.mutationObserver.observe(this.messagesContainer, {
            childList: true,
            attributes: true,
            attributeFilter: ['class'],
        });

        this.resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => this.scheduleLayout());

        this.refresh();
    }

    refresh(): void {
        if (this.destroyed) return;
        this.hidePreview();

        this.messageElements = Array.from(
            this.messagesContainer.querySelectorAll<HTMLElement>(USER_MESSAGE_SELECTOR),
        );

        const fragment = document.createDocumentFragment();
        this.messageElements.forEach((message, index) => {
            const messageId = message.dataset.messageId || `user-message-${index}`;
            const text = message.querySelector<HTMLElement>('.message-bubble .markdown-body')?.textContent
                || Array.from(message.querySelectorAll<HTMLElement>('.msg-attach-name'))
                    .map(element => element.textContent || '')
                    .join(' ');
            const summary = summarizeUserMessage(text || '', this.previewMaxChars);

            const marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'user-message-rail-marker';
            marker.dataset.messageId = messageId;
            marker.dataset.messageIndex = String(index);
            marker.dataset.summary = summary;
            marker.setAttribute('aria-label', summary);
            marker.innerHTML = '<span class="user-message-rail-dot" aria-hidden="true"></span>';
            fragment.appendChild(marker);
        });
        this.list.replaceChildren(fragment);
        // Markers are recreated during history/session DOM rebuilds, so force
        // the active state to be applied to the new elements on the next frame.
        this.activeIndex = -1;

        const shouldHide = this.messageElements.length < this.minimumMessages
            || this.messagesContainer.classList.contains('hidden')
            || this.messagesContainer.classList.contains('share-select-mode');
        this.rail.classList.toggle('hidden', shouldHide);

        this.resizeObserver?.disconnect();
        this.resizeObserver?.observe(this.messagesContainer);
        Array.from(this.messagesContainer.children).forEach(child => {
            if (child instanceof HTMLElement) this.resizeObserver?.observe(child);
        });

        this.scheduleLayout();
    }

    updateCurrent(viewportAnchor?: number): number {
        if (this.destroyed || this.messageElements.length === 0) {
            this.activeIndex = -1;
            return -1;
        }

        const tops = this.messageElements.map(message => this.getMessageTop(message));
        const bottomDistance = this.messagesContainer.scrollHeight
            - this.messagesContainer.scrollTop
            - this.messagesContainer.clientHeight;
        const isAtBottom = viewportAnchor === undefined && bottomDistance <= 12;
        const anchor = viewportAnchor
            ?? this.messagesContainer.scrollTop + this.messagesContainer.clientHeight * 0.28;
        const nextActiveIndex = isAtBottom
            ? this.messageElements.length - 1
            : findCurrentUserMessageIndex(tops, anchor);

        if (nextActiveIndex !== this.activeIndex) {
            const markers = this.list.querySelectorAll<HTMLElement>('.user-message-rail-marker');
            markers.forEach((marker, index) => {
                const active = index === nextActiveIndex;
                marker.classList.toggle('is-current', active);
                if (active) marker.setAttribute('aria-current', 'location');
                else marker.removeAttribute('aria-current');
            });
            this.activeIndex = nextActiveIndex;
        }
        return nextActiveIndex;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.mutationObserver.disconnect();
        this.resizeObserver?.disconnect();
        if (this.layoutFrameId !== null) cancelAnimationFrame(this.layoutFrameId);
        this.rail.removeEventListener('click', this.handleClick);
        this.rail.removeEventListener('pointerover', this.handlePointerOver);
        this.rail.removeEventListener('pointerout', this.handlePointerOut);
        this.rail.removeEventListener('focusin', this.handleFocusIn);
        this.rail.removeEventListener('focusout', this.handleFocusOut);
        this.rail.removeEventListener('wheel', this.handleWheel);
        this.messagesContainer.removeEventListener('scroll', this.handleScroll);
        window.removeEventListener('resize', this.handleWindowResize);
        this.preview.remove();
        this.rail.replaceChildren();
    }

    private getMessageTop(message: HTMLElement): number {
        const containerRect = this.messagesContainer.getBoundingClientRect();
        const messageRect = message.getBoundingClientRect();
        return messageRect.top - containerRect.top + this.messagesContainer.scrollTop;
    }

    private scheduleLayout(): void {
        if (this.destroyed || this.layoutFrameId !== null) return;
        this.layoutFrameId = requestAnimationFrame(() => {
            this.layoutFrameId = null;
            this.layoutMarkers();
            this.updateCurrent();
        });
    }

    private layoutMarkers(): void {
        const markers = Array.from(
            this.list.querySelectorAll<HTMLElement>('.user-message-rail-marker'),
        );
        if (markers.length === 0 || this.rail.classList.contains('hidden')) return;

        const availableHeight = Math.max(0, this.list.clientHeight - 8);
        // Keep the OpenFlux turn dots in a compact, centered stack. A stable
        // step makes the neighboring hover scale legible and avoids reshuffling
        // every marker while the current assistant response is still growing.
        const stackHeight = Math.min(
            availableHeight,
            Math.max(0, (markers.length - 1) * 14),
        );
        const stackTop = (availableHeight - stackHeight) / 2;
        const ratios = markers.map((_, index) => userMessageIndexRatio(index, markers.length));
        const positions = distributeMarkerPositions(ratios, stackHeight, 10);
        markers.forEach((marker, index) => {
            marker.style.top = `${4 + stackTop + (positions[index] ?? 0)}px`;
        });
    }

    private getMarkerFromTarget(target: EventTarget | null): HTMLButtonElement | null {
        return target instanceof Element
            ? target.closest<HTMLButtonElement>('.user-message-rail-marker')
            : null;
    }

    private showPreview(marker: HTMLButtonElement): void {
        const summary = marker.dataset.summary || marker.getAttribute('aria-label') || '';
        this.preview.textContent = summary;
        this.preview.classList.add('is-visible');

        const markerRect = marker.getBoundingClientRect();
        const containerRect = this.messagesContainer.getBoundingClientRect();
        const previewRect = this.preview.getBoundingClientRect();
        const maxTop = Math.max(containerRect.top + 8, containerRect.bottom - previewRect.height - 8);
        const top = Math.min(maxTop, Math.max(
            containerRect.top + 8,
            markerRect.top + markerRect.height / 2 - previewRect.height / 2,
        ));
        this.preview.style.left = `${markerRect.right + 10}px`;
        this.preview.style.top = `${top}px`;
    }

    private hidePreview(): void {
        this.preview.classList.remove('is-visible');
    }

    private readonly handleClick = (event: Event): void => {
        const marker = this.getMarkerFromTarget(event.target);
        if (!marker) return;

        const messageId = marker.dataset.messageId;
        const target = this.messageElements.find(message => message.dataset.messageId === messageId);
        if (!target) return;

        this.onNavigate?.();
        const top = Math.max(0, this.getMessageTop(target) - 16);
        this.messagesContainer.scrollTo({ top, behavior: this.scrollBehavior });
        this.updateCurrent(top + 1);
        this.hidePreview();

        target.classList.remove('conversation-index-target');
        requestAnimationFrame(() => target.classList.add('conversation-index-target'));
        window.setTimeout(() => target.classList.remove('conversation-index-target'), 900);
    };

    private readonly handleScroll = (): void => this.scheduleLayout();
    private readonly handleWindowResize = (): void => this.scheduleLayout();

    private readonly handleWheel = (event: WheelEvent): void => {
        event.preventDefault();
        this.messagesContainer.scrollBy({ top: event.deltaY, left: 0, behavior: 'auto' });
    };

    private readonly handlePointerOver = (event: PointerEvent): void => {
        const marker = this.getMarkerFromTarget(event.target);
        const related = event.relatedTarget;
        if (!marker || (related instanceof Node && marker.contains(related))) return;
        this.showPreview(marker);
    };

    private readonly handlePointerOut = (event: PointerEvent): void => {
        const marker = this.getMarkerFromTarget(event.target);
        const related = event.relatedTarget;
        if (!marker || (related instanceof Node && marker.contains(related))) return;
        this.hidePreview();
    };

    private readonly handleFocusIn = (event: FocusEvent): void => {
        const marker = this.getMarkerFromTarget(event.target);
        if (marker) this.showPreview(marker);
    };

    private readonly handleFocusOut = (event: FocusEvent): void => {
        const marker = this.getMarkerFromTarget(event.target);
        const related = event.relatedTarget;
        if (!marker || (related instanceof Node && marker.contains(related))) return;
        this.hidePreview();
    };
}
