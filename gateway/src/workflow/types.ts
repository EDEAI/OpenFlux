/**
 * Workflow type definition
 * Refactor AgentOrchestrator's structured task model into a workflow system that can be called by AgentLoop
 */

// ========================
// Template definition (static)
// ========================

/** Workflow template */
export interface WorkflowTemplate {
    /** unique identifier */
    id: string;
    /** display name */
    name: string;
    /** Description (tells LLM what this process does) */
    description: string;
    /** Usage intent (semantic description, LLM matches by understanding user intent, supports any language) */
    intent?: string;
    /** Trigger keywords (optional, as auxiliary matching clues) */
    triggers?: string[];
    /** Parameters accepted by the process */
    parameters: WorkflowParameterDef[];
    /** Step definition */
    steps: WorkflowStepTemplate[];
}

/** Parameter definition */
export interface WorkflowParameterDef {
    name: string;
    description: string;
    type: 'string' | 'number' | 'boolean';
    required: boolean;
    default?: unknown;
}

/** step type */
export type WorkflowStepType = 'tool' | 'llm';

/** Step template */
export interface WorkflowStepTemplate {
    /** step ID */
    id: string;
    /** step name */
    name: string;
    /** Step description */
    description: string;
    /** Step type: tool=call tool (default), llm=LLM intelligent processing */
    type?: WorkflowStepType;
    /** The name of the tool to be called (used when type=tool) */
    tool?: string;
    /** Tool parameters (supports {{paramName}} and {{steps.stepId.result}} template syntax) */
    args?: Record<string, unknown>;
    /** LLM prompt word (used when type=llm, supports {{}} template syntax) */
    prompt?: string;
    /** Whether user confirmation is required before execution */
    requiresConfirmation?: boolean;
    /** Failure strategy: stop=terminate the process, skip=skip to continue, retry=try again */
    onFailure?: 'stop' | 'skip' | 'retry';
    /** Number of retries (valid when onFailure=retry, default 1) */
    maxRetries?: number;
    /** Conditional execution (parameter name, executed only when truthy) */
    condition?: string;
}

// ========================
// runtime instance
// ========================

/** Workflow running status */
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Step running status */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Workflow running instance */
export interface WorkflowRun {
    /** Run ID */
    id: string;
    /** Template ID */
    templateId: string;
    /** Template name */
    templateName: string;
    /** Pass in parameters */
    parameters: Record<string, unknown>;
    /** Running status */
    status: WorkflowStatus;
    /** Running status of each step */
    steps: WorkflowStepRun[];
    /** Which step is currently being executed? */
    currentStep: number;
    /** Start time */
    startedAt: number;
    /** Completion time */
    completedAt?: number;
    /** error message */
    error?: string;
}

/** Steps to run the example */
export interface WorkflowStepRun {
    /** Corresponding template step ID */
    stepId: string;
    /** step name */
    name: string;
    /** The tool called (tool step) or 'llm' (llm step) */
    tool: string;
    /** Running status */
    status: StepStatus;
    /** Tool returns results */
    result?: unknown;
    /** error message */
    error?: string;
    /** Start time */
    startedAt?: number;
    /** Completion time */
    completedAt?: number;
    /** Number of retries */
    retryCount: number;
}

// ========================
// Progress events (for real-time push)
// ========================

/** Workflow progress event type */
export type WorkflowEventType =
    | 'workflow_start'
    | 'step_start'
    | 'step_complete'
    | 'step_failed'
    | 'step_skipped'
    | 'workflow_complete'
    | 'workflow_failed';

/** Workflow progress events */
export interface WorkflowProgressEvent {
    type: WorkflowEventType;
    workflowId: string;
    workflowName: string;
    stepId?: string;
    stepName?: string;
    stepIndex?: number;
    totalSteps?: number;
    result?: unknown;
    error?: string;
}
