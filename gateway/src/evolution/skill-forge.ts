/**
 * Skill Forge — L2 技能锻造分析器
 * 对话完成后分析对话内容，检测可复用模式，生成技能建议
 */

import type { LLMProvider, LLMMessage } from '../llm/provider';
import type { EvolutionDataManager, ForgedSkillMeta } from './data-manager';
import type { AgentLoopResult } from '../agent/loop';
import { Logger } from '../utils/logger';

const log = new Logger('SkillForge');

// ========================
// 类型定义
// ========================

/** 技能锻造建议 */
export interface ForgeSuggestion {
    /** 唯一 ID */
    id: string;
    /** 技能标题 */
    title: string;
    /** 技能内容（Markdown prompt） */
    content: string;
    /** 分类标签 */
    category: string;
    /** LLM 给出的推荐理由 */
    reasoning: string;
}

/** 锻造分析器配置 */
export interface SkillForgeConfig {
    /** LLM Provider（用于分析） */
    llm: LLMProvider;
    /** 进化数据管理器 */
    dataManager: EvolutionDataManager;
    /** 最小工具调用次数（低于此值不分析） */
    minToolCalls?: number;
    /** 最小对话轮次（低于此值不分析） */
    minMessageRounds?: number;
    /** 建议回调 */
    onSuggestion?: (suggestion: ForgeSuggestion) => void;
}

// ========================
// 分析 Prompt
// ========================

const FORGE_ANALYSIS_PROMPT = `You are a skill extraction analyst. Your job is to analyze a completed conversation between a user and an AI assistant, and determine if there is a **reusable skill pattern** worth saving.

A "skill" is a piece of domain knowledge, workflow, or best practice that can be injected as context into future conversations to make the AI more capable in that specific area.

## Rules
1. Only recommend forging a skill if the conversation demonstrates a CLEAR, REUSABLE pattern
2. The skill should be generally useful across multiple future conversations, not just a one-off task
3. Do NOT recommend trivial skills (e.g., "how to say hello")
4. The skill content should be a concise, actionable prompt snippet (Markdown), NOT a conversation summary

## Output Format
Respond with a JSON object (no markdown code fences):
{
  "shouldForge": true/false,
  "skill": {
    "title": "short title for the skill",
    "content": "The actual skill content in Markdown that will be injected as system prompt context",
    "category": "one of: coding, data, writing, automation, analysis, design, devops, other",
    "reasoning": "Brief explanation of why this is a reusable skill"
  }
}

If shouldForge is false, set skill to null.`;

/**
 * 技能锻造分析器
 */
export class SkillForge {
    private config: SkillForgeConfig;
    private minToolCalls: number;
    private minMessageRounds: number;

    constructor(config: SkillForgeConfig) {
        this.config = config;
        this.minToolCalls = config.minToolCalls ?? 2;
        this.minMessageRounds = config.minMessageRounds ?? 3;
    }

