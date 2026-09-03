import type { LLMConfig, LLMMessage, LLMToolDefinition } from '../llm/provider';

/**
 * Model context metadata used by the local preflight guard.  The values are
 * total request windows (input + requested output), not attachment limits.
 */
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: RegExp; tokens: number }> = [
    { pattern: /^kimi-k3(?:$|-)/i, tokens: 1_048_576 },
    { pattern: /^kimi-k2\.(?:6|7)(?:$|-)/i, tokens: 262_144 },
];

const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;
const MIN_OUTPUT_RESERVE_TOKENS = 2_048;
const SAFETY_MARGIN_RATIO = 0.12;
const PROACTIVE_COMPACTION_RATIO = 0.78;
const IMAGE_TOKEN_RESERVE = 4_096;

export interface ContextTokenBreakdown {
    messages: number;
    tools: number;
    images: number;
}

export interface ContextBudgetReport {
    contextWindowTokens: number;
    reservedOutputTokens: number;
    safetyTokens: number;
    inputBudgetTokens: number;
    estimatedInputTokens: number;
    utilization: number;
    overBudget: boolean;
    shouldCompact: boolean;
    breakdown: ContextTokenBreakdown;
}

interface CachedMessageEstimate {
    content: string;
    reasoningContent?: string;
    contentParts?: LLMMessage['contentParts'];
    toolCalls?: LLMMessage['toolCalls'];
    estimate: { text: number; images: number };
}

