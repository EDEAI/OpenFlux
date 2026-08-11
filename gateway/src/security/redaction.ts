/** Shared high-confidence credential detection/redaction helpers. */

export type SecretKind =
    | 'private_key'
    | 'api_key'
    | 'access_token'
    | 'password'
    | 'authorization';

export interface SecretFinding {
    kind: SecretKind;
    start: number;
    end: number;
}

export interface SecretRedactionResult {
    value: string;
    findings: SecretFinding[];
}

const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: Array<{ kind: SecretKind; pattern: RegExp }> = [
    {
        kind: 'private_key',
        pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    },
    { kind: 'api_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { kind: 'api_key', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
    { kind: 'api_key', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
    { kind: 'access_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { kind: 'api_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    {
        kind: 'access_token',
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    },
    { kind: 'authorization', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi },
    {
        kind: 'password',
        pattern: /\b(password|passwd|pwd|passcode)\b\s*[:=]\s*(?!\[REDACTED\])(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi,
    },
    {
        kind: 'api_key',
        pattern: /\b(api[_-]?key|client[_-]?secret|secret[_-]?key)\b\s*[:=]\s*(?!\[REDACTED\])(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi,
    },
    {
        kind: 'access_token',
        pattern: /\b(access[_-]?token|refresh[_-]?token|auth[_-]?token)\b\s*[:=]\s*(?!\[REDACTED\])(?:"[^"]+"|'[^']+'|[^\s,;]+)/gi,
    },
];

const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|passcode|token|access_token|refresh_token|api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|private[_-]?key)$/i;
const REASONING_FIELD = /^(?:reasoning|reasoning_content|thinking|chain_of_thought)$/i;

export function redactSecrets(text: string): SecretRedactionResult {
    let value = String(text ?? '');
    const findings: SecretFinding[] = [];

    for (const { kind, pattern } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        value = value.replace(pattern, (match: string, ...args: unknown[]) => {
            const maybeOffset = args.at(-2);
            const offset = typeof maybeOffset === 'number' ? maybeOffset : 0;
            findings.push({ kind, start: offset, end: offset + match.length });
            const separator = match.search(/[:=]/);
            if (separator > 0 && !match.startsWith('-----BEGIN')) {
                return `${match.slice(0, separator + 1)} ${REDACTED}`;
            }
            return REDACTED;
        });
    }

    return { value, findings };
}

export function containsSecrets(text: string): boolean {
    return redactSecrets(text).findings.length > 0;
}

/** Deep redaction for logs, approval payloads and user-visible diagnostics. */
export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') return redactSecrets(value).value;
    if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item, seen));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';

    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (SECRET_FIELD.test(key)) output[key] = REDACTED;
        else if (REASONING_FIELD.test(key)) output[key] = '[OMITTED]';
        else output[key] = redactSensitiveValue(child, seen);
    }
    seen.delete(value);
    return output;
}

export const SECRET_REDACTION_MARKER = REDACTED;
