/**
 * Tool type definition
 */

import type { ApprovalMode } from '../permissions/checker';
import type { PlanDocument, PlanQuestion } from '../work/types';
import type { ExecutionWorkMode } from '../work/policy';

export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
    /** Stable machine-readable failure code for callers that need recovery logic. */
    code?: string;
    /** Whether a later, user-initiated retry may succeed. This does not authorize an automatic retry. */
    retryable?: boolean;
    /** Transport route used by the tool (for example `router_proxy` or `direct`). */
    route?: string;
    /** Sanitized low-level failure details retained for diagnostics. */
    cause?: { name?: string; message?: string; code?: string; status?: number };
    /** The image (base64) returned by the tool will be sent by AgentLoop as Vision content to LLM for analysis */
    images?: Array<{ mimeType: string; data: string; description?: string }>;
    /**
     * When true, `images` are generated artifacts meant for the user/frontend display only,
     * and must NOT be re-injected back into the LLM as a "screenshot to analyze".
     * (Used by generate_image to avoid re-feeding a large image into the model.)
     */
    imagesForDisplayOnly?: boolean;
    /** Ends a planning turn without treating the control transition as an error. */
    controlSignal?: 'waiting_input' | 'awaiting_plan_approval';
}

export interface ToolParameter {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required?: boolean;
    default?: unknown;
    enum?: string[];
    /** Array element type (used when type is 'array', supports nesting) */
    items?: { type: string; items?: { type: string } };
}

export type ToolApprovalDecision = 'approved' | 'denied';

export interface ToolApprovalRequest {
    requestId: string;
    toolName: string;
    /** Arguments are redacted before they cross the runtime boundary. */
    args: Record<string, unknown>;
    riskLevel: number;
    riskLabel: 'none' | 'low' | 'medium' | 'high';
    reason: string;
    sessionId?: string;
    turnId?: string;
}

/** Tool execution context (injected by AgentLoop, optional for tool use) */
export interface ToolExecutionContext {
    /** Currently executing session ID */
    sessionId?: string;
    /** Stable ID of the turn that owns this tool call. */
    turnId?: string;
    /** Correlation IDs for structured traces; never contain user payloads. */
    runId?: string;
    traceId?: string;
    parentSessionId?: string;
    /** Cooperative cancellation for the current turn. */
    abortSignal?: AbortSignal;
    /** Alias used by adapters that mirror RequestInit. */
    signal?: AbortSignal;
    /** Ask the initiating client to approve a risk-gated action. */
    requestApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
    /** Per-turn approval policy snapshot. Never read this from mutable global state. */
    approvalMode?: ApprovalMode;
    /** Work policy frozen when the owning turn is submitted. */
    workMode?: ExecutionWorkMode;
    planId?: string;
    planRevision?: number;
    /** Gateway-owned durable plan transitions. Never supplied by model arguments. */
    planControl?: {
        requestInput(questions: PlanQuestion[]): Promise<{ planId: string; requestId: string }>;
        publishDocument(document: PlanDocument, note?: string): Promise<{ planId: string; revision: number }>;
    };
    /** Capabilities of the model already selected by the active Flux mode.
     * Tools may adapt their output, but must never use this as permission to
     * create a second provider or bypass the active request route. */
    activeModel?: {
        provider: string;
        model: string;
        vision: boolean;
    };
    /** Whether to execute scheduled tasks (scheduled tasks use independent tabs and do not reuse user tabs) */
    isScheduledTask?: boolean;
    /**
     * Real-time progress callback (optional)
     * Time-consuming tools (such as coding_agent) can call this callback to push intermediate state during execution.
     * AgentLoop will transparently transmit it to the front-end chat.progress event.
     */
    onProgress?: (event: { type: 'progress' | 'stdout' | 'stderr'; message: string; driver?: string }) => void;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, ToolParameter>;
    /** Whether the tool is available (default true). The factory function can be set to false to indicate that the preconditions are not met (such as API Key missing) */
    available?: boolean;
    /** The original JSON Schema of the MCP tool (completely retains complex structures such as items/anyOf/oneOf) */
    rawInputSchema?: Record<string, unknown>;
    /** Tool priority (0=highest, the smaller the number, the higher the priority will be sent to LLM). Default 50. LLM prefers tools higher on the selection list. */
    priority?: number;
    /** Tool for plug-in registration (not filtered by profile whitelist, always available to Agent) */
    isPlugin?: boolean;
    execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

// Generic utility type (for factory function returns)
export type AnyTool = Tool;
