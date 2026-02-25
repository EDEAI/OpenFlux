/**
 * 工具通用函数 - 参考 Clawdbot 设计
 */

import type { ToolResult } from './types';

// ============ 参数解析 ============

export type StringParamOptions = {
    required?: boolean;
    trim?: boolean;
    label?: string;
    allowEmpty?: boolean;
};

/**
 * 读取字符串参数
 */
export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options: StringParamOptions & { required: true },
): string;
export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options?: StringParamOptions,
): string | undefined;
export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    options: StringParamOptions = {},
): string | undefined {
    const { required = false, trim = true, label = key, allowEmpty = false } = options;
    const raw = params[key];
    if (typeof raw !== 'string') {
        if (required) throw new Error(`${label} 参数必填`);
        return undefined;
    }
    const value = trim ? raw.trim() : raw;
    if (!value && !allowEmpty) {
        if (required) throw new Error(`${label} 参数必填`);
        return undefined;
    }
    return value;
}

/**
 * 读取数字参数
 */
export function readNumberParam(
    params: Record<string, unknown>,
    key: string,
    options: { required?: boolean; label?: string; integer?: boolean } = {},
): number | undefined {
    const { required = false, label = key, integer = false } = options;
    const raw = params[key];
    let value: number | undefined;

    if (typeof raw === 'number' && Number.isFinite(raw)) {
        value = raw;
    } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed) {
            const parsed = Number.parseFloat(trimmed);
            if (Number.isFinite(parsed)) value = parsed;
        }
    }

    if (value === undefined) {
        if (required) throw new Error(`${label} 参数必填`);
        return undefined;
    }

    return integer ? Math.trunc(value) : value;
}

/**
 * 读取布尔参数
 */
export function readBooleanParam(
    params: Record<string, unknown>,
    key: string,
    defaultValue = false,
): boolean {
    const raw = params[key];
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
        const lower = raw.toLowerCase();
        if (lower === 'true' || lower === '1') return true;
        if (lower === 'false' || lower === '0') return false;
    }
    return defaultValue;
}

/**
 * 读取字符串数组参数
 */
export function readStringArrayParam(
    params: Record<string, unknown>,
    key: string,
    options: { required?: boolean; label?: string } = {},
): string[] | undefined {
    const { required = false, label = key } = options;
    const raw = params[key];

    if (Array.isArray(raw)) {
        const values = raw
            .filter((entry) => typeof entry === 'string')
            .map((entry) => (entry as string).trim())
            .filter(Boolean);
        if (values.length === 0) {
            if (required) throw new Error(`${label} 参数必填`);
            return undefined;
        }
        return values;
    }

    if (typeof raw === 'string') {
        const value = raw.trim();
        if (!value) {
            if (required) throw new Error(`${label} 参数必填`);
            return undefined;
        }
        return [value];
    }

    if (required) throw new Error(`${label} 参数必填`);
    return undefined;
}

// ============ 结果格式化 ============

/**
 * JSON 结果
 */
export function jsonResult<T = unknown>(data: T): ToolResult {
    return {
        success: true,
        data,
    };
}

/**
 * 错误结果
 */
export function errorResult(error: string | Error): ToolResult {
    return {
        success: false,
        error: typeof error === 'string' ? error : error.message,
    };
}

/**
 * 文本结果
 */
export function textResult(text: string): ToolResult {
    return {
        success: true,
        data: { text },
    };
}

// ============ 工具辅助 ============

/**
 * 安全执行工具操作
 */
export async function safeExecute<T>(
    fn: () => Promise<T>,
): Promise<ToolResult> {
    try {
        const result = await fn();
        return jsonResult(result);
    } catch (error) {
        return errorResult(error as Error);
    }
}

/**
 * 验证动作参数
 */
export function validateAction<T extends string>(
    params: Record<string, unknown>,
    validActions: readonly T[],
): T {
    const action = readStringParam(params, 'action', { required: true, label: 'action' });
    if (!validActions.includes(action as T)) {
        throw new Error(`无效的 action: ${action}，可选值: ${validActions.join(', ')}`);
    }
    return action as T;
}
