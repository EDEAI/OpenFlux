/**
 * 配置 Schema 定义
 */
import { z } from 'zod';

const LLMConfigSchema = z.object({
    provider: z.enum(['anthropic', 'openai', 'google', 'ollama', 'minimax', 'deepseek', 'zhipu', 'moonshot', 'custom', 'local']),
    model: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
});

const RemoteConfigSchema = z.object({
    enabled: z.boolean().default(false),
    host: z.string().default('localhost'),
    port: z.number().default(18801),
    token: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
});

const PermissionsConfigSchema = z.object({
    // 自动批准的操作级别 (0-3)
    autoApproveLevel: z.number().min(0).max(3).default(1),
    // 白名单目录（总是允许写入）
    allowedDirectories: z.array(z.string()).optional(),
    // 黑名单目录（始终需要确认）
    blockedDirectories: z.array(z.string()).optional(),
});

const BrowserConfigSchema = z.object({
    enabled: z.boolean().default(true),
    headless: z.boolean().default(false),
    slowMo: z.number().optional(),
});

const OpenCodeConfigSchema = z.object({
    enabled: z.boolean().default(true),
    autoApprove: z.boolean().default(false),
    workingDirectory: z.string().optional(),
});

// Web 搜索与获取配置
const WebSearchConfigSchema = z.object({
    /** 搜索提供商: brave 或 perplexity */
    provider: z.enum(['brave', 'perplexity']).default('brave'),
    /** Brave Search API Key */
    apiKey: z.string().optional(),
    /** 默认最大结果数 */
    maxResults: z.number().min(1).max(10).default(5),
    /** 超时时间（秒） */
    timeoutSeconds: z.number().positive().default(30),
    /** 缓存 TTL（分钟） */
    cacheTtlMinutes: z.number().min(0).default(15),
    /** Perplexity 配置 */
    perplexity: z.object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
    }).optional(),
});

const WebFetchConfigSchema = z.object({
    /** 是否启用 Readability 提取 */
    readability: z.boolean().default(true),
    /** 最大字符数 */
    maxChars: z.number().min(100).default(50000),
    /** 超时时间（秒） */
    timeoutSeconds: z.number().positive().default(30),
    /** 缓存 TTL（分钟） */
    cacheTtlMinutes: z.number().min(0).default(15),
    /** 自定义 User-Agent */
    userAgent: z.string().optional(),
});

const WebConfigSchema = z.object({
    search: WebSearchConfigSchema.optional(),
    fetch: WebFetchConfigSchema.optional(),
});

// 语音配置
const VoiceSTTConfigSchema = z.object({
    enabled: z.boolean().default(true),
    modelDir: z.string().optional(),
    numThreads: z.number().positive().optional(),
});

const VoiceTTSConfigSchema = z.object({
    enabled: z.boolean().default(true),
    voice: z.string().default('zh-CN-XiaoxiaoNeural'),
    rate: z.string().default('+0%'),
    volume: z.string().default('+0%'),
    autoPlay: z.boolean().default(false),
});

const VoiceConfigSchema = z.object({
    stt: VoiceSTTConfigSchema.optional(),
    tts: VoiceTTSConfigSchema.optional(),
});

// 供应商配置 schema
const ProviderConfigSchema = z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
});

// ========================
// Agent 工具策略配置
// ========================

const ToolProfileSchema = z.enum(['minimal', 'coding', 'automation', 'full']);

const AgentToolsConfigSchema = z.object({
    /** 预设 Profile */
    profile: ToolProfileSchema.optional(),
    /** 额外允许的工具（在 Profile 基础上追加） */
    alsoAllow: z.array(z.string()).optional(),
    /** 白名单（精确控制） */
    allow: z.array(z.string()).optional(),
    /** 黑名单 */
    deny: z.array(z.string()).optional(),
});

const SubAgentConfigSchema = z.object({
    /** 最大并发子 Agent 数 */
    maxConcurrent: z.number().positive().default(5),
    /** 子 Agent 默认超时（秒） */
    defaultTimeout: z.number().positive().default(300),
    /** 子 Agent 使用的模型（可选，默认复用主模型） */
    model: LLMConfigSchema.optional(),
    /** 子 Agent 工具限制 */
    tools: z.object({
        deny: z.array(z.string()).optional(),
    }).optional(),
});

