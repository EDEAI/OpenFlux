/**
 * Session Key 工具 — OpenClaw 风格复合 Key
 *
 * 格式: agent:{agentId}:{scope}
 * 示例: agent:coder:main, agent:writer:user:alice, agent:coder:discord:group:123
 */

// 默认 Agent ID
export const DEFAULT_AGENT_ID = 'main';

// 默认 scope（桌面端主会话）
export const DEFAULT_SCOPE = 'main';

// Agent ID 校验正则
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/** 解析后的 Session Key */
export interface ParsedSessionKey {
    agentId: string;
    scope: string;
}

/**
 * 标准化 Agent ID
 * - 转为小写
 * - 替换非法字符为 -
 * - 最长 64 字符
 */
export function normalizeAgentId(id: string | undefined | null): string {
    const trimmed = (id ?? '').trim();
    if (!trimmed) return DEFAULT_AGENT_ID;

    if (VALID_AGENT_ID_RE.test(trimmed.toLowerCase())) {
        return trimmed.toLowerCase();
    }

    // Best-effort: 替换非法字符
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
 * 校验 Agent ID 是否合法
 */
export function isValidAgentId(id: string | undefined | null): boolean {
    const trimmed = (id ?? '').trim();
    return Boolean(trimmed) && VALID_AGENT_ID_RE.test(trimmed.toLowerCase());
}

/**
 * 构建 Session Key
 *
 * @param agentId Agent ID
 * @param scope 会话范围（默认 "main"）
 * @returns agent:{agentId}:{scope}
 */
export function buildSessionKey(agentId: string, scope: string = DEFAULT_SCOPE): string {
    return `agent:${normalizeAgentId(agentId)}:${scope}`;
}

/**
 * 构建 Agent 主会话 Key
 */
export function buildAgentMainKey(agentId: string): string {
    return buildSessionKey(agentId, DEFAULT_SCOPE);
}

/**
 * 解析 Session Key
 *
 * @returns 解析结果，不是合法格式返回 null
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
 * 从 Session Key 提取 Agent ID
 * 解析失败时返回默认 Agent ID
 */
export function resolveAgentId(key: string | undefined | null): string {
    return parseSessionKey(key)?.agentId ?? DEFAULT_AGENT_ID;
}

/**
 * 从 Session Key 提取 scope
 */
export function resolveScope(key: string | undefined | null): string {
    return parseSessionKey(key)?.scope ?? DEFAULT_SCOPE;
}

/**
 * Session Key → 文件名（用于 JSONL 存储）
 * agent:coder:main → agent_coder_main.jsonl
 */
export function sessionKeyToFilename(key: string): string {
    const parsed = parseSessionKey(key);
    if (!parsed) {
        // 兼容旧格式 UUID
        return `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;
    }
    return `agent_${parsed.agentId}_${parsed.scope.replace(/:/g, '_')}.jsonl`;
}

/**
 * 判断是否是旧格式（UUID）Session Key
 */
export function isLegacySessionKey(key: string): boolean {
    return !key.startsWith('agent:');
}

/**
 * 将旧格式 Session Key 迁移到默认 Agent
 */
export function migrateLegacyKey(legacyKey: string): string {
    return buildAgentMainKey(DEFAULT_AGENT_ID);
}