export function resolveContextWindowTokens(config: LLMConfig): number {
    if (config.contextWindowTokens && Number.isFinite(config.contextWindowTokens)) {
        return Math.max(8_192, Math.trunc(config.contextWindowTokens));
    }
    const model = config.model.trim();
    return MODEL_CONTEXT_WINDOWS.find(entry => entry.pattern.test(model))?.tokens
        ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** Raw recent-turn allowance before semantic compaction or memory retrieval. */
export function recommendedHistoryTokenBudget(config: LLMConfig): number {
    const window = resolveContextWindowTokens(config);
    return Math.min(131_072, Math.max(8_000, Math.floor(window * 0.15)));
}

/** Recover an authoritative total-window value exposed by compatible APIs. */
export function extractContextWindowFromError(message: string): number | undefined {
    const patterns = [
        /token limit\s*[:=]\s*([\d,]+)/i,
        /maximum context(?: length| window)?(?: is| of)?\s*([\d,]+)/i,
        /context(?: length| window)?\s*(?:is|=|:)\s*([\d,]+)\s*tokens?/i,
        /limit(?: is| of|:)\s*([\d,]+)\s*tokens?/i,
    ];
    for (const pattern of patterns) {
        const matched = message.match(pattern)?.[1]?.replace(/,/g, '');
        const parsed = matched ? Number.parseInt(matched, 10) : NaN;
        if (Number.isFinite(parsed) && parsed >= 8_192) return parsed;
    }
    return undefined;
}

/**
 * A deliberately conservative, allocation-light estimator.  Exact provider
 * tokenizers remain the final authority, but this is cheap enough to run on
 * every append and errs high for CJK-heavy content.
 */
export function estimateTextTokens(text: string): number {
    if (!text) return 0;
    let ascii = 0;
    let cjk = 0;
    let other = 0;
    for (const char of text) {
        const code = char.codePointAt(0) || 0;
        if (code <= 0x7f) ascii++;
        else if (
            (code >= 0x3400 && code <= 0x9fff)
            || (code >= 0x3040 && code <= 0x30ff)
            || (code >= 0xac00 && code <= 0xd7af)
        ) cjk++;
        else other++;
    }
    return Math.ceil(ascii / 3.5 + cjk * 1.1 + other / 2);
}

export function estimateMessageTokens(message: LLMMessage): { text: number; images: number } {
    // Providers serialize user contentParts instead of the parallel content
    // string, so count one representation rather than double-counting it.
    let text = (message.contentParts?.length ? 0 : estimateTextTokens(message.content)) + 5;
    let images = 0;
    if (message.reasoningContent) text += estimateTextTokens(message.reasoningContent);
    if (message.toolCalls?.length) text += estimateTextTokens(JSON.stringify(message.toolCalls));
    for (const part of message.contentParts || []) {
        if (part.type === 'text') text += estimateTextTokens(part.text);
        else images += IMAGE_TOKEN_RESERVE;
    }
    return { text, images };
}

export function estimateToolDefinitionTokens(tools: LLMToolDefinition[]): number {
    if (tools.length === 0) return 0;
    return estimateTextTokens(JSON.stringify(tools)) + tools.length * 8;
}

export function inspectContextBudget(
    messages: LLMMessage[],
    tools: LLMToolDefinition[],
    config: LLMConfig,
): ContextBudgetReport {
    const contextWindowTokens = resolveContextWindowTokens(config);
    const configuredOutput = config.maxTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    const reservedOutputTokens = Math.max(
        MIN_OUTPUT_RESERVE_TOKENS,
        Math.min(Math.trunc(configuredOutput), Math.floor(contextWindowTokens * 0.25)),
    );
    const safetyTokens = Math.max(1_024, Math.floor(contextWindowTokens * SAFETY_MARGIN_RATIO));
    const inputBudgetTokens = Math.max(
        4_096,
        contextWindowTokens - reservedOutputTokens - safetyTokens,
    );

    let messageTokens = 0;
    let imageTokens = 0;
    for (const message of messages) {
        const estimate = estimateMessageTokens(message);
        messageTokens += estimate.text;
        imageTokens += estimate.images;
    }
    const toolTokens = estimateToolDefinitionTokens(tools);
    const estimatedInputTokens = messageTokens + imageTokens + toolTokens;
    const utilization = estimatedInputTokens / inputBudgetTokens;

    return {
        contextWindowTokens,
        reservedOutputTokens,
        safetyTokens,
        inputBudgetTokens,
        estimatedInputTokens,
        utilization,
        overBudget: estimatedInputTokens > inputBudgetTokens,
        shouldCompact: utilization >= PROACTIVE_COMPACTION_RATIO,
        breakdown: {
            messages: messageTokens,
            tools: toolTokens,
            images: imageTokens,
        },
    };
}

/**
 * Per-turn estimator cache. Agent messages are append-heavy; unchanged large
 * strings therefore tokenize only once while still allowing in-place
 * compaction to invalidate the affected cache entry.
 */
export class ContextBudgetLedger {
    private readonly messageCache = new WeakMap<LLMMessage, CachedMessageEstimate>();
    private toolsRef?: LLMToolDefinition[];
    private toolTokens = 0;
    private cacheHits = 0;
    private cacheMisses = 0;

    inspect(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        config: LLMConfig,
    ): ContextBudgetReport {
        const contextWindowTokens = resolveContextWindowTokens(config);
        const configuredOutput = config.maxTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
        const reservedOutputTokens = Math.max(
            MIN_OUTPUT_RESERVE_TOKENS,
            Math.min(Math.trunc(configuredOutput), Math.floor(contextWindowTokens * 0.25)),
        );
        const safetyTokens = Math.max(1_024, Math.floor(contextWindowTokens * SAFETY_MARGIN_RATIO));
        const inputBudgetTokens = Math.max(
            4_096,
            contextWindowTokens - reservedOutputTokens - safetyTokens,
        );

        let messageTokens = 0;
        let imageTokens = 0;
        for (const message of messages) {
            const cached = this.messageCache.get(message);
            const valid = cached
                && cached.content === message.content
                && cached.reasoningContent === message.reasoningContent
                && cached.contentParts === message.contentParts
                && cached.toolCalls === message.toolCalls;
            const estimate = valid ? cached.estimate : estimateMessageTokens(message);
            if (valid) this.cacheHits++;
            else {
                this.cacheMisses++;
                this.messageCache.set(message, {
                    content: message.content,
                    reasoningContent: message.reasoningContent,
                    contentParts: message.contentParts,
                    toolCalls: message.toolCalls,
                    estimate,
                });
            }
            messageTokens += estimate.text;
            imageTokens += estimate.images;
        }
        if (this.toolsRef !== tools) {
            this.toolsRef = tools;
            this.toolTokens = estimateToolDefinitionTokens(tools);
        }
        const estimatedInputTokens = messageTokens + imageTokens + this.toolTokens;
        const utilization = estimatedInputTokens / inputBudgetTokens;
        return {
            contextWindowTokens,
            reservedOutputTokens,
            safetyTokens,
            inputBudgetTokens,
            estimatedInputTokens,
            utilization,
            overBudget: estimatedInputTokens > inputBudgetTokens,
            shouldCompact: utilization >= PROACTIVE_COMPACTION_RATIO,
            breakdown: { messages: messageTokens, tools: this.toolTokens, images: imageTokens },
        };
    }

    getCacheStats(): { hits: number; misses: number } {
        return { hits: this.cacheHits, misses: this.cacheMisses };
    }
}

export function selectProactiveCompressionLevel(report: ContextBudgetReport): 1 | 2 | 3 {
    if (report.utilization >= 1) return 3;
    if (report.utilization >= 0.9) return 2;
    return 1;
}

function elideMiddle(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 40) return value.slice(0, Math.max(0, maxChars - 1)) + '…';
    const marker = '\n…[middle omitted]…\n';
    const remaining = Math.max(2, maxChars - marker.length);
    const head = Math.ceil(remaining * 0.6);
    return value.slice(0, head) + marker + value.slice(-(remaining - head));
}

