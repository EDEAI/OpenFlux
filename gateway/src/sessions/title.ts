/**
 * Background session titles.
 *
 * The sidebar gets a title the moment the user speaks, by truncating what they
 * wrote. That is instant but blunt: a long request becomes its own first clause
 * plus an ellipsis. This module races a short summary against the turn and hands
 * back something readable, which the caller swaps in if it arrives.
 */

import type { LLMProvider } from '../llm/provider';
import { Logger } from '../utils/logger';

const log = new Logger('SessionTitle');

/** Long enough to name a task, short enough for the sidebar to show it whole. */
const MAX_TITLE_CHARS = 20;

const TITLE_PROMPT = [
    'Name this task the way a person would label a folder for it.',
    'Reply with the label alone: no quotes, no punctuation at the end, no explanation, no prefix such as "Title:".',
    `Keep it under ${MAX_TITLE_CHARS} characters. Write it in the language the user wrote in.`,
    'Name the subject and the deliverable, not the act of asking. "Q3 销售数据分析PPT", not "用户想要一份PPT".',
].join(' ');

/** Strip the wrappers a model adds around a label it was asked to give bare. */
export function cleanSessionTitle(raw: string): string {
    // A label is one line. Anything multi-line is the model talking, not naming,
    // and this has to be checked before the whitespace collapse hides it.
    if (raw.trim().includes('\n')) return '';
    let title = raw.replace(/\s+/g, ' ').trim();
    // Models often answer a naming request as "标题：X" or with the label quoted.
    title = title.replace(/^(?:title|标题|会话标题|名称)\s*[:：]\s*/i, '').trim();
    title = title.replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/g, '').trim();
    title = title.replace(/[。.!！?？,，;；:：]+$/g, '').trim();
    // A model that explains itself instead of naming the task is not usable as a
    // label, and truncating its prose would read worse than the request itself.
    if (title.length > MAX_TITLE_CHARS * 2) return '';
    return title.slice(0, MAX_TITLE_CHARS);
}

/**
 * Summarize a request into a sidebar label, or return nothing.
 *
 * Never throws: a title is a convenience, and a turn must not fail or slow down
 * because naming it did.
 */
export async function generateSessionTitle(
    llm: LLMProvider,
    input: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const request = input.replace(/\s+/g, ' ').trim();
    if (!request) return undefined;
    try {
        const response = await llm.chat([
            { role: 'system', content: TITLE_PROMPT },
            // A very long request costs tokens without naming itself any better.
            { role: 'user', content: request.slice(0, 2000) },
        // A label needs a handful of tokens, but a thinking model spends its
        // reasoning from the same budget and returns nothing if it runs out.
        ], { maxTokens: 1024, signal });
        return cleanSessionTitle(String(response || '')) || undefined;
    } catch (error) {
        log.debug('会话标题摘要失败，保留截断标题', { error: String(error) });
        return undefined;
    }
}
