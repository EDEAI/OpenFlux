/**
 * Scheduling system type definition
 */

// ========================
// Trigger configuration
// ========================

/** Cron expression trigger */
export interface CronTrigger {
    type: 'cron';
    /** Cron expression (such as "0 9 * * 1-5" means 9 o'clock in the morning on weekdays) */
    expression: string;
}

/** Fixed interval trigger */
export interface IntervalTrigger {
    type: 'interval';
    /** Interval time (milliseconds) */
    intervalMs: number;
}

/** One-time scheduled trigger */
export interface OnceTrigger {
    type: 'once';
    /** ISO time string or timestamp */
    runAt: string | number;
}

export type TriggerConfig = CronTrigger | IntervalTrigger | OnceTrigger;

// ========================
// Execution goals
// ========================

/** Trigger Workflow */
export interface WorkflowTarget {
    type: 'workflow';
    workflowId: string;
    params?: Record<string, unknown>;
}

/** Trigger Agent dialogue */
export interface AgentTarget {
    type: 'agent';
    prompt: string;
}

export type TaskTarget = WorkflowTarget | AgentTarget;

// ========================
// scheduled tasks
// ========================

export type TaskStatus = 'active' | 'paused' | 'completed' | 'error';

export interface ScheduledTask {
    /** Task ID */
    id: string;
    /** Task name */
    name: string;
    /** Trigger configuration */
    trigger: TriggerConfig;
    /** Execution goals */
    target: TaskTarget;
    /** Task status */
    status: TaskStatus;
    /** Creation time */
    createdAt: number;
    /** Last execution time */
    lastRunAt?: number;
    /** Next execution time */
    nextRunAt?: number;
    /** Total number of executions */
    runCount: number;
    /** Number of consecutive failures */
    failCount: number;
    /** Maximum number of consecutive failures (automatic pause when exceeded, 0 = no limit) */
    maxFailCount: number;
    /** Associated chat session ID (execution results are aggregated to this session) */
    sessionId?: string;
    /** Associated User Agent ID (used to inject Agent identity execution) */
    agentId?: string;
    /** Source channel */
    channel?: string;
}

// ========================
// Execution record
// ========================

export type RunStatus = 'running' | 'completed' | 'failed';

export interface TaskRun {
    /** Run ID */
    id: string;
    /** Associated task ID */
    taskId: string;
    /** Task name (redundant, convenient for display) */
    taskName: string;
    /** Running status */
    status: RunStatus;
    /** Start time */
    startedAt: number;
    /** Completion time */
    completedAt?: number;
    /** Execution time (ms) */
    duration?: number;
    /** Summary of execution results */
    output?: string;
    /** error message */
    error?: string;
    /** Associate session ID */
    sessionId?: string;
    /** Tool call summary */
    toolCalls?: Array<{ name: string; action?: string }>;
    /** Number of Agent Loop iterations */
    iterations?: number;
}

// ========================
// progress event
// ========================

export interface SchedulerEvent {
    type: 'task_created' | 'task_updated' | 'task_deleted' |
          'task_paused' | 'task_resumed' |
          'run_start' | 'run_complete' | 'run_failed';
    taskId: string;
    taskName?: string;
    runId?: string;
    sessionId?: string;
    error?: string;
    timestamp: number;
}
