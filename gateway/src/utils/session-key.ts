/**
 * Session Key Tool - OpenClaw Style Composite Key
 *
 * Format: agent:{agentId}:{scope}
 * Example: agent:coder:main, agent:writer:user:alice, agent:coder:discord:group:123
 */

// Default Agent ID
export const DEFAULT_AGENT_ID = 'main';

// Default scope (main session on desktop)
export const DEFAULT_SCOPE = 'main';

// Agent ID verification rules
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/** Parsed Session Key */
export interface ParsedSessionKey {
    agentId: string;
    scope: string;
}

/**
 * Normalized Agent ID
 * - Convert to lower case
 * - Replace illegal characters with -
 * - Maximum 64 characters
 */
export function normalizeAgentId(id: string | undefined | null): string {
    const trimmed = (id ?? '').trim();
    if (!trimmed) return DEFAULT_AGENT_ID;

    if (VALID_AGENT_ID_RE.test(trimmed.toLowerCase())) {
        return trimmed.toLowerCase();
    }

    // Best-effort: replace illegal characters
    return (
        trimmed
            .toLowerCase()
            .replace(INVALID_CHARS_RE, '-')
            .replace(LEADING_DASH_RE, '')
            .replace(TRAILING_DASH_RE, '')
            .slice(0, 64) || DEFAULT_AGENT_ID
    );
}

/**
 * Verify whether the Agent ID is legal
 */
export function isValidAgentId(id: string | undefined | null): boolean {
    const trimmed = (id ?? '').trim();
    return Boolean(trimmed) && VALID_AGENT_ID_RE.test(trimmed.toLowerCase());
}

/**
 * Build Session Key
 *
 * @param agentId Agent ID
 * @param scope session scope (default "main")
 * @returns agent:{agentId}:{scope}
 */
export function buildSessionKey(agentId: string, scope: string = DEFAULT_SCOPE): string {
    return `agent:${normalizeAgentId(agentId)}:${scope}`;
}

/**
 * Build Agent main session Key
 */
export function buildAgentMainKey(agentId: string): string {
    return buildSessionKey(agentId, DEFAULT_SCOPE);
}

/**
 * Parse Session Key
 *
 * @returns parsing result, if it is not in a legal format, returns null
 */
export function parseSessionKey(key: string | undefined | null): ParsedSessionKey | null {
    const raw = (key ?? '').trim();
    if (!raw.startsWith('agent:')) return null;

    const parts = raw.split(':');
    if (parts.length < 3) return null;

    const agentId = parts[1];
    if (!agentId) return null;

    const scope = parts.slice(2).join(':') || DEFAULT_SCOPE;
    return { agentId: normalizeAgentId(agentId), scope };
}

/**
 * Extract Agent ID from Session Key
 * Returns the default Agent ID when parsing fails
 */
export function resolveAgentId(key: string | undefined | null): string {
    return parseSessionKey(key)?.agentId ?? DEFAULT_AGENT_ID;
}

/**
 * Extract scope from Session Key
 */
export function resolveScope(key: string | undefined | null): string {
    return parseSessionKey(key)?.scope ?? DEFAULT_SCOPE;
}

/**
 * Session Key -> Filename (for JSONL storage)
 * agent:coder:main → agent_coder_main.jsonl
 */
export function sessionKeyToFilename(key: string): string {
    const parsed = parseSessionKey(key);
    if (!parsed) {
        // Compatible with older formats UUID
        return `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
    }
    return `agent_${parsed.agentId}_${parsed.scope.replace(/:/g, '_')}.jsonl`;
}

/**
 * Determine whether it is an old format (UUID) Session Key
 */
export function isLegacySessionKey(key: string): boolean {
    return !key.startsWith('agent:');
}

/**
 * Migrate the old format Session Key to the default Agent
 */
export function migrateLegacyKey(legacyKey: string): string {
    return buildAgentMainKey(DEFAULT_AGENT_ID);
}
