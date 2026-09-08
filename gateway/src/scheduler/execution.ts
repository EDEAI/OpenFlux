export interface ScheduledAgentPromptInput {
    taskName: string;
    prompt: string;
    timeContext?: string;
    outputContext?: string;
    previousRunContext?: string;
}

/** Build the execution-only prompt for a scheduled Agent turn. */
export function buildScheduledAgentPrompt(input: ScheduledAgentPromptInput): string {
    return [
        `[系统指令] 这是定时任务「${input.taskName}」的自动触发执行。`,
        '请直接执行以下任务内容，并在本次最终回复中给出完整、可独立阅读的结果。',
        '不要只回复计划、过渡语、查询意图或“正在处理”；即使部分工具或来源不可用，也要说明限制并汇总已经取得的结果。',
        '严禁调用 scheduler 工具，不要创建新的定时任务。这已经是任务执行阶段。',
        '严禁调用 notify_user。系统会把最终回复写入任务绑定的会话，并按任务设置发送本地通知。',
        input.timeContext || '',
        input.outputContext || '',
        input.previousRunContext || '',
        '',
        `任务内容：${input.prompt}`,
    ].join('\n');
}

/** Treat a missing final reply as a failed run instead of recording a false success. */
export function requireScheduledFinalOutput(result: { status: string; output?: string }): string {
    const output = typeof result.output === 'string' ? result.output.trim() : '';
    if (result.status !== 'completed') {
        const detail = output ? `：${output.slice(0, 1200)}` : '';
        throw new Error(`Agent 未完成定时任务（${result.status}）${detail}`);
    }
    if (!output) {
        throw new Error('Agent 已结束执行，但没有生成可写入会话的最终回复');
    }
    return output;
}
