/**
 * Tool common functions - reference Clawdbot design
 */

import type { ToolResult } from './types';

// ============ Parameter analysis ============

export type StringParamOptions = {
    required?: boolean;
    trim?: boolean;
    label?: string;
    allowEmpty?: boolean;
};

/**
 * Read string parameters
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
        if (required) throw new Error(`${label} parameter is required`);
        return undefined;
    }
    const value = trim ? raw.trim() : raw;
    if (!value && !allowEmpty) {
        if (required) throw new Error(`${label} parameter is required`);
        return undefined;
    }
    return value;
}

/**
 * Read numeric parameters
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
        if (required) throw new Error(`${label} parameter is required`);
        return undefined;
    }

    return integer ? Math.trunc(value) : value;
}

/**
 * Read boolean parameters
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
 * Read string array parameters
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
            if (required) throw new Error(`${label} parameter is required`);
            return undefined;
        }
        return values;
    }

    if (typeof raw === 'string') {
        const value = raw.trim();
        if (!value) {
            if (required) throw new Error(`${label} parameter is required`);
            return undefined;
        }
        return [value];
    }

    if (required) throw new Error(`${label} parameter is required`);
    return undefined;
}

// ============ Result formatting ============

/**
 * JSON results
 */
export function jsonResult<T = unknown>(data: T): ToolResult {
    return {
        success: true,
        data,
    };
}

/**
 * Wrong result
 */
export function errorResult(error: string | Error): ToolResult {
    return {
        success: false,
        error: typeof error === 'string' ? error : error.message,
    };
}

/**
 * Text results
 */
export function textResult(text: string): ToolResult {
    return {
        success: true,
        data: { text },
    };
}

// ============ Tool assistance ============

/**
 * Perform tool operations safely
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
 * Validate action parameters
 */
export function validateAction<T extends string>(
    params: Record<string, unknown>,
    validActions: readonly T[],
): T {
    // When LLM passes in an empty parameter object, provide more detailed usage tips
    if (!params || Object.keys(params).length === 0) {
        throw new Error(
            `Parameters cannot be empty. The action parameter is required. Valid values: ${validActions.join(', ')}.` +
            `\nExample: {"action": "${validActions[0]}", "path": "/file/path"}`
        );
    }
    const action = readStringParam(params, 'action', { required: true, label: 'action' });
    if (!validActions.includes(action as T)) {
        throw new Error(`Invalid action: ${action}, valid values: ${validActions.join(', ')}`);
    }
    return action as T;
}
