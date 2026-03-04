/**
 * 调度系统类型定义
 */

// ========================
// 触发器配置
// ========================

/** Cron 表达式触发 */
export interface CronTrigger {
    type: 'cron';
    /** Cron 表达式 (如 "0 9 * * 1-5" 表示工作日早9点) */
    expression: string;
}

/** 固定间隔触发 */
export interface IntervalTrigger {
    type: 'interval';
    /** 间隔时间(毫秒) */
    intervalMs: number;
}

/** 一次性定时触发 */
export interface OnceTrigger {
    type: 'once';
    /** ISO 时间字符串或时间戳 */
    runAt: string | number;
}

export type TriggerConfig = CronTrigger | IntervalTrigger | OnceTrigger;

// ========================
// 执行目标
// ========================

/** 触发 Workflow */
export interface WorkflowTarget {
    type: 'workflow';
    workflowId: string;
    params?: Record<string, unknown>;
}

/** 触发 Agent 对话 */
export interface AgentTarget {
    type: 'agent';
    prompt: string;
}

export type TaskTarget = WorkflowTarget | AgentTarget;

// ========================
// 定时任务
// ========================

export type TaskStatus = 'active' | 'paused' | 'completed' | 'error';

export interface ScheduledTask {
    /** 任务 ID */
    id: string;
    /** 任务名称 */
    name: string;
    /** 触发器配置 */
    trigger: TriggerConfig;
    /** 执行目标 */
    target: TaskTarget;
    /** 任务状态 */
    status: TaskStatus;
    /** 创建时间 */
    createdAt: number;
    /** 最后执行时间 */
    lastRunAt?: number;
    /** 下次执行时间 */
    nextRunAt?: number;
    /** 总执行次数 */
    runCount: number;
    /** 连续失败次数 */
    failCount: number;
    /** 最大连续失败次数（超过自动暂停，0=不限制） */
    maxFailCount: number;
    /** 关联的聊天会话 ID（执行结果归集到此会话） */
    sessionId?: string;
    /** 来源通道 */
    channel?: string;
}

// ========================
// 执行记录
// ========================

export type RunStatus = 'running' | 'completed' | 'failed';

export interface TaskRun {
    /** 运行 ID */
    id: string;
    /** 关联任务 ID */
    taskId: string;
    /** 任务名称(冗余，方便展示) */
    taskName: string;
    /** 运行状态 */
    status: RunStatus;
    /** 开始时间 */
    startedAt: number;
    /** 完成时间 */
    completedAt?: number;
    /** 执行耗时(ms) */
    duration?: number;
    /** 执行结果摘要 */
    output?: string;
    /** 错误信息 */
    error?: string;
    /** 关联会话 ID */
    sessionId?: string;
}

// ========================
// 进度事件
// ========================

export interface SchedulerEvent {
    type: 'task_created' | 'task_updated' | 'task_deleted' |
          'task_paused' | 'task_resumed' |
          'run_start' | 'run_complete' | 'run_failed';
    taskId: string;
    taskName?: string;
    runId?: string;
    error?: string;
    timestamp: number;
}
