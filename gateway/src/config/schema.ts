/**
 * Configure Schema definition
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
    // Automatically approved action levels (0-3)
    autoApproveLevel: z.number().min(0).max(3).default(1),
    // Whitelist directories (write is always allowed)
    allowedDirectories: z.array(z.string()).optional(),
    // Blacklist directory (always requires confirmation)
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

const NexusAIConfigSchema = z.object({
    /** NexusAI HTTP API address (login/user_info) */
    apiUrl: z.string().optional(),
    /** NexusAI chat WebSocket address */
    wsUrl: z.string().optional(),
    /** Atlas Model Egress gateway root address */
    atlasGatewayBaseUrl: z.string().optional(),
});

// Web search and get configuration
const WebSearchConfigSchema = z.object({
    /** Search provider: brave or perplexity */
    provider: z.enum(['brave', 'perplexity']).default('brave'),
    /** Brave Search API Key */
    apiKey: z.string().optional(),
    /** Default maximum number of results */
    maxResults: z.number().min(1).max(10).default(5),
    /** Timeout (seconds) */
    timeoutSeconds: z.number().positive().default(30),
    /** Cache TTL (minutes) */
    cacheTtlMinutes: z.number().min(0).default(15),
    /** Perplexity configuration */
    perplexity: z.object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
    }).optional(),
});

const WebFetchConfigSchema = z.object({
    /** Whether to enable Readability extraction */
    readability: z.boolean().default(true),
    /** Maximum number of characters */
    maxChars: z.number().min(100).default(50000),
    /** Timeout (seconds) */
    timeoutSeconds: z.number().positive().default(30),
    /** Cache TTL (minutes) */
    cacheTtlMinutes: z.number().min(0).default(15),
    /** Custom User-Agent */
    userAgent: z.string().optional(),
});

const WebConfigSchema = z.object({
    search: WebSearchConfigSchema.optional(),
    fetch: WebFetchConfigSchema.optional(),
});

// Voice configuration
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

// Vendor configuration schema
const ProviderConfigSchema = z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
});

// ========================
// Agent tool policy configuration
// ========================

const ToolProfileSchema = z.enum(['minimal', 'coding', 'automation', 'full', 'design']);

const AgentToolsConfigSchema = z.object({
    /** Default Profile */
    profile: ToolProfileSchema.optional(),
    /** Additional allowed tools (added on top of Profile) */
    alsoAllow: z.array(z.string()).optional(),
    /** Whitelist (precise control) */
    allow: z.array(z.string()).optional(),
    /** blacklist */
    deny: z.array(z.string()).optional(),
});

const SubAgentConfigSchema = z.object({
    /** Maximum number of concurrent sub-Agents */
    maxConcurrent: z.number().positive().default(5),
    /** Default timeout of sub-Agent (seconds) */
    defaultTimeout: z.number().positive().default(300),
    /** The model used by the sub-Agent (optional, the main model is reused by default) */
    model: LLMConfigSchema.optional(),
    /** Sub-Agent tool restrictions */
    tools: z.object({
        deny: z.array(z.string()).optional(),
    }).optional(),
});

// ========================
// Single Agent Configuration
// ========================

const AgentConfigSchema = z.object({
    /** Agent ID (unique identification) */
    id: z.string(),
    /** Whether it is the default Agent */
    default: z.boolean().optional(),
    /** display name */
    name: z.string().optional(),
    /** Description (used for intent matching during automatic routing) */
    description: z.string().optional(),
    /** Customize system prompts */
    systemPrompt: z.string().optional(),
    /** Model used (optional, reuses global orchestration by default) */
    model: LLMConfigSchema.optional(),
    /** Tool strategy */
    tools: AgentToolsConfigSchema.optional(),
    /** Sub-Agent configuration */
    subagents: SubAgentConfigSchema.optional(),
    /** Independent working directory (optional, shared global workspace by default) */
    workspace: z.string().optional(),
    /** Agent icon (emoji or URL, used for sidebar display) */
    icon: z.string().optional(),
    /** Agent theme color (hex, for visual distinction) */
    color: z.string().optional(),
});

// ========================
// Routing configuration
// ========================

const RouterConfigSchema = z.object({
    /** Whether to enable automatic routing */
    enabled: z.boolean().default(true),
    /** The model used by routing (optional, orchestration is reused by default) */
    model: LLMConfigSchema.optional(),
});

// ========================
// Skill configuration
// ========================

const SkillConfigSchema = z.object({
    /** Skill unique ID */
    id: z.string(),
    /** Skill title */
    title: z.string(),
    /** Skill content (Markdown) */
    content: z.string(),
    /** Whether to enable */
    enabled: z.boolean().default(true),
});

// ========================
// Multi-Agent total configuration
// ========================

const AgentsConfigSchema = z.object({
    /** Routing configuration */
    router: RouterConfigSchema.optional(),
    /** Global default configuration (inherited by each Agent) */
    defaults: z.object({
        tools: AgentToolsConfigSchema.optional(),
        subagents: SubAgentConfigSchema.optional(),
    }).optional(),
    /** Global agent name */
    globalAgentName: z.string().optional(),
    /** Global role settings (system prompts shared by all Agents) */
    globalSystemPrompt: z.string().optional(),
    /** Skill list (professional knowledge injected into system prompt words) */
    skills: z.array(SkillConfigSchema).optional(),
    /** Agent list */
    list: z.array(AgentConfigSchema).min(1),
});