const PRIORITY_RESULT_KEYS = [
    'success', 'code', 'error', 'route', 'retryable', 'summary', 'completion',
    'file', 'filePath', 'path', 'sheet', 'sheets', 'total', 'totalRows',
    'returnedRows', 'startRow', 'endRow', 'hasMore', 'nextCursor',
    'nextStartRow', 'artifactId', 'artifact_id', 'files', 'coverage', 'data',
];

function boundedValue(value: unknown, depth = 0): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return elideMiddle(value, depth === 0 ? 1_000 : 500);
    if (depth >= 4) return '[nested value omitted]';
    if (Array.isArray(value)) {
        const limited = value.slice(0, 12).map(item => boundedValue(item, depth + 1));
        if (value.length > limited.length) limited.push(`[${value.length - limited.length} more items omitted]`);
        return limited;
    }
    if (typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const keys = Object.keys(source).sort((a, b) => {
            const ai = PRIORITY_RESULT_KEYS.indexOf(a);
            const bi = PRIORITY_RESULT_KEYS.indexOf(b);
            if (ai === -1 && bi === -1) return a.localeCompare(b);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
        const result: Record<string, unknown> = {};
        for (const key of keys.slice(0, 28)) result[key] = boundedValue(source[key], depth + 1);
        if (keys.length > 28) result._omittedKeys = keys.length - 28;
        return result;
    }
    return String(value);
}

/** Always returns valid JSON, even when a tool produced an oversized result. */
export function serializeToolResultForContext(result: unknown, maxChars = 8_000): string {
    const full = JSON.stringify(result, null, 2);
    if (full.length <= maxChars) return full;

    const compact = boundedValue(result) as Record<string, unknown>;
    let envelope: Record<string, unknown> = {
        ...compact,
        truncatedForContext: true,
        originalChars: full.length,
        note: 'The complete result remains in the runtime result ledger; request a narrower page or query for more evidence.',
    };
    let serialized = JSON.stringify(envelope, null, 2);
    if (serialized.length <= maxChars) return serialized;

    envelope = {
        success: typeof compact?.success === 'boolean' ? compact.success : true,
        code: compact?.code,
        error: typeof compact?.error === 'string' ? elideMiddle(compact.error, 800) : compact?.error,
        summary: typeof compact?.summary === 'string' ? elideMiddle(compact.summary, 1_200) : compact?.summary,
        data: boundedValue(compact?.data, 3),
        truncatedForContext: true,
        originalChars: full.length,
    };
    serialized = JSON.stringify(envelope);
    if (serialized.length <= maxChars) return serialized;

    // `jsonResult` nests a tool's own payload under `data`, so a summary the tool
    // wrote about itself lives there rather than at the top level. Looking only at the
    // top level here would discard the one field authored to survive this tier and
    // leave the caller with the words "Oversized tool result".
    const nested = compact?.data && typeof compact.data === 'object' && !Array.isArray(compact.data)
        ? (compact.data as Record<string, unknown>)
        : undefined;
    const summary = compact?.summary || nested?.summary || compact?.error || 'Oversized tool result';
    return JSON.stringify({
        success: typeof compact?.success === 'boolean' ? compact.success : true,
        code: compact?.code,
        summary: elideMiddle(String(summary), Math.max(80, maxChars - 180)),
        truncatedForContext: true,
        originalChars: full.length,
    });
}

export function compactToolResultContent(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    try {
        return serializeToolResultForContext(JSON.parse(content), maxChars);
    } catch {
        return elideMiddle(content, maxChars);
    }
}

function compressionLine(message: LLMMessage, index: number, maxChars: number): string {
    const role = message.role === 'assistant' ? 'Assistant'
        : message.role === 'user' ? 'User'
            : message.role === 'tool' ? 'Tool'
                : 'System';
    let content = message.content || '';
    if (message.role === 'tool') content = compactToolResultContent(content, maxChars);
    if (message.toolCalls?.length) {
        content += `\n[Tool calls: ${message.toolCalls.map(call => call.name).join(', ')}]`;
    }
    return `[${index + 1}] ${role}: ${elideMiddle(content, maxChars)}`;
}

/**
 * Builds a balanced semantic-compression transcript.  Unlike the old prefix
 * builder it allocates space to every message, so late constraints and final
 * tool evidence cannot disappear merely because early output was verbose.
 */
export function buildCompressionTranscript(messages: LLMMessage[], maxChars = 32_000): string {
    if (messages.length === 0 || maxChars <= 0) return '';
    const labelAllowance = Math.min(maxChars / 3, messages.length * 28);
    const perMessage = Math.max(120, Math.floor((maxChars - labelAllowance) / messages.length));
    const lines = messages.map((message, index) => compressionLine(message, index, perMessage));
    return elideMiddle(lines.join('\n'), maxChars);
}
