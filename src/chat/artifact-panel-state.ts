/**
 * Apply the artifact panel's expanded state without leaving an inline width
 * behind. Inline widths are written by the resize handle and otherwise win
 * over `.artifacts-panel.collapsed { width: 0 }`.
 */
export function setArtifactPanelExpanded(
    panel: HTMLElement,
    expanded: boolean,
    savedWidth?: string | null,
): void {
    panel.classList.toggle('collapsed', !expanded);

    if (!expanded) {
        panel.style.removeProperty('width');
        return;
    }

    const normalizedWidth = savedWidth?.trim();
    if (normalizedWidth && /^\d+(?:\.\d+)?$/.test(normalizedWidth)) {
        panel.style.width = `${normalizedWidth}px`;
    } else {
        panel.style.removeProperty('width');
    }
}
