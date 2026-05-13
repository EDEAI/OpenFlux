/**
 * Skill Forge — L2 技能锻造分析器
 * 对话完成后分析对话内容，检测可复用模式，生成技能建议
 * 支持：新建技能 / 升级相似技能 / 跳过重复
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
    /** 唯一 ID（新建时生成；升级时为已有技能 ID） */
    id: string;
    /** 技能标题 */
    title: string;
    /** 技能内容（Markdown prompt） */
    content: string;
    /** 分类标签 */
    category: string;
    /** LLM 给出的推荐理由 */
    reasoning: string;
    /** 是否为升级建议（而非新建） */
    isUpgrade?: boolean;
    /** 被升级的已有技能 ID */
    upgradeTargetId?: string;
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
    /** 用户语言（BCP-47，如 zh-CN / en），技能内容用此语言生成 */
    language?: string;
    /** 建议回调 */
    onSuggestion?: (suggestion: ForgeSuggestion) => void;
}

// ========================
// Prompt 构建
// ========================

function buildForgePrompt(
    language?: string,
    existingSkills?: Array<{ id: string; title: string; category: string; reasoning: string; content: string }>,
): string {
    const langMap: Record<string, string> = {
        'zh-CN': 'Simplified Chinese (简体中文)',
        'zh-TW': 'Traditional Chinese (繁體中文)',
        'en':    'English',
        'ja':    'Japanese (日本語)',
        'ko':    'Korean (한국어)',
    };
    const langLabel = langMap[language ?? ''] ?? 'the same language as the user conversation';

    let existingSection = '';
    if (existingSkills && existingSkills.length > 0) {
        existingSection = `\n## Existing Forged Skills\nThe following skills have already been saved. When deciding whether to upgrade, you MUST read the full content of each skill below:\n${existingSkills.map(s => [
            `### [${s.id}] ${s.title} (${s.category})`,
            `> Reasoning: ${s.reasoning.slice(0, 120)}`,
            '```',
            s.content.slice(0, 600),
            '```',
        ].join('\n')).join('\n\n')}\n`;
    }

    return `You are a skill extraction analyst. Your job is to analyze a completed conversation between a user and an AI assistant, and determine if there is a **reusable skill pattern** worth saving.

A "skill" is a piece of domain knowledge, workflow, or best practice that can be injected as context into future conversations to make the AI more capable in that specific area.

## Language Requirement
IMPORTANT: You MUST write the skill title, content, category label, and reasoning entirely in **${langLabel}**. Do not use any other language.
${existingSection}
## Rules
1. Only recommend forging a skill if the conversation demonstrates a CLEAR, REUSABLE pattern
2. The skill should be generally useful across multiple future conversations, not just a one-off task
3. Do NOT recommend trivial skills (e.g., "how to say hello")
4. The skill content should be a concise, actionable prompt snippet (Markdown), NOT a conversation summary
5. **Similarity check**: If the new skill is semantically similar (covers the same domain/workflow) as an EXISTING skill, recommend an UPGRADE instead of creating a duplicate
6. **Upgrade constraint (CRITICAL)**: When action=upgrade, the new skill.content MUST be a strict SUPERSET of the original skill content:
   - ALL instructions, rules, and steps from the original MUST be preserved verbatim or equivalently
   - You may only ADD new knowledge/steps derived from the new conversation
   - You may NEVER remove, weaken, or contradict any part of the original content
   - If you cannot safely merge without removing something, choose action=forge_new instead

## Output Format
Respond with a JSON object (no markdown code fences):
{
  "action": "forge_new" | "upgrade" | "skip",
  "upgradeTargetId": "existing-skill-id-if-action-is-upgrade",
  "skill": {
    "title": "short title for the skill",
    "content": "The actual skill content in Markdown that will be injected as system prompt context",
    "category": "one of: coding, data, writing, automation, analysis, design, devops, other",
    "reasoning": "Brief explanation of why this is a reusable skill (or why it upgrades the existing one)"
  }
}

- action=forge_new: new skill, not similar to any existing
- action=upgrade: semantically similar to an existing skill; upgradeTargetId must be the id of the most similar existing skill; skill.content should be a MERGED/IMPROVED version combining both
- action=skip: conversation has no reusable pattern, or exact duplicate exists

