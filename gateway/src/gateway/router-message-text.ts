/**
 * Normalizes plain-text messages received from external platforms.
 * Fenced code blocks are preserved verbatim while surrounding chat text is
 * stripped of transport-only indentation and excessive blank lines.
 */
export function normalizeRouterMessageText(value: string): string {
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    const normalized: string[] = [];
    let inFence = false;
    let lastWasBlank = false;

    for (const rawLine of lines) {
        const fence = /^\s*```/.test(rawLine);
        const line = inFence || fence ? rawLine.replace(/[ \t]+$/g, '') : rawLine.trim();
        const blank = line.length === 0;
        if (!blank || !lastWasBlank) normalized.push(line);
        lastWasBlank = blank;
        if (fence) inFence = !inFence;
    }

    return normalized.join('\n').trim();
}
