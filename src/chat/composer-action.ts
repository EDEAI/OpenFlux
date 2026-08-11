export type ComposerPrimaryAction = 'stop' | 'send' | 'queue' | 'disabled';

export interface ComposerActionState {
    running: boolean;
    hasPayload: boolean;
    sendBlocked?: boolean;
}

export interface ComposerKeydownState {
    key: string;
    shiftKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
}

/**
 * Resolve the one primary composer button without UI-specific state.
 * Stopping an existing run remains available even when new sends are blocked.
 */
export function resolveComposerPrimaryAction(state: ComposerActionState): ComposerPrimaryAction {
    if (state.running && !state.hasPayload) return 'stop';
    if (!state.hasPayload || state.sendBlocked) return 'disabled';
    return state.running ? 'queue' : 'send';
}

/** Enter submits; Shift+Enter inserts a newline. IME confirmation must never submit. */
export function shouldSubmitComposerOnKeydown(event: ComposerKeydownState): boolean {
    return event.key === 'Enter'
        && !event.shiftKey
        && !event.isComposing
        && event.keyCode !== 229;
}