If action is skip, set skill to null.`;
}

// ========================
// SkillForge
// ========================

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
        // 1. 前置过滤
        if (!this.shouldAnalyze(messages, loopResult)) {
            return null;
        }

        // 2. 取出已有锻造技能（带实际 content，让 LLM 做精准相似度判断）
        const existingSkillsMeta = this.config.dataManager.listForgedSkills();
        const existingSkills = existingSkillsMeta.map(s => ({
            id: s.id,
            title: s.title,
            category: s.category,
            reasoning: s.reasoning,
            content: this.config.dataManager.readForgedSkillContent(s.id) ?? '',
        }));

        // 3. 调用 LLM 分析
        try {
            const summary = this.buildConversationSummary(messages, loopResult);
            log.info('Analyzing conversation for skill forging...');
            const forgePrompt = buildForgePrompt(this.config.language, existingSkills);
            const analysisMessages: LLMMessage[] = [
                { role: 'system', content: forgePrompt },
                { role: 'user', content: summary },
            ];
            const response = await this.config.llm.chat(analysisMessages);

            // 4. 解析 LLM 响应
            const result = this.parseLLMResponse(response);
            if (!result || result.action === 'skip' || !result.skill) {
                log.debug('No forge-worthy pattern detected');
                return null;
            }

            // 5. 升级路径：LLM 认为与已有技能相似
            if (result.action === 'upgrade' && result.upgradeTargetId) {
                const target = existingSkillsMeta.find(s => s.id === result.upgradeTargetId);
                if (target) {
                    const suggestion: ForgeSuggestion = {
                        id: result.upgradeTargetId,   // 目标 ID 即已有技能 ID
                        title: result.skill.title,
                        content: result.skill.content,
                        category: result.skill.category,
                        reasoning: result.skill.reasoning,
                        isUpgrade: true,
                        upgradeTargetId: result.upgradeTargetId,
                    };
                    log.info(`Skill upgrade suggestion: "${target.title}" → "${suggestion.title}"`);
                    this.config.onSuggestion?.(suggestion);
                    return suggestion;
                }
            }

            // 6. 新建路径：完全重复则跳过
            const isDuplicate = existingSkillsMeta.some(
                s => s.category === result.skill!.category && s.title === result.skill!.title,
            );
            if (isDuplicate) {
                log.debug(`Exact duplicate skill detected: "${result.skill.title}", skipping`);
                return null;
            }

            // 7. 构造新建建议
            const suggestion: ForgeSuggestion = {
                id: `forge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                title: result.skill.title,
                content: result.skill.content,
                category: result.skill.category,
                reasoning: result.skill.reasoning,
            };

            log.info(`Skill forge suggestion: "${suggestion.title}" [${suggestion.category}]`);
            this.config.onSuggestion?.(suggestion);
            return suggestion;
        } catch (err) {
            log.error('Skill forge analysis failed:', err);
            return null;
        }
    }

    /**
     * 接受新建建议 → 保存为锻造技能（默认 disabled）
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
            enabled: false, // 默认禁用，需用户在「进化」tab 手动开启
        };

        this.config.dataManager.saveForgedSkill(suggestion.id, suggestion.content, meta);
        log.info(`Forged skill saved (disabled): "${suggestion.title}" (${suggestion.id})`);
        return meta;
    }

    /**
     * 接受升级建议 → 更新已有技能内容
     */
    upgradeSuggestion(suggestion: ForgeSuggestion): boolean {
        if (!suggestion.upgradeTargetId) return false;
        const ok = this.config.dataManager.upgradeForgedSkillContent(
            suggestion.upgradeTargetId,
            suggestion.content,
            suggestion.reasoning,
        );
        if (ok) {
            log.info(`Forged skill upgraded: "${suggestion.title}" (${suggestion.upgradeTargetId})`);
        }
        return ok;
    }

    // ========================
    // 内部方法
    // ========================

    /** 前置过滤 */
    private shouldAnalyze(messages: LLMMessage[], loopResult: AgentLoopResult): boolean {
        if (loopResult.toolCalls.length < this.minToolCalls) {
            log.debug(`Skipping forge analysis: only ${loopResult.toolCalls.length} tool calls (min: ${this.minToolCalls})`);
            return false;
        }
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
        parts.push('## Conversation Content');
        for (const msg of messages) {
            if (msg.role === 'user') {
                parts.push(`**User**: ${msg.content.substring(0, 500)}`);
            } else if (msg.role === 'assistant' && msg.content) {
                parts.push(`**Assistant**: ${msg.content.substring(0, 500)}`);
            }
        }
        parts.push('');
        parts.push('## Final Output');
        parts.push(loopResult.output.substring(0, 1000));
        return parts.join('\n');
    }

    /** 解析 LLM JSON 响应（兼容旧格式 shouldForge） */
    private parseLLMResponse(response: string): {
        action: 'forge_new' | 'upgrade' | 'skip';
        upgradeTargetId?: string;
        skill: { title: string; content: string; category: string; reasoning: string } | null;
    } | null {
        try {
            let json = response.trim();
            if (json.startsWith('```')) {
                json = json.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
            }
            const parsed = JSON.parse(json);
            // 兼容旧格式（shouldForge）
            if ('shouldForge' in parsed) {
                return {
                    action: parsed.shouldForge ? 'forge_new' : 'skip',
                    skill: parsed.skill ?? null,
                };
            }
            return parsed;
        } catch {
            log.warn('Failed to parse LLM forge response', { preview: response.substring(0, 200) });
            return null;
        }
    }
}
