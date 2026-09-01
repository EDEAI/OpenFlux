import type { WorkMode } from './types';

export type ExecutionWorkMode = WorkMode | 'plan_execution';

const PLAN_CONTROL_TOOLS = new Set(['request_plan_input', 'publish_plan_document']);
const READ_ONLY_TOOLS = new Set(['file_reader', 'project_search', 'web_search', 'web_fetch', 'sessions_search']);
const READ_ONLY_FILESYSTEM_ACTIONS = new Set(['read', 'list', 'exists', 'info']);
const READ_ONLY_MEMORY_ACTIONS = new Set(['search', 'list']);

export interface PlanToolPolicyDecision {
    allowed: boolean;
    reason?: string;
}

export function assessPlanModeTool(
    mode: ExecutionWorkMode | undefined,
    toolName: string,
    args: Record<string, unknown>,
): PlanToolPolicyDecision {
    if (mode !== 'plan') return { allowed: true };
    if (PLAN_CONTROL_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)) return { allowed: true };
    if (toolName === 'filesystem' && READ_ONLY_FILESYSTEM_ACTIONS.has(String(args.action || ''))) return { allowed: true };
    if (toolName === 'memory_tool' && READ_ONLY_MEMORY_ACTIONS.has(String(args.action || ''))) return { allowed: true };
    return {
        allowed: false,
        reason: `Tool ${toolName} is not available while researching a plan because it may have side effects.`,
    };
}

export function isPlanModeToolVisible(mode: ExecutionWorkMode | undefined, toolName: string): boolean {
    if (mode !== 'plan') return !PLAN_CONTROL_TOOLS.has(toolName);
    return PLAN_CONTROL_TOOLS.has(toolName)
        || READ_ONLY_TOOLS.has(toolName)
        || toolName === 'filesystem'
        || toolName === 'memory_tool';
}
