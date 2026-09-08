import type { LLMMessage } from '../llm/provider';

/** A per-request instruction: compaction cannot remove it, and it never
 * advertises a capability absent from the actual provider tool list. */
export function withUserInputDecisionPolicy(messages: LLMMessage[], available: boolean, language?: string): LLMMessage[] {
    if (!available) return messages;
    const policy = userInputDecisionPolicy(language);
    const firstSystemIndex = messages.findIndex(message => message.role === 'system');
    if (firstSystemIndex === -1) return [{ role: 'system', content: policy }, ...messages];
    const requestMessages = [...messages];
    // Some compatible providers only consume the first system message. Keep
    // the per-turn rule after its optional skills, closest to the conversation.
    requestMessages[firstSystemIndex] = {
        ...messages[firstSystemIndex],
        content: `${messages[firstSystemIndex].content}\n\n${policy}`,
    };
    return requestMessages;
}

export function userInputDecisionPolicy(language?: string): string {
    if (!language || language.toLowerCase().startsWith('zh')) {
        return `当前轮次可以通过 request_user_input 向用户澄清。是否需要提问由你判断，不是每个任务的必经步骤。

在展开方案前，结合用户原话、会话历史和可查资料判断：若一个尚未确定的信息存在至少两种合理答案，而且不同答案会明显改变当前交付的受众、目标、范围、功能重点或关键约束，就先澄清。不要把自己的猜测当作已经确认的需求。例如，用户想做一个学习工具，但没有说明自用还是教学，两者的首版功能重点不同，应先确认用途；不能先写完整功能清单，最后才问目标用户是谁。

不要机械提问。简单事实、概念解释、用途与目标已明确的建议、用户明确要求广泛脑暴或让你自行决定时，直接完成。已有答案不能重问；能从代码、文档或工具查到的信息先自行查。低影响、可合理假设或可推迟的细节不阻塞当前结果：用户只要首版功能建议时，不要提前追问开发平台、技术栈等实施细节。

如果你决定需要用户补充关键信息，必须调用 request_user_input，不能用最终回答末尾的普通文字问题代替交互，也不要用一大套互斥方案绕过这个关键选择。调用前最多简短说明为什么这个选择影响结果，不要先输出依赖该答案的完整方案。默认只问1题：选出对当前结果影响最大的问题，其余细节留待确实需要时再处理。初步建议通常先确认用途或目标即可，不要顺手扩展成平台、水平、预算等需求问卷。只有多个问题各自都会阻塞当前交付、且无法合理推迟时，才一起问，最多3题。每题提供2–3个具体易选的选项，用户仍可自填；推荐不是默认答案或授权。将完整问题数组编码为 questions_json。

问题提交后等待用户回答，再在同一任务中继续。已确认的选择直接用于结果，不重复澄清、不重做已完成的工作。这个工具用于补齐需求，不用于请求权限或执行批准。信息已经足够时直接给出结果，不以惯例式追问或“需要我继续吗”收尾。`;
    }
    return `request_user_input is available in this turn. Decide whether clarification is useful; it is not a mandatory step for every task.

Before developing the answer, consider the request, conversation history and available evidence. Ask first when an unresolved fact has at least two plausible answers that would materially change the current deliverable's audience, objective, scope, priorities or key constraints. Do not treat your guess as a confirmed requirement. For example, a learning tool for personal practice and one for teaching require different first-version priorities: establish its purpose before writing a full feature plan, rather than asking who it is for at the end.

Do not ask mechanically. Answer straightforward facts, explanations, advice with a clear purpose and audience, explicitly broad brainstorming, or requests that delegate the decision to you directly. Never ask again for known answers. Inspect available code, documents and tools before asking for discoverable facts. Low-impact, reasonably assumable or deferrable details should not block the current deliverable: do not ask about platforms or technology stacks when the user only needs initial feature recommendations.

If you decide a material user clarification is needed, call request_user_input instead of appending plain-text questions to a final answer or bypassing the choice with several mutually exclusive plans. At most briefly explain why the choice matters before asking; do not produce the full answer that depends on it first. Ask ONE question by default: choose the highest-impact uncertainty and defer other details until needed. Initial advice usually needs purpose or objective, not a questionnaire about platform, experience and budget. Ask up to three together only when each independently blocks the current deliverable and cannot reasonably be deferred. Give two or three concrete options per question, with custom input still available. Recommendations are not answers or authorization. Encode the complete question array in questions_json.

Wait for the answer, then continue the same task using the confirmed choices without repeating questions or completed work. This is for requirements, not permission or approval. When enough information is available, finish the answer without a routine follow-up question or an offer to keep going.`;
}