// ========================
// MCP Server Configuration
// ========================

const McpServerConfigSchema = z.object({
    /** MCP Server name (unique identifier) */
    name: z.string(),
    /** Execution location: server (Gateway connection) or client (client local connection) */
    location: z.enum(['server', 'client']).default('server'),
    /** Transmission method: stdio (child process) or sse (remote) */
    transport: z.enum(['stdio', 'sse']).default('stdio'),
    /** stdio mode: start command */
    command: z.string().optional(),
    /** stdio mode: command parameters */
    args: z.array(z.string()).optional(),
    /** stdio mode: environment variables */
    env: z.record(z.string()).optional(),
    /** SSE mode: Server URL */
    url: z.string().optional(),
    /** Whether to enable (default true) */
    enabled: z.boolean().default(true),
    /** Connection timeout (seconds, default 30) */
    timeout: z.number().positive().default(30),
});

const McpConfigSchema = z.object({
    /** MCP Server List */
    servers: z.array(McpServerConfigSchema).optional(),
});

const DistillationConfigSchema = z.object({
    /** Whether to enable distillation system */
    enabled: z.boolean().default(false),
    /** Distillation period - start time (HH:mm, such as "02:00") */
    startTime: z.string().default('02:00'),
    /** Distillation period - end time (HH:mm, such as "06:00") */
    endTime: z.string().default('06:00'),
    /** Minimum quality score threshold (0-100) */
    qualityThreshold: z.number().min(0).max(100).default(40),
    /** Session density merge threshold */
    sessionDensityThreshold: z.number().positive().default(5),
    /** Semantic similarity merging threshold (0-1) */
    similarityThreshold: z.number().min(0).max(1).default(0.85),
});

const MemoryConfigSchema = z.object({
    /** Enable long-term memory */
    enabled: z.boolean().default(true),
    /** Database file name (relative to workspace/.memory/) */
    dbName: z.string().default('openflux_memory.db'),
    /** Vector dimensions */
    vectorDim: z.number().default(1536),
    /** Debug log */
    debug: z.boolean().default(false),
    /** Memory distillation configuration (independent of the base memory system) */
    distillation: DistillationConfigSchema.optional(),
});

// ========================
// Sandbox isolation configuration
// ========================

const SandboxDockerConfigSchema = z.object({
    /** Docker image name */
    image: z.string().default('openflux-sandbox'),
    /** Memory limit */
    memoryLimit: z.string().default('512m'),
    /** CPU restrictions */
    cpuLimit: z.string().default('1'),
    /** Network mode: none (disconnected) | host | bridge */
    networkMode: z.enum(['none', 'host', 'bridge']).default('none'),
    /** Persistent volume cache mapping: { volumeName: containerPath } */
    cacheVolumes: z.record(z.string(), z.string()).optional(),
    /** Container timeout (seconds) */
    timeout: z.number().positive().default(60),
});

const SandboxConfigSchema = z.object({
    /** Execution mode: local (code hardening only) | docker (container isolation) */
    mode: z.enum(['local', 'docker']).default('local'),
    /** Docker configuration (valid when mode: docker) */
    docker: SandboxDockerConfigSchema.optional(),
    /** Command whitelist (only these command prefixes are allowed after setting) */
    allowedCommands: z.array(z.string()).optional(),
    /** File extensions that are prohibited from writing */
    blockedExtensions: z.array(z.string()).optional(),
    /** Maximum write size of a single file (bytes), default 50MB */
    maxWriteSize: z.number().positive().default(50 * 1024 * 1024),
});

// Preset model configuration
const PresetModelSchema = z.object({
    value: z.string(),
    label: z.string(),
    multimodal: z.boolean().default(false),
});

// ========================
// Image generation model configuration (standalone/local source)
// In managed/atlas_managed modes the image model is resolved at runtime
// (Router-issued / Atlas ability) and does NOT come from this section.
// ========================
const ImageGenerationConfigSchema = z.object({
    /** Image backend provider */
    provider: z.enum(['openai', 'gemini']).default('openai'),
    /** Model id (e.g. gpt-image-2 / gemini-2.5-flash-image) */
    model: z.string().optional(),
    /** API key (independent from text providers) */
    apiKey: z.string().optional(),
    /** Base URL (optional, defaults to the official endpoint) */
    baseUrl: z.string().optional(),
    /** Default image size, e.g. 1024x1024 */
    size: z.string().optional(),
});

// ========================
// Enterprise white-label baked config (provided by openflux.brand.yaml generated by build-brand.ps1)
// ========================

/**
 * OpenFluxRouter bridge connection config (top-level `router`).
 * NOTE: distinct from `agents.router` (LLM intent routing). These are the enterprise
 * baked-in Router connection params, so the packaged client connects to the private
 * Router out of the box without the user having to fill them in.
 */
