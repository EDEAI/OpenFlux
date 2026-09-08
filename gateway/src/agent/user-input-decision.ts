import type { ChatWithToolsResponse, LLMContentPart, LLMMessage } from '../llm/provider';
import { estimateMessageTokens } from './context-budget';

export const MAX_USER_INPUT_DECISION_TOKENS = 12_000;

export interface UserInputDecisionContext {
    input: string;
    history?: LLMMessage[];
    contentParts?: LLMContentPart[];
    historyComplete?: boolean;
    globalSystemPrompt?: string;
    systemPrompt?: string;
    memoryContext?: string;
    language?: string;
}

function decisionInstructions(language?: string): string {
    const isZh = !language || language.toLowerCase().startsWith('zh');
    return isZh
        ? `[User input decision]\n这是一个独立的需求判断步骤，不是执行或回答任务。只判断：是否缺少一项由用户决定、且不同答案会明显改变用户当前所要交付结果的关键信息。
例如，用户要一个学习工具的初步功能或产品建议，但尚未说明用于自己学习、教学还是对外提供产品；如果不同用途会改变首版功能重点，就先澄清用途，再给建议。通常说“有什么建议”并不等于明确要求列举所有方向或广泛脑暴；只有用户的语义明确表达了探索多种方向而暂不做具体取舍，才按广泛脑暴直接继续。如果会话或记忆已经明确用途，则使用已知用途，不重复提问。
结合完整会话和已知信息判断；已经回答的不要再问。用户只要建议或讨论时，判断当前建议所需的信息，不提前收集实施细节。若用户已经说明用途、委托你自行决定、只要广泛脑暴，或问题很简单，直接进入执行。能从文件、代码、文档或其他工具查到的信息也应先进入执行，不向用户索取这些信息。不要按任务关键词机械提问，也不要把提问作为每项任务的必经步骤。
如果确实缺少无法合理推迟、会改变当前结果的用户决策，只调用一次 request_user_input，默认仅提出最必要的一题；题目提供2–3个明确选项和自填入口，用 questions_json 传完整数组。不要请求权限或执行批准，不要自动选答案。
否则只输出 CONTINUE。不提供方案、不回答原任务、不复述本步骤，不调用其他工具。返回 CONTINUE 后另一个完整执行步骤会使用所有工具继续；你不是因为当前看不到文件或工具就需要向用户提问。`
        : `[User input decision]\nThis is a separate requirements decision step, not task execution or an answer. Decide only whether a missing user-owned decision would materially change the deliverable requested right now.
For example, initial feature or product advice for a learning tool may differ substantially between personal learning, teaching, and a product for other users. If that purpose is unresolved and changes first-version priorities, clarify the purpose before recommending features. A general request for suggestions does not itself mean the user explicitly wants every possible direction or broad brainstorming; treat it that way only when their meaning clearly requests exploring multiple directions without making a specific choice yet. If conversation or memory already establishes the purpose, use it without asking again.
Use the complete conversation and known information; never repeat answered questions. For advice or discussion, consider only what changes the current advice, not premature implementation details. Continue when purpose is already clear, the user delegates choices, requests broad brainstorming, or asks a simple question. Facts discoverable from files, code, documents or other tools should also proceed to execution instead of being asked of the user. Do not decide by task keywords or treat clarification as mandatory.
If a material user decision truly cannot be reasonably deferred, call request_user_input exactly once, normally asking only the single most necessary question with two or three concrete options and custom input allowed. Encode the complete array in questions_json. Never request permission or approval, and never choose an answer for the user.
Otherwise output only CONTINUE. Do not propose a solution, answer the task, repeat these instructions, or call other tools. A complete execution step with all tools follows CONTINUE; missing access to those tools in this decision step is not a reason to question the user.`;
}

/** Never shorten history for a decision: a missing old answer is worse than skipping this step. */
export function buildUserInputDecisionMessages(context: UserInputDecisionContext): LLMMessage[] | undefined {
    if (context.historyComplete === false) return undefined;
    const history = context.history || [];
    if (context.contentParts?.some(part => part.type !== 'text') || history.some(message =>
        (message.role !== 'user' && message.role !== 'assistant')
        || message.toolCalls?.length || message.toolCallId
        || message.contentParts?.some(part => part.type !== 'text')
        || /^\[(?:Earlier conversation archive|Previous conversation summary|系统提示：为适应模型上下文限制)/.test(message.content))) return undefined;
    const contextualInstructions = [
        context.globalSystemPrompt,
        context.systemPrompt,
        context.memoryContext,
        decisionInstructions(context.language),
    ].filter(Boolean).join('\n\n');
    const messages: LLMMessage[] = [
        { role: 'system', content: contextualInstructions },
        ...history.map(message => ({
            role: message.role, content: message.content,
            ...(message.contentParts?.length ? { contentParts: message.contentParts.map(part => ({ ...part })) } : {}),
        })),
        { role: 'user', content: context.input,
            ...(context.contentParts?.length ? { contentParts: context.contentParts.map(part => ({ ...part })) } : {}),
        },
    ];
    if (messages.reduce((sum, message) => sum + estimateMessageTokens(message).text, 0) > MAX_USER_INPUT_DECISION_TOKENS) return undefined;
    return messages;
}

/** Only a single real clarification call is executable; all probe prose stays private. */
export function userInputDecisionToolResponse(response: ChatWithToolsResponse): ChatWithToolsResponse | undefined {
    if (response.toolCalls.length !== 1 || response.toolCalls[0].name !== 'request_user_input') return undefined;
    return { content: '', toolCalls: response.toolCalls, reasoningContent: response.reasoningContent };
}
