/**
 * 工具类型定义
 */

export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
    /** 工具返回的图片（base64），AgentLoop 会作为 Vision 内容发给 LLM 分析 */
    images?: Array<{ mimeType: string; data: string; description?: string }>;
}

export interface ToolParameter {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required?: boolean;
    default?: unknown;
    enum?: string[];
    /** 数组元素类型（type 为 'array' 时使用，支持嵌套） */
    items?: { type: string; items?: { type: string } };
}

/** 工具执行上下文（由 AgentLoop 注入，工具可选使用） */
export interface ToolExecutionContext {
    /** 当前执行的会话 ID */
    sessionId?: string;
    /** 是否为定时任务执行（定时任务使用独立 tab，不复用用户 tab） */
    isScheduledTask?: boolean;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, ToolParameter>;
    /** 工具是否可用（默认 true）。工厂函数可设为 false 表示前置条件不满足（如 API Key 缺失） */
    available?: boolean;
    /** MCP 工具的原始 JSON Schema（完整保留 items/anyOf/oneOf 等复杂结构） */
    rawInputSchema?: Record<string, unknown>;
    /** 工具优先级（0=最高，数字越小越靠前发给 LLM）。默认 50。LLM 倾向选择列表靠前的工具。 */
    priority?: number;
    execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

// 通用工具类型（用于工厂函数返回）
export type AnyTool = Tool;
