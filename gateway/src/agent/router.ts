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
        .map(a => `- id: "${a.id}", name: "${a.name || a.id}", description: "${a.description || 'General assistant'}"`)
        .join('\n');

    return `You are a task classifier. Based on user input, select the most appropriate Agent to handle it.

Available Agents:
${agentList}

Rules:
1. Return only one Agent's id, nothing else
2. If unsure, return the default Agent's id
3. Return only the id string, without quotes or other formatting`;
}

/**
 * 后续指令检测模式
 * 中文：也、继续、刚才、那个、上面、不是、你看、再、接着、同样
 * 英文：also, continue, that, same, again, keep, follow up
 */
const FOLLOW_UP_PATTERNS = /^(你也|也帮|也查|也搜|也看|继续|刚才|那个|上面|不是|你看|再|接着|同样|还有|另外|那|对了|also|continue|that|same|again|keep|follow|and also|what about)/i;

/**
 * Quick path detection
 * Some obvious intents can be routed directly without calling LLM
 */
function quickRoute(input: string, agents: AgentConfig[], lastAgentId?: string): RouteResult | null {
    const lower = input.toLowerCase().trim();

    // Session stickiness: 如果上一轮使用了某个 Agent，且当前输入是后续指令，沿用
    if (lastAgentId && FOLLOW_UP_PATTERNS.test(input.trim())) {
        const lastAgent = agents.find(a => a.id === lastAgentId);
        if (lastAgent) {
            log.info(`Session sticky: reusing ${lastAgentId} (follow-up detected)`);
            return {
                agentId: lastAgentId,
                reason: 'session_sticky',
                usedLLM: false,
            };
        }
    }

    // Empty input or very short → default Agent
    if (lower.length < 5) {
        const defaultAgent = agents.find(a => a.default) || agents[0];
        return {
            agentId: defaultAgent.id,
            reason: 'Input too short, using default Agent',
            usedLLM: false,
        };
    }

    // Explicit Agent mention (user input "@agentId ...")
    const mentionMatch = input.match(/^@(\w+)\s+/);
    if (mentionMatch) {
        const mentionedId = mentionMatch[1];
        const matched = agents.find(a => a.id === mentionedId);
        if (matched) {
            return {
                agentId: matched.id,
                reason: `User explicitly specified @${matched.id}`,
                usedLLM: false,
            };
        }
    }

    // Only one Agent → use directly
    if (agents.length === 1) {
        return {
            agentId: agents[0].id,
            reason: 'Only one Agent available',
            usedLLM: false,
        };
    }

    // Keyword quick routing → automation agent
    const automationAgent = agents.find(a => a.id === 'automation');
    if (automationAgent) {
        const automationKeywords = /买|购|采购|下单|加入购物车|网购|搜索.*(?:价格|多少钱)|浏览器|打开网页|打开.*(?:淘宝|京东|拼多多|天猫|亚马逊)|自动化|定时任务|爬取|抓取|网页操作|填写表单|注册账号|登录网站|buy|purchase|order|add to cart|shopping|browse|open website|automat|schedule|crawl|scrape|web operation|fill form|register|login/i;
        if (automationKeywords.test(input)) {
            return {
                agentId: automationAgent.id,
                reason: 'Keyword matched to automation task',
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
 * @param lastAgentId 上一轮使用的 Agent ID（用于会话粘性）
 */
export async function routeToAgent(
    input: string,
    agents: AgentConfig[],
    llm: LLMProvider,
    lastAgentId?: string,
): Promise<RouteResult> {
    // 快速路径（含会话粘性检测）
    const quick = quickRoute(input, agents, lastAgentId);
    if (quick) {
        log.debug(`Quick route: ${quick.agentId} (${quick.reason})`);
        return quick;
    }

    const defaultAgent = agents.find(a => a.default) || agents[0];

    try {
        // LLM 意图分析（含 stickiness hint）
        let prompt = buildRouterPrompt(agents);
        if (lastAgentId) {
            prompt += `\n4. The previous turn used Agent "${lastAgentId}". If the current message appears to be a follow-up, continuation, or correction of the previous task, prefer "${lastAgentId}" unless the intent clearly changes domain.`;
        }

        const response = await llm.chat([
            { role: 'system', content: prompt },
            { role: 'user', content: input },
        ]);

        // 解析 LLM 返回的 agentId
        const responseId = response.trim().replace(/['"]/g, '');
        const matched = agents.find(a => a.id === responseId);

        if (matched) {
            log.info(`LLM routed to: ${matched.id} (${matched.name || matched.id})`);
            return {
                agentId: matched.id,
                reason: `已为您匹配「${matched.name || matched.id}」`,
                usedLLM: true,
            };
        }

        // LLM 返回了无效 ID → 回退默认
        log.warn(`LLM returned invalid Agent ID: "${responseId}", falling back to default`);
        return {
            agentId: defaultAgent.id,
            reason: `LLM returned invalid ID "${responseId}", falling back to default`,
            usedLLM: true,
        };

    } catch (error) {
        // LLM 调用失败 → 回退默认
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Router LLM call failed: ${errorMsg}, falling back to default`);
        return {
            agentId: defaultAgent.id,
            reason: `Routing failed: ${errorMsg}`,
            usedLLM: false,
        };
    }
}
