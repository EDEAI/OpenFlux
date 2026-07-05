/**
 * tool strategy system
 * Toolsets, Profile presets, multi-layer filter chains
 */

import type { Tool } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('ToolPolicy');

// ========================
// type definition
// ========================

/** Tool policy (allow/deny) */
export interface ToolPolicy {
    allow?: string[];
    deny?: string[];
}

/** Profile ID */
export type ToolProfileId = 'minimal' | 'coding' | 'automation' | 'full' | 'design';

/** Agent tool configuration */
export interface AgentToolsConfig {
    profile?: ToolProfileId;
    allow?: string[];
    deny?: string[];
    alsoAllow?: string[];
}

/** SubAgent tool configuration */
export interface SubAgentToolsConfig {
    deny?: string[];
}

// ========================
// Toolset definition
// ========================

/**
 * Tool group: group:xxx -> list of specific tool names
 * Corresponds to the current 9 tools of OpenFlux
 */
export const TOOL_GROUPS: Record<string, string[]> = {
    // File system + encoding
    'group:fs': ['filesystem', 'opencode', 'file_reader'],
    // Runtime + sub-Agent
    'group:runtime': ['process', 'spawn'],
    // Browser + Web Search/Get + 浏览器录制回放
    'group:web': ['browser', 'web_search', 'web_fetch', 'browser_recording'],
    // System control
    'group:system': ['windows', 'desktop'],
    // Scheduling + Workflow
    'group:scheduling': ['scheduler', 'workflow'],
    // Office + Communication
    'group:office': ['office', 'email', 'notify_user'],
    // Media generation (text-to-image / image-to-image) + 无限画布
    'group:media': ['generate_image', 'design_canvas'],
    // Evolution (Skill Market) - tool_forge is not available at runtime and is only manually triggered by the user after the task is completed
    'group:evolution': ['skill_store'],
    // All tools
    'group:all': [
        'filesystem', 'opencode', 'file_reader',
        'process', 'spawn',
        'browser', 'web_search', 'web_fetch', 'browser_recording',
        'windows', 'desktop',
        'scheduler', 'workflow',
        'office', 'email', 'notify_user',
        'generate_image', 'design_canvas',
        'skill_store',
    ],
};

// ========================
// Default Profile
// ========================

/**
 * Preset Profile: Toolset tailored to the scene
 * - minimal: pure chat, no tools
 * - coding: coding scenario (file operation + command execution)
 * - automation: automation scenario (browser + desktop + scheduling)
 * - design: 设计师场景（画布 + 文生图/图生图 + 联网检索 + 浏览器取参考）
 * - full: all tools (default)
 */
export const TOOL_PROFILES: Record<ToolProfileId, ToolPolicy> = {
    minimal: {
        allow: [],
    },
    coding: {
        // generate_image：Office 文档/PPT 配图靠它文生图，不要退回网上扒图
        // browser/web_search/web_fetch：Office 任务常要"查资料再写入文档"，缺网络工具会
        // 逼 agent 退回 process+Invoke-WebRequest 硬抓网页（JS 渲染页面必失败）的反模式
        allow: ['group:fs', 'group:runtime', 'group:evolution', 'office', 'generate_image', 'browser', 'web_search', 'web_fetch', 'notify_user'],
    },
    automation: {
        allow: ['group:web', 'group:system', 'group:scheduling', 'group:evolution', 'group:media', 'spawn', 'email', 'notify_user'],
    },
    design: {
        // 画布 + 图像生成/编辑 + 联网检索/浏览器（取参考、找素材）+ 文件读写（保存/读取素材）
        allow: ['design_canvas', 'generate_image', 'group:web', 'file_reader', 'filesystem', 'notify_user'],
    },
    full: {
        // Unlimited
    },
};

// ========================
// SubAgent default restrictions
// ========================

/**
 * SubAgent tools disabled by default
 * Sub-Agents should not operate global resources such as schedulers and workflows.
 */
export const DEFAULT_SUBAGENT_TOOL_DENY: string[] = [
    'workflow',
    'desktop',
];

// ========================
// Tool group expansion
// ========================

/**
 * Expand group:xxx in the tool name list into specific tool names
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
// Policy filtering
// ========================

/**
 * Filter tool list by allow/deny policy
 *
 * rule:
 * - deny takes precedence over allow
 * - allow is empty or not set -> allow all
 * - allow with value -> only allow tools in the list
 */
export function filterToolsByPolicy(
    tools: Tool[],
    policy: ToolPolicy
): Tool[] {
    const deny = policy.deny ? expandToolGroups(policy.deny) : [];
    const allow = policy.allow ? expandToolGroups(policy.allow) : [];

    return tools.filter(tool => {
        const name = tool.name.toLowerCase();

        // Plug-in tools are always allowed (not restricted by profile whitelist)
        if ((tool as any).isPlugin) {
            return !deny.includes(name);
        }

        // deny priority
        if (deny.includes(name)) {
            return false;
        }

        // allow is empty -> allow all
        if (allow.length === 0) {
            return true;
        }

        // allow has value -> allow only those in the list
        return allow.includes(name);
    });
}

// ========================
// Comprehensive filtering (3 layers)
// ========================

/**
 * Parse the final tool list for the specified Agent
 *
 * Filter chain:
 *   Layer 1: Profile filtering (cropping by scene)
 *   Layer 2: Agent allow/deny (fine-tuned by Agent)
 *   Layer 3: SubAgent deny (sub-Agent disables dangerous tools by default)
 */
export function resolveToolsForAgent(
    allTools: Tool[],
    agentTools?: AgentToolsConfig,
    isSubAgent?: boolean,
    subAgentConfig?: SubAgentToolsConfig
): Tool[] {
    let tools = [...allTools];

    // Layer 1: Profile filtering
    if (agentTools?.profile && agentTools.profile !== 'full') {
        const profilePolicy = TOOL_PROFILES[agentTools.profile];
        if (profilePolicy) {
            // Merge alsoAllow into profile's allow list
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

    // Layer 2: Agent allow/deny fine-tuning
    if (agentTools?.allow || agentTools?.deny) {
        const agentPolicy: ToolPolicy = {};
        if (agentTools.allow) agentPolicy.allow = agentTools.allow;
        if (agentTools.deny) agentPolicy.deny = agentTools.deny;
        const beforeCount = tools.length;
        tools = filterToolsByPolicy(tools, agentPolicy);
        log.debug(`Agent allow/deny filtering: ${beforeCount} → ${tools.length}`);
    }

    // Layer 3: SubAgent default restrictions
    if (isSubAgent) {
        const denyList = subAgentConfig?.deny || DEFAULT_SUBAGENT_TOOL_DENY;
        const beforeCount = tools.length;
        tools = filterToolsByPolicy(tools, { deny: denyList });
        log.debug(`SubAgent deny filtering: ${beforeCount} → ${tools.length}`);
    }

    return tools;
}

/**
 * Get the tool name list of Profile (after expansion)
 * for logging and debugging
 */
export function getProfileToolNames(profileId: ToolProfileId): string[] {
    const profile = TOOL_PROFILES[profileId];
    if (!profile || !profile.allow) {
        return ['*'];
    }
    return expandToolGroups(profile.allow);
}
