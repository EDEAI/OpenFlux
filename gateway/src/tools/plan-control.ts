import type { Tool, ToolExecutionContext, ToolResult } from './types';
import type { PlanDocument, PlanQuestion } from '../work/types';

const QUESTION_JSON_DESCRIPTION = [
    'JSON-encoded array of every question. Pass it as one string, not as nested tool arguments.',
    'Each question requires id, prompt, kind (single|multiple), and 2-3 options.',
    'Each option requires id, label, description; recommended is optional.',
    'Example: [{"id":"scope","prompt":"Which scope?","kind":"single","required":true,"allowOther":true,"options":[{"id":"pilot","label":"Pilot","description":"Start with one region","recommended":true},{"id":"full","label":"Full rollout","description":"Cover every region"}]}]',
].join(' ');

const DOCUMENT_JSON_DESCRIPTION = [
    'JSON-encoded plan document. Pass it as one string, not as nested tool arguments.',
    'Required fields: title, goal, confirmedDecisions, assumptions, inScope, outOfScope, steps, modules, dependencies, validation, risks, rollback, acceptanceCriteria.',
    'Every step requires id, title, description and may include modules, dependencies, validation arrays.',
].join(' ');

function requirePlanContext(context?: ToolExecutionContext): NonNullable<ToolExecutionContext['planControl']> {
    if (context?.workMode !== 'plan' || !context.planControl) {
        throw new Error('Plan control tools are only available inside an active plan turn.');
    }
    return context.planControl;
}

function parseJsonEnvelope(value: unknown, name: string): unknown {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${name} must be a non-empty JSON string. Retry with the complete payload encoded in ${name}.`);
    }
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`${name} must contain valid JSON. Retry with a shorter, complete JSON payload and no Markdown fences.`);
    }
}

function readQuestions(args: Record<string, unknown>): PlanQuestion[] {
    // Keep accepting the first implementation's structured form for stored
    // transcripts and providers that replay an older tool call.
    const value = args.questions ?? parseJsonEnvelope(args.questions_json, 'questions_json');
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('questions_json must decode to a non-empty array of complete question objects.');
    }
    if (value.some(question => !question || typeof question !== 'object' || Array.isArray(question))) {
        throw new Error('questions_json must decode to an array of question objects.');
    }
    if (value.some(question => {
        const record = question as Record<string, unknown>;
        return typeof record.id !== 'string' || !record.id.trim()
            || typeof record.prompt !== 'string' || !record.prompt.trim();
    })) {
        throw new Error('Every question needs a stable id and prompt. Retry with complete objects inside questions_json.');
    }
    return value as PlanQuestion[];
}

function readDocument(args: Record<string, unknown>): PlanDocument {
    const value = args.document ?? parseJsonEnvelope(args.document_json, 'document_json');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('document_json must decode to one complete plan document object.');
    }
    return value as PlanDocument;
}

export function createRequestPlanInputTool(): Tool {
    return {
        name: 'request_plan_input',
        priority: 1,
        description: `Pause the current plan turn and ask all material implementation questions in one request. ${QUESTION_JSON_DESCRIPTION}`,
        parameters: {
            questions_json: {
                type: 'string',
                description: QUESTION_JSON_DESCRIPTION,
                required: true,
            },
        },
        rawInputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                questions_json: { type: 'string', minLength: 2, description: QUESTION_JSON_DESCRIPTION },
            },
            required: ['questions_json'],
        },
        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const controller = requirePlanContext(context);
            const questions = readQuestions(args);
            const result = await controller.requestInput(questions);
            return { success: true, data: result, controlSignal: 'waiting_input' };
        },
    };
}

export function createPublishPlanDocumentTool(): Tool {
    return {
        name: 'publish_plan_document',
        priority: 2,
        description: `Publish a complete plan revision for user review and pause the current turn. ${DOCUMENT_JSON_DESCRIPTION}`,
        parameters: {
            document_json: {
                type: 'string',
                description: DOCUMENT_JSON_DESCRIPTION,
                required: true,
            },
            note: {
                type: 'string',
                description: 'Optional short revision note.',
                required: false,
            },
        },
        rawInputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                document_json: { type: 'string', minLength: 2, description: DOCUMENT_JSON_DESCRIPTION },
                note: { type: 'string' },
            },
            required: ['document_json'],
        },
        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const controller = requirePlanContext(context);
            const result = await controller.publishDocument(readDocument(args), String(args.note || ''));
            return { success: true, data: result, controlSignal: 'awaiting_plan_approval' };
        },
    };
}