// ========================
// 单个 Agent 配置
// ========================

const AgentConfigSchema = z.object({
    /** Agent ID（唯一标识） */
    id: z.string(),
    /** 是否为默认 Agent */
    default: z.boolean().optional(),
    /** 显示名称 */
    name: z.string().optional(),
    /** 描述（用于自动路由时的意图匹配） */
    description: z.string().optional(),
    /** 自定义系统提示 */
    systemPrompt: z.string().optional(),
    /** 使用的模型（可选，默认复用全局 orchestration） */
    model: LLMConfigSchema.optional(),
    /** 工具策略 */
    tools: AgentToolsConfigSchema.optional(),
    /** 子 Agent 配置 */
    subagents: SubAgentConfigSchema.optional(),
    /** 独立工作目录（可选，默认共享全局 workspace） */
    workspace: z.string().optional(),
    /** Agent 图标（emoji 或 URL，用于侧边栏显示） */
    icon: z.string().optional(),
    /** Agent 主题色（hex，用于视觉区分） */
    color: z.string().optional(),
});

// ========================
// 路由配置
// ========================

const RouterConfigSchema = z.object({
    /** 是否启用自动路由 */
    enabled: z.boolean().default(true),
    /** 路由使用的模型（可选，默认复用 orchestration） */
    model: LLMConfigSchema.optional(),
});

// ========================
// 技能配置
// ========================

const SkillConfigSchema = z.object({
    /** 技能唯一 ID */
    id: z.string(),
    /** 技能标题 */
    title: z.string(),
    /** 技能内容（Markdown） */
    content: z.string(),
    /** 是否启用 */
    enabled: z.boolean().default(true),
});

// ========================
// 多 Agent 总配置
// ========================

const AgentsConfigSchema = z.object({
    /** 路由配置 */
    router: RouterConfigSchema.optional(),
    /** 全局默认配置（被各 Agent 继承） */
    defaults: z.object({
        tools: AgentToolsConfigSchema.optional(),
        subagents: SubAgentConfigSchema.optional(),
    }).optional(),
    /** 全局智能体名称 */
    globalAgentName: z.string().optional(),
    /** 全局角色设定（所有 Agent 共享的系统提示） */
    globalSystemPrompt: z.string().optional(),
    /** 技能列表（注入系统提示词的专业知识） */
    skills: z.array(SkillConfigSchema).optional(),
    /** Agent 列表 */
    list: z.array(AgentConfigSchema).min(1),
});

// ========================
// MCP Server 配置
// ========================

const McpServerConfigSchema = z.object({
    /** MCP Server 名称（唯一标识） */
    name: z.string(),
    /** 执行位置: server（Gateway 端连接）或 client（客户端本机连接） */
    location: z.enum(['server', 'client']).default('server'),
    /** 传输方式: stdio（子进程）或 sse（远程） */
    transport: z.enum(['stdio', 'sse']).default('stdio'),
    /** stdio 模式：启动命令 */
    command: z.string().optional(),
    /** stdio 模式：命令参数 */
    args: z.array(z.string()).optional(),
    /** stdio 模式：环境变量 */
    env: z.record(z.string()).optional(),
    /** SSE 模式：服务器 URL */
    url: z.string().optional(),
    /** 是否启用（默认 true） */
    enabled: z.boolean().default(true),
    /** 连接超时（秒，默认 30） */
    timeout: z.number().positive().default(30),
});

const McpConfigSchema = z.object({
    /** MCP Server 列表 */
    servers: z.array(McpServerConfigSchema).optional(),
});

const DistillationConfigSchema = z.object({
    /** 是否启用蒸馏系统 */
    enabled: z.boolean().default(false),
    /** 蒸馏时段 - 开始时间 (HH:mm, 如 "02:00") */
    startTime: z.string().default('02:00'),
    /** 蒸馏时段 - 结束时间 (HH:mm, 如 "06:00") */
    endTime: z.string().default('06:00'),
    /** 最低质量分阈值 (0-100) */
    qualityThreshold: z.number().min(0).max(100).default(40),
    /** 会话密度合并阈值 */
    sessionDensityThreshold: z.number().positive().default(5),
    /** 语义相似度合并阈值 (0-1) */
    similarityThreshold: z.number().min(0).max(1).default(0.85),
});

