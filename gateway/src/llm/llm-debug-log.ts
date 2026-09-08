/**
 * 统一的 LLM 调用日志
 *
 * 覆盖所有 provider 的 chat / chatWithTools / chatStream 调用（含完成度守卫、动作核验、
 * 上下文摘要等辅助调用）。请求在调用前落盘，响应/错误在调用后落盘，便于排查在途请求、
 * 风控拦截、流式中断等问题。
 *
 * 落盘目录：logs/llm-debug/
 * 文件命名：{时间戳}_{method}_{provider}_(request|response|error).json
 *
 * 默认开启；设置环境变量 OPENFLUX_LLM_DEBUG=0（或 false）可关闭。
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { redactSensitiveValue } from '../security/redaction';

// Full model payload logging is opt-in because requests may contain private user data.
const ENABLED =
    process.env.OPENFLUX_LLM_DEBUG === '1' ||
    process.env.OPENFLUX_LLM_DEBUG === 'true';

let dirEnsured = false;
function ensureDir(): string | null {
    const dir = join(process.cwd(), 'logs', 'llm-debug');
    try {
        if (!dirEnsured) {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            dirEnsured = true;
        }
        return dir;
    } catch {
        return null;
    }
}

/** 截断请求体中的 base64 图片数据，避免日志文件膨胀 */
function sanitizeForLog(value: unknown): unknown {
    if (typeof value === 'string') {
        // data:image/...;base64,XXXX 形式
        if (/^data:[^;]+;base64,/.test(value) && value.length > 256) {
            const head = value.slice(0, value.indexOf(',') + 1);
            return `${head}[base64 omitted, ${value.length} chars]`;
        }
        // 裸 base64 长串（如 Anthropic image.source.data）
        if (value.length > 4096 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 256))) {
            return `[base64 omitted, ${value.length} chars]`;
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeForLog);
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeForLog(v);
        }
        return out;
    }
    return value;
}

export interface LlmLogMeta {
    provider: string;
    model?: string;
    method: 'chat' | 'chatWithTools' | 'chatStream';
    /** 完整请求 URL（可选） */
    url?: string;
    /** 已脱敏的请求头（可选，调用方负责屏蔽密钥） */
    headers?: Record<string, unknown>;
    /** 是否流式 */
    stream?: boolean;
    /** 请求体（messages / params 等），会自动截断 base64 */
    request: unknown;
}

export interface LlmLogHandle {
    /** 记录成功响应 */
    response: (data: unknown) => void;
    /** 记录错误 */
    error: (err: unknown) => void;
}

const NOOP_HANDLE: LlmLogHandle = { response: () => {}, error: () => {} };

/**
 * 开始一次 LLM 调用日志：立即落盘请求，返回用于记录响应/错误的句柄。
 * 任何 IO 异常都被吞掉，绝不影响主流程。
 */
export function startLlmLog(meta: LlmLogMeta): LlmLogHandle {
    if (!ENABLED) return NOOP_HANDLE;
    const dir = ensureDir();
    if (!dir) return NOOP_HANDLE;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `${ts}_${meta.method}_${meta.provider}`;
    const startedAt = Date.now();

    const common = {
        timestamp: new Date().toISOString(),
        provider: meta.provider,
        model: meta.model,
        method: meta.method,
        url: meta.url,
        stream: meta.stream ?? false,
    };

    try {
        writeFileSync(
            join(dir, `${base}_request.json`),
            JSON.stringify({
                ...common,
                headers: redactSensitiveValue(meta.headers),
                body: redactSensitiveValue(sanitizeForLog(meta.request)),
            }, null, 2),
            'utf-8',
        );
    } catch { /* ignore */ }

    return {
        response: (data: unknown) => {
            try {
                writeFileSync(
                    join(dir, `${base}_response.json`),
                    JSON.stringify({
                        ...common,
                        durationMs: Date.now() - startedAt,
                        response: redactSensitiveValue(sanitizeForLog(data)),
                    }, null, 2),
                    'utf-8',
                );
            } catch { /* ignore */ }
        },
        error: (err: unknown) => {
            try {
                const e = err as any;
                writeFileSync(
                    join(dir, `${base}_error.json`),
                    JSON.stringify({
                        ...common,
                        durationMs: Date.now() - startedAt,
                        error: {
                            status: e?.status,
                            message: redactSensitiveValue(e?.message),
                            error_body: redactSensitiveValue(e?.error),
                            type: e?.type,
                            code: e?.code,
                        },
                    }, null, 2),
                    'utf-8',
                );
            } catch { /* ignore */ }
        },
    };
}
