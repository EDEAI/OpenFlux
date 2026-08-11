export const AGENT_DISCLOSURE_ACTION_SELECTOR = '.agent-card-actions, .agent-menu-dropdown, button';

/** Keep the Agent header and its sibling session list in one disclosure state. */
export function applyAgentSessionDisclosure(
    card: HTMLElement,
    sessionList: HTMLElement,
    collapsed: boolean,
): void {
    card.classList.toggle('sessions-collapsed', collapsed);
    card.setAttribute('aria-expanded', String(!collapsed));
    sessionList.classList.toggle('is-collapsed', collapsed);
    sessionList.setAttribute('aria-hidden', String(collapsed));
}

/** Nested action buttons and menus must not toggle the Agent disclosure. */
export function isAgentDisclosureActionTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(AGENT_DISCLOSURE_ACTION_SELECTOR));
}
