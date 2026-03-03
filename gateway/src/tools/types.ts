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
    /** 数组元素类型（type 为 'array' 时使用） */
    items?: { type: string };
}

/** 工具执行上下文（由 AgentLoop 注入，工具可选使用） */
export interface ToolExecutionContext {
    /** 当前执行的会话 ID */
    sessionId?: string;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, ToolParameter>;
    /** 工具是否可用（默认 true）。工厂函数可设为 false 表示前置条件不满足（如 API Key 缺失） */
    available?: boolean;
    execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
}

// 通用工具类型（用于工厂函数返回）
export type AnyTool = Tool;
