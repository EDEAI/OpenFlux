/**
 * Condense a tool return into something a later investigation can read.
 *
 * Tool arguments were already persisted in full while returns were dropped
 * entirely, so a failed turn left nothing behind but the single line the UI had
 * shown. That line is written for a person watching the run, not for someone
 * reconstructing it afterwards: a plain ENAMETOOLONG on the PowerShell command
 * line reached the transcript as "no readable previews for the active model",
 * and the real cause had to be recovered by re-running the tool by hand.
 *
 * This is diagnostic material, not display text. Failures keep their whole
 * envelope and a deep look into `data`, where the reason usually sits;
 * successes keep only enough to identify what came back.
 */

/** Beyond this a log entry stops being cheap to keep next to the transcript. */
const MAX_LOG_SUMMARY_CHARS = 4_000;

/** Arrays are sampled rather than kept, since a long one says little more. */
const MAX_ARRAY_ENTRIES = 8;

function elide(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}…(+${value.length - limit} chars)`;
}

/**
 * Base64 blobs are worth nothing here and would dwarf the transcript they are
 * filed beside, so they are counted rather than copied. Checked by shape rather
 * than by field name because tools nest rendered decks and images freely.
 */
function isOpaqueBlob(value: string): boolean {
    return value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function bounded(value: unknown, depth: number, maxString: number): unknown {
    if (typeof value === 'string') {
        return isOpaqueBlob(value) ? `<${value.length} chars omitted>` : elide(value, maxString);
    }
    if (typeof value !== 'object' || value === null) return value;
    if (Array.isArray(value)) {
        if (depth <= 0) return `<${value.length} entries omitted>`;
        const head = value.slice(0, MAX_ARRAY_ENTRIES).map(item => bounded(item, depth - 1, maxString));
        return value.length > MAX_ARRAY_ENTRIES
            ? [...head, `<${value.length - MAX_ARRAY_ENTRIES} more entries omitted>`]
            : head;
    }
    if (depth <= 0) return '<omitted>';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        // Images arrive as base64 and are the single largest thing a tool returns.
        if (key === 'images' && Array.isArray(item)) {
            out.images = `<${item.length} image(s) omitted>`;
            continue;
        }
        out[key] = bounded(item, depth - 1, maxString);
    }
    return out;
}

function envelope(result: Record<string, unknown>, depth: number, maxString: number): string {
    const failed = result.success === false || typeof result.error === 'string';
    const summary: Record<string, unknown> = {};
    if (typeof result.success === 'boolean') summary.success = result.success;
    for (const key of ['code', 'error', 'cause', 'retryable', 'route', 'summary'] as const) {
        if (result[key] !== undefined) summary[key] = bounded(result[key], 3, maxString);
    }
    // Whether a tool returned any images is itself a finding: the preview failure
    // that prompted all this turned on how many came back, not on what was in them.
    if (Array.isArray(result.images)) summary.images = `<${result.images.length} image(s) omitted>`;
    if (result.data !== undefined) {
        // A failure's reason is usually nested; a success needs only its shape.
        summary.data = bounded(result.data, failed ? depth : Math.max(1, depth - 2), maxString);
    }
    return JSON.stringify(summary);
}

export function summarizeToolResultForLog(
    result: unknown,
    maxChars = MAX_LOG_SUMMARY_CHARS,
): string | undefined {
    if (result === undefined || result === null) return undefined;
    if (typeof result !== 'object') return elide(String(result), maxChars);
    const record = result as Record<string, unknown>;
    // Progressively coarser passes. The first that fits wins, so a small result
    // is written as it stands and only a large one loses detail.
    for (const [depth, maxString] of [[5, 1_000], [4, 400], [2, 200], [1, 120]] as const) {
        const text = envelope(record, depth, maxString);
        if (text.length <= maxChars) return text;
    }
    // Nothing survived the passes, so keep the fields a diagnosis cannot do
    // without and say plainly that the rest was dropped.
    return elide(JSON.stringify({
        success: record.success === true,
        code: record.code,
        error: typeof record.error === 'string' ? elide(record.error, 800) : undefined,
        truncated: true,
    }), maxChars);
}