const RouterBridgeConfigSchema = z.object({
    /** WebSocket URL, e.g. wss://router.example.com/ws/app */
    url: z.string().optional(),
    /** App type: openflux / opencrawl */
    appType: z.string().optional(),
    /** App ID (assigned by the enterprise) */
    appId: z.string().optional(),
    /** API Key (assigned by the enterprise) */
    apiKey: z.string().optional(),
    /** App user ID (instance identifier, usually generated by the client at runtime) */
    appUserId: z.string().optional(),
    /** Whether the connection is enabled */
    enabled: z.boolean().optional(),
});

/** White-label lock flag: when locked, ignore the corresponding server-config.json overrides and reject runtime writes */
const BrandLockConfigSchema = z.object({
    /** Lock service addresses (router + nexusai): user cannot change them in settings */
    services: z.boolean().optional(),
    /** Skip the first-run setup wizard entirely (enterprise editions with baked-in config) */
    skipSetup: z.boolean().optional(),
    /** Brand-specific data dir name under the user data root (e.g. the bundle identifier).
     *  Isolates an enterprise edition's gateway data from the open-source OpenFlux build. */
    dataDir: z.string().optional(),
});

/** User-level Agent preset seeded on first run (written into user_agents.json) */
const AgentPresetSchema = z.object({
    /** Agent ID (auto-generated when omitted; recommend fixing the main agent to `main`) */
    id: z.string().optional(),
    /** Display name */
    name: z.string(),
    /** Description */
    description: z.string().optional(),
    /** Icon (emoji or URL) */
    icon: z.string().optional(),
    /** Theme color (hex) */
    color: z.string().optional(),
    /** System prompt */
    systemPrompt: z.string().optional(),
    /** Whether this is the default agent (exactly one should be true) */
    default: z.boolean().optional(),
});

/** Enterprise built-in memory, seeded once into the vector memory store on startup */
const MemoryPresetSchema = z.object({
    /** Memory content (the text that gets embedded and retrieved) */
    content: z.string(),
    /** Optional tags for categorization */
    tags: z.array(z.string()).optional(),
});

export const OpenFluxConfigSchema = z.object({
    // Supplier configuration (unified management of API Key and baseUrl)
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    llm: z.object({
        orchestration: LLMConfigSchema,
        /** Execute LLM (for tool calling) */
        execution: LLMConfigSchema,
        /** Embed LLM (for long-term memory) - optional, default multiplexing orchestration */
        embedding: LLMConfigSchema.optional(),
        /** Alternate LLM (optional) */
        fallback: LLMConfigSchema.optional(),
    }),
    remote: RemoteConfigSchema.optional(),
    nexusai: NexusAIConfigSchema.optional(),
    // White-label: baked-in OpenFluxRouter connection (top-level router, distinct from agents.router)
    router: RouterBridgeConfigSchema.optional(),
    // White-label: lock flag (when locked, ignore server-config.json overrides and reject runtime writes)
    brandLock: BrandLockConfigSchema.optional(),
    // White-label: user-level Agent presets seeded on first run
    agentPresets: z.array(AgentPresetSchema).optional(),
    // White-label: toggle built-in agents (e.g. designer). designer=false disables injecting the built-in designer agent.
    builtinAgents: z.object({
        designer: z.boolean().optional(),
    }).optional(),
    // White-label: enterprise built-in memories seeded once into the vector store
    memoryPresets: z.array(MemoryPresetSchema).optional(),
    permissions: PermissionsConfigSchema.optional(),
    browser: BrowserConfigSchema.optional(),
    opencode: OpenCodeConfigSchema.optional(),
    workspace: z.string().optional(),
    // Voice configuration (STT + TTS)
    voice: VoiceConfigSchema.optional(),
    // Web search and get configuration
    web: WebConfigSchema.optional(),
    // MCP External Tools Server Configuration
    mcp: McpConfigSchema.optional(),
    // long term memory configuration
    memory: MemoryConfigSchema.optional(),
    // Multi-Agent configuration (optional, single-Agent mode if not configured)
    agents: AgentsConfigSchema.optional(),
    // Sandbox isolation configuration
    sandbox: SandboxConfigSchema.optional(),
    // Preset model list (default option in UI drop-down menu)
    presetModels: z.record(z.string(), z.array(PresetModelSchema)).optional(),
    // Image generation model (standalone/local source; managed/atlas resolved at runtime)
    imageGeneration: ImageGenerationConfigSchema.optional(),
    // LLM output language (BCP 47 tags, such as zh-CN, en, ja, etc.)
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
export type NexusAIConfig = z.infer<typeof NexusAIConfigSchema>;
export type RouterBridgeConfig = z.infer<typeof RouterBridgeConfigSchema>;
export type BrandLockConfig = z.infer<typeof BrandLockConfigSchema>;
export type AgentPreset = z.infer<typeof AgentPresetSchema>;
export type MemoryPreset = z.infer<typeof MemoryPresetSchema>;
export type ImageGenerationConfig = z.infer<typeof ImageGenerationConfigSchema>;