const MemoryConfigSchema = z.object({
    /** 启用长期记忆 */
    enabled: z.boolean().default(true),
    /** 数据库文件名 (相对于 workspace/.memory/) */
    dbName: z.string().default('openflux_memory.db'),
    /** 向量维度 */
    vectorDim: z.number().default(1536),
    /** 调试日志 */
    debug: z.boolean().default(false),
    /** 记忆蒸馏配置 (独立于基础记忆系统) */
    distillation: DistillationConfigSchema.optional(),
});

// ========================
// 沙盒隔离配置
// ========================

const SandboxDockerConfigSchema = z.object({
    /** Docker 镜像名 */
    image: z.string().default('openflux-sandbox'),
    /** 内存限制 */
    memoryLimit: z.string().default('512m'),
    /** CPU 限制 */
    cpuLimit: z.string().default('1'),
    /** 网络模式: none（断网）| host | bridge */
    networkMode: z.enum(['none', 'host', 'bridge']).default('none'),
    /** 持久化 volume 缓存映射 { volume名: 容器路径 } */
    cacheVolumes: z.record(z.string(), z.string()).optional(),
    /** 容器超时（秒） */
    timeout: z.number().positive().default(60),
});

const SandboxConfigSchema = z.object({
    /** 执行模式: local（仅代码加固）| docker（容器隔离） */
    mode: z.enum(['local', 'docker']).default('local'),
    /** Docker 配置（mode: docker 时生效） */
    docker: SandboxDockerConfigSchema.optional(),
    /** 命令白名单（设置后只允许这些命令前缀） */
    allowedCommands: z.array(z.string()).optional(),
    /** 禁止写入的文件扩展名 */
    blockedExtensions: z.array(z.string()).optional(),
    /** 单文件最大写入大小（字节），默认 50MB */
    maxWriteSize: z.number().positive().default(50 * 1024 * 1024),
});

// 预置模型配置
const PresetModelSchema = z.object({
    value: z.string(),
    label: z.string(),
    multimodal: z.boolean().default(false),
});

export const OpenFluxConfigSchema = z.object({
    // 供应商配置（统一管理 API Key 和 baseUrl）
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    llm: z.object({
        orchestration: LLMConfigSchema,
        /** 执行 LLM (用于工具调用) */
        execution: LLMConfigSchema,
        /** 嵌入 LLM (用于长期记忆) - 可选，默认复用 orchestration */
        embedding: LLMConfigSchema.optional(),
        /** 备用 LLM (可选) */
        fallback: LLMConfigSchema.optional(),
    }),
    remote: RemoteConfigSchema.optional(),
    permissions: PermissionsConfigSchema.optional(),
    browser: BrowserConfigSchema.optional(),
    opencode: OpenCodeConfigSchema.optional(),
    workspace: z.string().optional(),
    // 语音配置（STT + TTS）
    voice: VoiceConfigSchema.optional(),
    // Web 搜索与获取配置
    web: WebConfigSchema.optional(),
    // MCP 外部工具服务器配置
    mcp: McpConfigSchema.optional(),
    // 长期记忆配置
    memory: MemoryConfigSchema.optional(),
    // 多 Agent 配置（可选，不配置时为单 Agent 模式）
    agents: AgentsConfigSchema.optional(),
    // 沙盒隔离配置
    sandbox: SandboxConfigSchema.optional(),
    // 预置模型列表（UI 下拉菜单默认选项）
    presetModels: z.record(z.string(), z.array(PresetModelSchema)).optional(),
    // LLM 输出语言（BCP 47 标签，如 zh-CN、en、ja 等）
    language: z.string().default('zh-CN'),
});

export type OpenFluxConfig = z.infer<typeof OpenFluxConfigSchema>;
export type LLMConfigType = z.infer<typeof LLMConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type AgentToolsConfigType = z.infer<typeof AgentToolsConfigSchema>;
export type SubAgentConfigType = z.infer<typeof SubAgentConfigSchema>;
export type McpServerConfigType = z.infer<typeof McpServerConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type SandboxDockerConfig = z.infer<typeof SandboxDockerConfigSchema>;
export type SkillConfig = z.infer<typeof SkillConfigSchema>;
