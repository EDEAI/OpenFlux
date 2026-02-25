/**
 * 工作流类型定义
 * 将 AgentOrchestrator 的结构化任务模型重构为可被 AgentLoop 调用的工作流系统
 */

// ========================
// 模板定义（静态）
// ========================

/** 工作流模板 */
export interface WorkflowTemplate {
    /** 唯一标识 */
    id: string;
    /** 显示名称 */
    name: string;
    /** 描述（告诉 LLM 这个流程做什么） */
    description: string;
    /** 触发关键词（帮助 LLM 判断何时使用） */
    triggers: string[];
    /** 流程接受的参数 */
    parameters: WorkflowParameterDef[];
    /** 步骤定义 */
    steps: WorkflowStepTemplate[];
}

/** 参数定义 */
export interface WorkflowParameterDef {
    name: string;
    description: string;
    type: 'string' | 'number' | 'boolean';
    required: boolean;
    default?: unknown;
}

/** 步骤类型 */
export type WorkflowStepType = 'tool' | 'llm';

/** 步骤模板 */
export interface WorkflowStepTemplate {
    /** 步骤 ID */
    id: string;
    /** 步骤名称 */
    name: string;
    /** 步骤描述 */
    description: string;
    /** 步骤类型：tool=调用工具(默认)，llm=LLM智能处理 */
    type?: WorkflowStepType;
    /** 要调用的工具名（type=tool 时使用） */
    tool?: string;
    /** 工具参数（支持 {{paramName}} 和 {{steps.stepId.result}} 模板语法） */
    args?: Record<string, unknown>;
    /** LLM 提示词（type=llm 时使用，支持 {{}} 模板语法） */
    prompt?: string;
    /** 是否需要用户确认后才执行 */
    requiresConfirmation?: boolean;
    /** 失败策略：stop=终止流程, skip=跳过继续, retry=重试 */
    onFailure?: 'stop' | 'skip' | 'retry';
    /** 重试次数（onFailure=retry 时生效，默认 1） */
    maxRetries?: number;
    /** 条件执行（参数名，truthy 时才执行） */
    condition?: string;
}

// ========================
// 运行时实例
// ========================

/** 工作流运行状态 */
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 步骤运行状态 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 工作流运行实例 */
export interface WorkflowRun {
    /** 运行 ID */
    id: string;
    /** 模板 ID */
    templateId: string;
    /** 模板名称 */
    templateName: string;
    /** 传入参数 */
    parameters: Record<string, unknown>;
    /** 运行状态 */
    status: WorkflowStatus;
    /** 各步骤运行状态 */
    steps: WorkflowStepRun[];
    /** 当前执行到第几步 */
    currentStep: number;
    /** 开始时间 */
    startedAt: number;
    /** 完成时间 */
    completedAt?: number;
    /** 错误信息 */
    error?: string;
}

/** 步骤运行实例 */
export interface WorkflowStepRun {
    /** 对应模板步骤 ID */
    stepId: string;
    /** 步骤名称 */
    name: string;
    /** 调用的工具（tool 步骤）或 'llm'（llm 步骤） */
    tool: string;
    /** 运行状态 */
    status: StepStatus;
    /** 工具返回结果 */
    result?: unknown;
    /** 错误信息 */
    error?: string;
    /** 开始时间 */
    startedAt?: number;
    /** 完成时间 */
    completedAt?: number;
    /** 已重试次数 */
    retryCount: number;
}

// ========================
// 进度事件（用于实时推送）
// ========================

/** 工作流进度事件类型 */
export type WorkflowEventType =
    | 'workflow_start'
    | 'step_start'
    | 'step_complete'
    | 'step_failed'
    | 'step_skipped'
    | 'workflow_complete'
    | 'workflow_failed';

/** 工作流进度事件 */
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
