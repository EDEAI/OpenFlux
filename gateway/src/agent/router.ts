/**
 * Agent Router - Intent Router
 * Analyze user intentions through lightweight LLM calls and automatically dispatch to the appropriate Agent
 */

import type { LLMProvider } from '../llm/provider';
import type { AgentConfig } from '../config/schema';
import { Logger } from '../utils/logger';
import {
    isStandalonePresentationCreationRequest,
    requiresTabularDataAnalysis,
    PRESENTATION_AGENT_ID,
    type PresentationInputAttachment,
} from './presentation-agent';
import { agentToolPolicyAdmits } from '../tools/policy';

const log = new Logger('AgentRouter');

/**
 * Agent routing results
 */
export interface RouteResult {
    /** Selected Agent ID */
    agentId: string;
    /** Routing reasons */
    reason: string;
    /** Whether LLM is used (false means the fast path is taken) */
    usedLLM: boolean;
}

/**
 * Route Prompt Template
 * Only the agent's id + name + description is passed, and the token overhead is extremely low
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
3. Return only the id string, without quotes or other formatting
4. Select only from the Available Agents above; never invent a dedicated Agent id that is not listed
5. AI image generation (text-to-image, posters, illustrations, logos, effect renders) → image agent when available
6. Video generation or social-video composition → the best available general/media-capable Agent based on its description
7. Code/script-based drawing (PIL, matplotlib, HTML mockups) → coder agent
8. Standalone PPTX/PDF, presentation, pitch-deck, or slide-deck creation → presentation agent when available
9. Editing the currently open PowerPoint through an Office add-in is not standalone creation
10. Do not route image/video/presentation generation to coder merely because implementation tools are involved.`;
}

/**
 * Subsequent command detection mode
 * Chinese: also, continue, just now, that, above, not, you see, again, next, the same
 * English: also, continue, that, same, again, keep, follow up
 */
const FOLLOW_UP_PATTERNS = /^(你也|也帮|也查|也搜|也看|继续|刚才|那个|上面|不是|你看|再|接着|同样|还有|另外|那|对了|also|continue|that|same|again|keep|follow|and also|what about)/i;

/**
 * Quick path detection
 * Some obvious intents can be routed directly without calling LLM
 */
/** An Agent that can both query a workbook and drive the deck state machine.
 * The default Agent wins when it qualifies, so routing stays predictable. */
function pickDataCapablePresentationAgent(
    agents: AgentConfig[],
    presentationAgentId: string,
): AgentConfig | undefined {
    const qualifies = (agent: AgentConfig): boolean => agent.id !== presentationAgentId
        && agentToolPolicyAdmits(agent.tools, 'office')
        && agentToolPolicyAdmits(agent.tools, 'generate_presentation');
    return agents.find(agent => agent.default && qualifies(agent)) || agents.find(qualifies);
}

