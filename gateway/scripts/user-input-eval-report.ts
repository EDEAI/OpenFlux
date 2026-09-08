import type { PlanQuestion } from '../src/work/types';
import type { UserInputMessage } from '../src/gateway/user-input-coordinator';

// A typed constant makes a future protocol rename a compile error, not a silent zero count.
const ANSWER_KIND: UserInputMessage['metadata']['kind'] = 'user_input_answer';

function topicsFromText(text: string): string[] {
    return [
        ['audience_purpose', /用途|给谁|面向|自用|自己.{0,5}用|他人|别人|目标用户|用户群|产品定位|purpose|audience/i],
        ['skill_level', /水平|基础|初学|入门|进阶|学琴|琴龄|练琴.{0,4}年|skill level|beginner/i],
        ['practice_goal', /练习.{0,4}(目标|重点|方向)|节奏|换把|音准|技巧|训练.{0,4}(重点|方向)|practice goal/i],
        // "综合训练平台" describes product scope, not an unanswered technical platform.
        ['platform', /运行平台|使用平台|开发平台|什么平台|平台选择|平台.{0,6}使用|浏览器|网页|手机|Windows|macOS|桌面应用|操作系统|platform/i],
        ['technology', /技术栈|编程语言|框架|React|Python|TypeScript|technology/i],
        ['time_budget', /每天|分钟|时长|时间安排|minutes|daily/i],
    ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([name]) => name as string);
}

export function questionTopics(question: PlanQuestion): string[] {
    return topicsFromText(`${question.prompt} ${question.options.map(option => `${option.label} ${option.description}`).join(' ')}`);
}

export function finalQuestions(output: string): string[] {
    return output.slice(-900).split('\n').filter(line => /[?？]/.test(line)
        && /你|您|请告诉|倾向|希望|水平|技术栈|which|would you|do you|prefer/i.test(line)).slice(-3);
}

export function assessFollowUpQuestions(
    turn: { questions: Array<{ topics: string[] }>; tailQuestionsHeuristic: string[] },
    answeredTopics: ReadonlySet<string>,
): { repeatedTopicsHeuristic: string[]; routineFollowUpOffersHeuristic: string[] } {
    const routine = turn.tailQuestionsHeuristic.filter(line => /需要吗|需要我|要不要我|我可以帮你|如果你.{0,20}我可以|would you like me|shall I|do you want me/i.test(line));
    // Keep routine "shall I continue?" offers separate from asking for an
    // already answered requirement. Plain-text requirement questions still count.
    const questionTopics = turn.tailQuestionsHeuristic.filter(line => !routine.includes(line)).flatMap(topicsFromText);
    const repeated = [...new Set([...turn.questions.flatMap(question => question.topics), ...questionTopics])].filter(topic => answeredTopics.has(topic));
    return { repeatedTopicsHeuristic: repeated, routineFollowUpOffersHeuristic: routine };
}

export function countAnswerMessages(messages: Array<{ role: string; metadata?: Record<string, unknown> }>): number {
    return messages.filter(message => message.role === 'user' && message.metadata?.kind === ANSWER_KIND).length;
}

export function toolErrorSummary(result: unknown, redact: (text: string, limit?: number) => string): { code?: string; message?: string } {
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const error = record.error;
    const summary: { code?: string; message?: string } = {};
    if (typeof record.code === 'string') summary.code = redact(record.code, 80);
    if (typeof error === 'string') summary.message = redact(error, 400);
    else if (error instanceof Error) summary.message = redact(error.message, 400);
    if (!summary.message) summary.message = 'Tool failed without error details.';
    return summary;
}