    /**
     * 分析对话是否值得锻造技能
     * 异步执行，不阻塞主流程
     */
    async analyzeConversation(
        messages: LLMMessage[],
        loopResult: AgentLoopResult,
        sessionId?: string,
    ): Promise<ForgeSuggestion | null> {
        // 1. 前置过滤：不满足条件直接跳过
        if (!this.shouldAnalyze(messages, loopResult)) {
            return null;
        }

        // 2. 去重检查：已有同类别技能不再建议
        const existingSkills = this.config.dataManager.listForgedSkills();
        const existingCategories = new Set(existingSkills.map(s => s.category));

        // 3. 调用 LLM 分析
        try {
            const summary = this.buildConversationSummary(messages, loopResult);
            const analysisMessages: LLMMessage[] = [
                { role: 'system', content: FORGE_ANALYSIS_PROMPT },
                { role: 'user', content: summary },
            ];

            log.info('Analyzing conversation for skill forging...');
            const response = await this.config.llm.chat(analysisMessages);

            // 4. 解析 LLM 响应
            const result = this.parseLLMResponse(response);
            if (!result || !result.shouldForge || !result.skill) {
                log.debug('No forge-worthy pattern detected');
                return null;
            }

            // 5. 去重检查
            if (existingCategories.has(result.skill.category)) {
                // 同类别已有技能，检查标题相似度（简单做法：标题完全一致则跳过）
                const duplicate = existingSkills.find(
                    s => s.category === result.skill.category && s.title === result.skill.title,
                );
                if (duplicate) {
                    log.debug(`Duplicate skill detected: "${result.skill.title}", skipping`);
                    return null;
                }
            }

            // 6. 构造建议
            const suggestion: ForgeSuggestion = {
                id: `forge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                title: result.skill.title,
                content: result.skill.content,
                category: result.skill.category,
                reasoning: result.skill.reasoning,
            };

            log.info(`Skill forge suggestion: "${suggestion.title}" [${suggestion.category}]`);

            // 7. 通知回调
            if (this.config.onSuggestion) {
                this.config.onSuggestion(suggestion);
            }

            return suggestion;
        } catch (err) {
            log.error('Skill forge analysis failed:', err);
            return null;
        }
    }

    /**
     * 接受建议 → 保存为锻造技能
     */
    acceptSuggestion(suggestion: ForgeSuggestion, sessionId?: string): ForgedSkillMeta {
        const meta: ForgedSkillMeta = {
            id: suggestion.id,
            title: suggestion.title,
            category: suggestion.category,
            reasoning: suggestion.reasoning,
            createdAt: new Date().toISOString(),
            sourceSession: sessionId,
            hash: '',
        };

        this.config.dataManager.saveForgedSkill(suggestion.id, suggestion.content, meta);
        log.info(`Forged skill saved: "${suggestion.title}" (${suggestion.id})`);
        return meta;
    }

    // ========================
    // 内部方法
    // ========================

    /** 前置过滤 */
    private shouldAnalyze(messages: LLMMessage[], loopResult: AgentLoopResult): boolean {
        // 工具调用次数检查
        if (loopResult.toolCalls.length < this.minToolCalls) {
            log.debug(`Skipping forge analysis: only ${loopResult.toolCalls.length} tool calls (min: ${this.minToolCalls})`);
            return false;
        }

        // 对话轮次检查（user 消息数 >= minMessageRounds）
        const userMessages = messages.filter(m => m.role === 'user').length;
        if (userMessages < this.minMessageRounds) {
            log.debug(`Skipping forge analysis: only ${userMessages} user messages (min: ${this.minMessageRounds})`);
            return false;
        }

        return true;
    }

    /** 构建对话摘要（给 LLM 分析用） */
    private buildConversationSummary(messages: LLMMessage[], loopResult: AgentLoopResult): string {
        const parts: string[] = [];

        parts.push('## Conversation Summary');
        parts.push(`- Total iterations: ${loopResult.iterations}`);
        parts.push(`- Tool calls: ${loopResult.toolCalls.map(t => t.name).join(', ')}`);
        parts.push('');

        // 提取用户和助手消息（去掉 system 和 tool 消息节省 token）
        parts.push('## Conversation Content');
        for (const msg of messages) {
            if (msg.role === 'user') {
                parts.push(`**User**: ${msg.content.substring(0, 500)}`);
            } else if (msg.role === 'assistant' && msg.content) {
                parts.push(`**Assistant**: ${msg.content.substring(0, 500)}`);
            }
        }

        // 最终输出
        parts.push('');
        parts.push(`## Final Output`);
        parts.push(loopResult.output.substring(0, 1000));

        return parts.join('\n');
    }

    /** 解析 LLM JSON 响应 */
    private parseLLMResponse(response: string): {
        shouldForge: boolean;
        skill: { title: string; content: string; category: string; reasoning: string } | null;
    } | null {
        try {
            // 尝试直接解析
            let json = response.trim();

            // 去除 markdown 代码块包裹
            if (json.startsWith('```')) {
                json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            }

            return JSON.parse(json);
        } catch {
            log.warn('Failed to parse LLM forge response', { preview: response.substring(0, 200) });
            return null;
        }
    }
}