function quickRoute(
    input: string,
    agents: AgentConfig[],
    lastAgentId?: string,
    attachments: PresentationInputAttachment[] = [],
): RouteResult | null {
    const lower = input.toLowerCase().trim();
    const presentationAgent = agents.find(agent => agent.id === PRESENTATION_AGENT_ID);
    const explicitPresentationCreation = presentationAgent
        ? isStandalonePresentationCreationRequest(input)
        : false;

    // Session stickiness: If an Agent was used in the previous round and the current input is a subsequent command, it will be used.
    // An explicit standalone deck request may switch away from the previous
    // Agent; a bare "continue" remains sticky.
    if (lastAgentId
        && FOLLOW_UP_PATTERNS.test(input.trim())
        && !(explicitPresentationCreation && lastAgentId !== PRESENTATION_AGENT_ID)) {
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

    // Keep deck delivery deterministic. Otherwise the generic phrase
    // "document generation" in a coding Agent description can steal PPT work
    // before the dedicated Agent ever receives its state-machine contract.
    if (presentationAgent && explicitPresentationCreation) {
        // One exception: a deck whose facts live in a workbook. The presentation
        // Agent has no spreadsheet tool, so it can only see the rows a text
        // extractor returns and has to fill the rest from nothing. Hand the task
        // to an Agent that can query the data and still build the deck — the
        // state-machine contract is injected from request intent, not from Agent
        // identity, so it applies there too.
        const analysisAgent = requiresTabularDataAnalysis(input, attachments)
            && !agentToolPolicyAdmits(presentationAgent.tools, 'office')
            ? pickDataCapablePresentationAgent(agents, presentationAgent.id)
            : undefined;
        return analysisAgent
            ? {
                agentId: analysisAgent.id,
                reason: 'Presentation task sourced from spreadsheet data',
                usedLLM: false,
            }
            : {
                agentId: presentationAgent.id,
                reason: 'Standalone presentation creation task',
                usedLLM: false,
            };
    }

    // Keyword quick routing → image agent (AI text-to-image / image-to-image)
    const imageAgent = agents.find(a => a.id === 'image');
    if (imageAgent) {
        const trimmed = input.trim();
        if (/^(generate_image|image_gen)\b/i.test(trimmed)) {
            return {
                agentId: imageAgent.id,
                reason: 'Explicit image generation tool request',
                usedLLM: false,
            };
        }
        const imageKeywords = /文生图|AI绘画|画图|绘图|生成.*(?:图|海报|插画|封面|效果图)|效果图|海报|插画|封面图|图标设计|logo.*生成|按.*描述.*图|text-to-image|image-to-image|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|draw\s+(?:an?\s+)?(?:image|picture|poster|illustration)|dall-?e|midjourney|stable\s*diffusion/i;
        if (imageKeywords.test(input)) {
            return {
                agentId: imageAgent.id,
                reason: 'Keyword matched to AI image generation task',
                usedLLM: false,
            };
        }
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
 * Build a localized "matched agent" message based on language code
 */
function buildMatchedReason(agentName: string, language?: string): string {
    const lang = language || 'zh-CN';
    if (lang.startsWith('zh')) {
        return `已为您匹配「${agentName}」`;
    }
    // All other languages → English
    return `Matched to "${agentName}"`;
}

/**
 * Analyze user intent through LLM and route to the appropriate Agent
 *
 * @param input user input
 * @param agents Agent configuration list
 * @param llm LLM Provider (for intent analysis)
 * @param lastAgentId Agent ID used in the last round (for session stickiness)
 * @param language BCP-47 language code (e.g. "zh-CN", "en")
 */
export async function routeToAgent(
    input: string,
    agents: AgentConfig[],
    llm: LLMProvider,
    lastAgentId?: string,
    language?: string,
    attachments?: PresentationInputAttachment[],
): Promise<RouteResult> {
    // Fast path (including session stickiness detection)
    const quick = quickRoute(input, agents, lastAgentId, attachments);
    if (quick) {
        log.debug(`Quick route: ${quick.agentId} (${quick.reason})`);
        return quick;
    }

    const defaultAgent = agents.find(a => a.default) || agents[0];

    try {
        // LLM intent analysis (including stickiness hint)
        let prompt = buildRouterPrompt(agents);
        if (lastAgentId) {
            prompt += `\n4. The previous turn used Agent "${lastAgentId}". If the current message appears to be a follow-up, continuation, or correction of the previous task, prefer "${lastAgentId}" unless the intent clearly changes domain.`;
        }

        const response = await llm.chat([
            { role: 'system', content: prompt },
            { role: 'user', content: input },
        ]);

        // Parse the agentId returned by LLM
        const responseId = response.trim().replace(/['"]/g, '');
        const matched = agents.find(a => a.id === responseId);

        if (matched) {
            log.info(`LLM routed to: ${matched.id} (${matched.name || matched.id})`);
            return {
                agentId: matched.id,
                reason: buildMatchedReason(matched.name || matched.id, language),
                usedLLM: true,
            };
        }

        // LLM returned an invalid ID -> fallback to default
        log.warn(`LLM returned invalid Agent ID: "${responseId}", falling back to default`);
        return {
            agentId: defaultAgent.id,
            reason: `LLM returned invalid ID "${responseId}", falling back to default`,
            usedLLM: true,
        };

    } catch (error) {
        // LLM call failed -> fall back to default
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error(`Router LLM call failed: ${errorMsg}, falling back to default`);
        return {
            agentId: defaultAgent.id,
            reason: `Routing failed: ${errorMsg}`,
            usedLLM: false,
        };
    }
}
