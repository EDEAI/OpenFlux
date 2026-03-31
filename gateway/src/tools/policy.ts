/**
 * 工具策略系统
 * 工具组、Profile 预设、多层过滤链
 */

import type { Tool } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('ToolPolicy');

// ========================
// 类型定义
// ========================

/** 工具策略（allow/deny） */
export interface ToolPolicy {
    allow?: string[];
    deny?: string[];
}

/** Profile ID */
export type ToolProfileId = 'minimal' | 'coding' | 'automation' | 'full';

/** Agent 工具配置 */
export interface AgentToolsConfig {
    profile?: ToolProfileId;
    allow?: string[];
    deny?: string[];
    alsoAllow?: string[];
}

/** SubAgent 工具配置 */
export interface SubAgentToolsConfig {
    deny?: string[];
}

// ========================
// 工具组定义
// ========================

/**
 * 工具组：group:xxx → 具体工具名列表
 * 对应 OpenFlux 当前的 9 个工具
 */
export const TOOL_GROUPS: Record<string, string[]> = {
    // 文件系统 + 编码
    'group:fs': ['filesystem', 'opencode'],
    // 运行时 + 子 Agent
    'group:runtime': ['process', 'spawn'],
    // 浏览器 + Web 搜索/获取
    'group:web': ['browser', 'web_search', 'web_fetch'],
    // 系统控制
    'group:system': ['windows', 'desktop'],
    // 调度 + 工作流
    'group:scheduling': ['scheduler', 'workflow'],
    // 办公 + 通信
    'group:office': ['office', 'email', 'notify_user'],
    // 进化（技能市场 + 工具锻造）
    'group:evolution': ['skill_store', 'tool_forge'],
    // 所有工具
    'group:all': [
        'filesystem', 'opencode',
        'process', 'spawn',
        'browser', 'web_search', 'web_fetch',
        'windows', 'desktop',
        'scheduler', 'workflow',
        'office', 'email', 'notify_user',
        'skill_store', 'tool_forge',
    ],
};

// ========================
// 预设 Profile
// ========================

/**
 * 预设 Profile：按场景裁剪工具集
 * - minimal: 纯聊天，无工具
 * - coding: 编码场景（文件操作 + 命令执行）
 * - automation: 自动化场景（浏览器 + 桌面 + 调度）
 * - full: 全部工具（默认）
 */
export const TOOL_PROFILES: Record<ToolProfileId, ToolPolicy> = {
    minimal: {
        allow: [],
    },
    coding: {
        allow: ['group:fs', 'group:runtime', 'group:evolution', 'office', 'notify_user'],
    },
    automation: {
        allow: ['group:web', 'group:system', 'group:scheduling', 'group:evolution', 'spawn', 'email', 'notify_user'],
    },
    full: {
        // 无限制
    },
};

// ========================
// SubAgent 默认限制
// ========================

/**
 * SubAgent 默认禁用的工具
 * 子 Agent 不应该操作调度器、工作流等全局资源
 */
export const DEFAULT_SUBAGENT_TOOL_DENY: string[] = [
    'workflow',
    'desktop',
];

// ========================
// 工具组展开
// ========================

/**
 * 将工具名列表中的 group:xxx 展开为具体工具名
 */
export function expandToolGroups(names: string[]): string[] {
    const expanded = new Set<string>();

    for (const name of names) {
        if (name.startsWith('group:') && TOOL_GROUPS[name]) {
            for (const toolName of TOOL_GROUPS[name]) {
                expanded.add(toolName);
            }
        } else {
            expanded.add(name);
        }
    }

    return Array.from(expanded);
}

// ========================
// 策略过滤
// ========================

/**
 * 按 allow/deny 策略过滤工具列表
 *
 * 规则：
 * - deny 优先于 allow
 * - allow 为空或未设置 → 允许所有
 * - allow 有值 → 只允许列表中的工具
 */
export function filterToolsByPolicy(
    tools: Tool[],
    policy: ToolPolicy
): Tool[] {
    const deny = policy.deny ? expandToolGroups(policy.deny) : [];
    const allow = policy.allow ? expandToolGroups(policy.allow) : [];

    return tools.filter(tool => {
        const name = tool.name.toLowerCase();

        // deny 优先
        if (deny.includes(name)) {
            return false;
        }

        // allow 为空 → 允许所有
        if (allow.length === 0) {
            return true;
        }

        // allow 有值 → 只允许列表中的
        return allow.includes(name);
    });
}

// ========================
// 综合过滤（3 层）
// ========================

/**
 * 为指定 Agent 解析最终工具列表
 *
 * 过滤链：
 *   Layer 1: Profile 过滤（按场景裁剪）
 *   Layer 2: Agent allow/deny（按 Agent 微调）
 *   Layer 3: SubAgent deny（子 Agent 默认禁用危险工具）
 */
export function resolveToolsForAgent(
    allTools: Tool[],
    agentTools?: AgentToolsConfig,
    isSubAgent?: boolean,
    subAgentConfig?: SubAgentToolsConfig
): Tool[] {
    let tools = [...allTools];

    // Layer 1: Profile 过滤
    if (agentTools?.profile && agentTools.profile !== 'full') {
        const profilePolicy = TOOL_PROFILES[agentTools.profile];
        if (profilePolicy) {
            // 合并 alsoAllow 到 profile 的 allow 列表
            let mergedPolicy = { ...profilePolicy };
            if (profilePolicy.allow && agentTools.alsoAllow?.length) {
                mergedPolicy = {
                    ...profilePolicy,
                    allow: [...profilePolicy.allow, ...agentTools.alsoAllow],
                };
            }
            tools = filterToolsByPolicy(tools, mergedPolicy);
            log.debug(`Profile "${agentTools.profile}" filtering: ${allTools.length} → ${tools.length}`);
        }
    }

    // Layer 2: Agent allow/deny 微调
    if (agentTools?.allow || agentTools?.deny) {
        const agentPolicy: ToolPolicy = {};
        if (agentTools.allow) agentPolicy.allow = agentTools.allow;
        if (agentTools.deny) agentPolicy.deny = agentTools.deny;
        const beforeCount = tools.length;
        tools = filterToolsByPolicy(tools, agentPolicy);
        log.debug(`Agent allow/deny filtering: ${beforeCount} → ${tools.length}`);
    }

    // Layer 3: SubAgent 默认限制
    if (isSubAgent) {
        const denyList = subAgentConfig?.deny || DEFAULT_SUBAGENT_TOOL_DENY;
        const beforeCount = tools.length;
        tools = filterToolsByPolicy(tools, { deny: denyList });
        log.debug(`SubAgent deny filtering: ${beforeCount} → ${tools.length}`);
    }

    return tools;
}

/**
 * 获取 Profile 的工具名称列表（展开后）
 * 用于日志和调试
 */
export function getProfileToolNames(profileId: ToolProfileId): string[] {
    const profile = TOOL_PROFILES[profileId];
    if (!profile || !profile.allow) {
        return ['*'];
    }
    return expandToolGroups(profile.allow);
}
