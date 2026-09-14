import type { Tool, ToolExecutionContext } from './types';
import { validateUserInputQuestions } from '../work/user-input-store';

const DESCRIPTION = 'JSON-encoded array containing ONE highest-impact question by default. Up to 3 only if each independently blocks the current deliverable and cannot be deferred. Each question has id, prompt, kind (single|multiple), and exactly 2–3 options with id, label, description, optional recommended. Custom input is built into the UI: do not add an Other option. Example: [{"id":"scope","prompt":"Which scope?","kind":"single","options":[{"id":"pilot","label":"Pilot","description":"One region","recommended":true},{"id":"all","label":"Full rollout","description":"All regions"}]}]';

export function canRequestUserInput(context?: Pick<ToolExecutionContext, 'userInputControl' | 'workMode' | 'isScheduledTask' | 'parentSessionId'>): boolean {
    return !!context?.userInputControl && (!context.workMode || context.workMode === 'normal')
        && !context.isScheduledTask && !context.parentSessionId;
}

export function createRequestUserInputTool(): Tool {
    return {
        name: 'request_user_input',
        priority: 1,
        description: `Resolve a missing user decision BEFORE producing an answer that depends on it. Use when plausible answers would materially change the current audience, purpose, scope, priorities or constraints. If you decide to ask, use this interactive tool instead of placing the question at the end of a final answer. For initial recommendations, ask ONE question about the missing purpose or audience (for example, personal use versus teaching versus a public product). Do not add platform, technology stack, experience or budget questions unless they block what the user actually requested now. Do not ask about known or discoverable facts; proceed directly when information is sufficient, the user asks for broad brainstorming, or the user delegates the choice. This pauses until the user answers and is not a permission/approval tool. ${DESCRIPTION}`,
        parameters: { questions_json: { type: 'string', description: DESCRIPTION, required: true } },
        rawInputSchema: { type: 'object', additionalProperties: false, properties: { questions_json: { type: 'string', minLength: 2, description: DESCRIPTION } }, required: ['questions_json'] },
        async execute(args, context) {
            if (!canRequestUserInput(context)) throw new Error('User input is only available in an interactive normal session with a user input controller.');
            let value = args.questions;
            if (value === undefined) {
                if (typeof args.questions_json !== 'string' || !args.questions_json.trim()) throw new Error('questions_json must be a non-empty JSON string.');
                try { value = JSON.parse(args.questions_json); }
                catch { throw new Error('questions_json must contain valid JSON.'); }
            }
            const questions = validateUserInputQuestions(value);
            const result = await context!.userInputControl!.requestInput(questions);
            return { success: true, data: result, controlSignal: 'waiting_input' };
        },
    };
}
