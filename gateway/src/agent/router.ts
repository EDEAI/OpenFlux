/**
 * Agent Router - 意图路由器
 * 通过轻量 LLM 调用分析用户意图，自动分派到合适的 Agent
 */

import type { LLMProvider } from '../llm/provider';
import type { AgentConfig } from '../config/schema';
import { Logger } from '../utils/logger';

const log = new Logger('AgentRouter');

/**
 * Agent 路由结果
 */
export interface RouteResult {
    /** 选中的 Agent ID */
    agentId: string;
    /** 路由原因 */
    reason: string;
    /** 是否使用了 LLM（false 表示走了快速路径） */
    usedLLM: boolean;
}

/**
 * 路由 Prompt 模板
 * 只传 agent 的 id + name + description，token 开销极低
 */
function buildRouterPrompt(agents: AgentConfig[]): string {
    const agentList = agents
        .map(a => `- id: "${a.id}", name: "${a.name || a.id}", description: "${a.description || '通用助手'}"`)
        .join('\n');

    return `你是一个任务分类器。根据用户输入，选择最合适的 Agent 来处理。

可用的 Agent：
${agentList}

规则：
1. 只返回一个 Agent 的 id，不要返回其他内容
2. 如果不确定，返回默认 Agent 的 id
3. 只返回 id 字符串，不要加引号或其他格式`;
}

/**
 * 快速路径检测
 * 某些明显的意图可以直接路由，无需调用 LLM
 */
function quickRoute(input: string, agents: AgentConfig[]): RouteResult | null {
    const lower = input.toLowerCase().trim();

    // 空输入或纯聊天（很短且无明显工具意图）→ 默认 Agent
    if (lower.length < 5) {
        const defaultAgent = agents.find(a => a.default) || agents[0];
        return {
            agentId: defaultAgent.id,
            reason: '输入过短，使用默认 Agent',
            usedLLM: false,
        };
    }

    // 显式指定 Agent（用户输入 "@agentId ..."）
    const mentionMatch = input.match(/^@(\w+)\s+/);
    if (mentionMatch) {
        const mentionedId = mentionMatch[1];
        const matched = agents.find(a => a.id === mentionedId);
        if (matched) {
            return {
                agentId: matched.id,
                reason: `用户显式指定 @${matched.id}`,
                usedLLM: false,
            };
        }
    }

    // 只有一个 Agent → 直接使用
    if (agents.length === 1) {
        return {
            agentId: agents[0].id,
            reason: '仅有一个 Agent',
            usedLLM: false,
        };
    }

    // 关键词快速路由 → automation agent
    const automationAgent = agents.find(a => a.id === 'automation');
    if (automationAgent) {
        const automationKeywords = /买|购|采购|下单|加入购物车|网购|搜索.*(?:价格|多少钱)|浏览器|打开网页|打开.*(?:淘宝|京东|拼多多|天猫|亚马逊)|自动化|定时任务|爬取|抓取|网页操作|填写表单|注册账号|登录网站/;
        if (automationKeywords.test(input)) {
            return {
                agentId: automationAgent.id,
                reason: '关键词快速匹配到自动化任务',
                usedLLM: false,
            };
        }
    }

    return null;
}

/**
 * 通过 LLM 分析用户意图，路由到合适的 Agent
 *
 * @param input 用户输入
 * @param agents Agent 配置列表
 * @param llm LLM Provider（用于意图分析）
 */
export async function routeToAgent(
    input: string,
    agents: AgentConfig[],
    llm: LLMProvider
): Promise<RouteResult> {
    // 快速路径
    const quick = quickRoute(input, agents);
    if (quick) {
        log.debug(`快速路由: ${quick.agentId} (${quick.reason})`);
        return quick;
    }

    const defaultAgent = agents.find(a => a.default) || agents[0];

    try {
        // LLM 意图分析
        const prompt = buildRouterPrompt(agents);
        const response = await llm.chat([
            { role: 'system', content: prompt },
            { role: 'user', content: input },
        ]);

        // 解析 LLM 返回的 agentId
        const responseId = response.trim().replace(/['"]/g, '');
        const matched = agents.find(a => a.id === responseId);

        if (matched) {
            log.info(`LLM 路由: ${matched.id} (${matched.name || matched.id})`);
            return {
                agentId: matched.id,
                reason: `LLM 分析选择 "${matched.name || matched.id}"`,
                usedLLM: true,
            };
        }

        // LLM 返回了无效 ID → 回退默认
        log.warn(`LLM 返回无效 Agent ID: "${responseId}"，回退默认`);
        return {
            agentId: defaultAgent.id,
            reason: `LLM 返回无效 ID "${responseId}"，回退默认`,
            usedLLM: true,
        };

    } catch (error) {
        // LLM 调用失败 → 回退默认
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`路由 LLM 调用失败: ${errorMsg}，回退默认`);
        return {
            agentId: defaultAgent.id,
            reason: `路由失败: ${errorMsg}`,
            usedLLM: false,
        };
    }
}
