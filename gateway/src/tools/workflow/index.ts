/**
 * Workflow tool - structured process entry for AgentLoop calls
 *
 * LLM When the task is judged to match a preset process in the ReAct loop, this tool is called to enter structured execution.
 *
 * action:
 *   list - list all available workflows and their parameter descriptions
 *   execute - execute the specified workflow
 *   status - Query the results of a certain workflow run
 *   save - save a custom workflow template (persistence)
 *   delete - delete a custom workflow template
 */

import type { AnyTool, ToolResult } from '../types';
import { validateAction, readStringParam, jsonResult, errorResult } from '../common';
import type { WorkflowEngine } from '../../workflow/engine';
import { PRESET_WORKFLOWS, getPresetWorkflow } from '../../workflow/presets';
import type { WorkflowTemplate, WorkflowRun } from '../../workflow/types';

// Supported actions
const WORKFLOW_ACTIONS = ['list', 'execute', 'status', 'save', 'delete'] as const;
type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export interface WorkflowToolOptions {
    /** Workflow engine instance */
    engine: WorkflowEngine;
}

/**
 * Create workflow tools
 */
export function createWorkflowTool(opts: WorkflowToolOptions): AnyTool {
    const { engine } = opts;

    return {
        name: 'workflow',
        priority: 65,
        description: [
            'Execute and manage structured workflows. Includes preset and custom workflows.',
            '',
            'Actions:',
            '  list    — List all available workflows (preset and custom)',
            '  execute — Execute a workflow (requires workflowId and params)',
            '  status  — Query detailed results of a run (requires runId)',
            '  save    — Save a custom workflow template (requires template)',
            '  delete  — Delete a custom workflow (requires workflowId)',
            '',
            '⚠️ Matching rule: Match workflows by understanding user intent, not exact keyword matching.',
            'For example, user says "help me learn XXX analysis methods" → matches learn-skill intent "permanently master a domain skill"',
        ].join('\n'),

        parameters: {
            action: {
                type: 'string',
                description: 'Action: list | execute | status | save | delete',
                required: true,
                enum: [...WORKFLOW_ACTIONS],
            },
            workflowId: {
                type: 'string',
                description: 'Workflow ID (required for execute/delete)',
                required: false,
            },
            params: {
                type: 'object',
                description: 'Workflow parameters (for execute, JSON object)',
                required: false,
            },
            runId: {
                type: 'string',
                description: 'Run ID (required for status)',
                required: false,
            },
            template: {
                type: 'object',
                description: 'Workflow template definition (required for save, includes id/name/description/triggers/parameters/steps)',
                required: false,
            },
        },

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            const action = validateAction(args, WORKFLOW_ACTIONS) as WorkflowAction;

            switch (action) {
                case 'list':
                    return handleList(engine);
                case 'execute':
                    return handleExecute(engine, args);
                case 'status':
                    return handleStatus(engine, args);
                case 'save':
                    return handleSave(engine, args);
                case 'delete':
                    return handleDelete(engine, args);
                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}

// ========================
// Action processing
// ========================

/** List all available workflows */
function handleList(engine: WorkflowEngine): ToolResult {
    // Merge presets + custom templates
    const customTemplates = engine.getAllCustomTemplates();
    const allTemplates = [...PRESET_WORKFLOWS, ...customTemplates];

    const workflows = allTemplates.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description,
        intent: w.intent || '',
        triggers: w.triggers || [],
        parameters: (Array.isArray(w.parameters) ? w.parameters : []).map(p => ({
            name: p.name,
            description: p.description,
            type: p.type,
            required: p.required,
            default: p.default,
        })),
        stepsCount: w.steps.length,
        stepNames: w.steps.map(s => s.name),
        source: PRESET_WORKFLOWS.includes(w) ? 'preset' : 'custom',
    }));

    return jsonResult({
        count: workflows.length,
        workflows,
    });
}

/** Execute workflow */
async function handleExecute(engine: WorkflowEngine, args: Record<string, unknown>): Promise<ToolResult> {
    const workflowId = readStringParam(args, 'workflowId');
    if (!workflowId) {
        return errorResult('Missing workflowId parameter. Use the list action first to see available workflows.');
    }

    // Find templates: Check presets first, then customize
    let template: WorkflowTemplate | undefined = getPresetWorkflow(workflowId);
    if (!template) {
        template = engine.getCustomTemplate(workflowId);
    }
    if (!template) {
        return errorResult(`Workflow not found: ${workflowId}. Use the list action to see available workflows.`);
    }

    // Parse parameters
    const params = (args.params as Record<string, unknown>) || {};

    try {
        const run = await engine.execute(template, params);
        return jsonResult(formatRunResult(run));
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(`Workflow execution failed: ${msg}`);
    }
}

/** Query running status */
function handleStatus(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const runId = readStringParam(args, 'runId');
    if (!runId) {
        return errorResult('Missing runId parameter');
    }

    const run = engine.getRun(runId);
    if (!run) {
        return errorResult(`Run instance not found: ${runId}`);
    }

    return jsonResult(formatRunResult(run));
}

/** Save custom workflow templates */
function handleSave(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const template = args.template as WorkflowTemplate | undefined;
    if (!template) {
        return errorResult('Missing template parameter. Please provide a complete workflow template definition (including id, name, description, triggers, parameters, steps).');
    }

    // Basic verification
    if (!template.id || typeof template.id !== 'string') {
        return errorResult('Template missing id field (string)');
    }
    if (!template.name || typeof template.name !== 'string') {
        return errorResult('Template missing name field (string)');
    }
    if (!template.steps || !Array.isArray(template.steps) || template.steps.length === 0) {
        return errorResult('Template missing steps field (non-empty array)');
    }

    // Check every step
    for (const step of template.steps) {
        if (!step.id || !step.name) {
            return errorResult(`Step missing id or name field`);
        }
        const stepType = step.type || 'tool';
        if (stepType === 'tool' && !step.tool) {
            return errorResult(`Step "${step.name}" type is tool but missing tool field`);
        }
        if (stepType === 'llm' && !step.prompt) {
            return errorResult(`Step "${step.name}" type is llm but missing prompt field`);
        }
    }

    // Make sure necessary fields have default values
    if (!template.description) template.description = template.name;
    if (!template.triggers) template.triggers = [];
    if (!template.parameters) template.parameters = [];

    // Check for conflicts with preset workflows
    if (getPresetWorkflow(template.id)) {
        return errorResult(`Cannot overwrite preset workflow: ${template.id}. Please use a different id.`);
    }

    try {
        engine.registerTemplate(template);
        return jsonResult({
            success: true,
            message: `Workflow "${template.name}" (${template.id}) saved with ${template.steps.length} steps. You can call it via execute action next time.`,
            workflowId: template.id,
            stepsCount: template.steps.length,
            stepTypes: template.steps.map(s => ({ name: s.name, type: s.type || 'tool' })),
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(`Failed to save workflow: ${msg}`);
    }
}

/** Delete custom workflow */
function handleDelete(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const workflowId = readStringParam(args, 'workflowId');
    if (!workflowId) {
        return errorResult('Missing workflowId parameter. Please specify the workflow ID to delete.');
    }

    // Deletion of preset workflows is not allowed
    if (getPresetWorkflow(workflowId)) {
        return errorResult(`Cannot delete preset workflow: ${workflowId}`);
    }

    const deleted = engine.deleteTemplate(workflowId);
    if (deleted) {
        return jsonResult({
            success: true,
            message: `Workflow "${workflowId}" deleted.`,
        });
    } else {
        return errorResult(`Custom workflow not found: ${workflowId}`);
    }
}

// ========================
// format
// ========================

/** Formatted running results (structured data returned to LLM) */
function formatRunResult(run: WorkflowRun): Record<string, unknown> {
    const duration = run.completedAt
        ? `${((run.completedAt - run.startedAt) / 1000).toFixed(1)}s`
        : 'in progress';

    return {
        runId: run.id,
        workflow: run.templateName,
        status: run.status,
        duration,
        error: run.error || undefined,
        parameters: run.parameters,
        steps: run.steps.map(s => ({
            name: s.name,
            tool: s.tool,
            status: s.status,
            result: s.status === 'completed' ? truncate(s.result) : undefined,
            error: s.error || undefined,
            retries: s.retryCount > 0 ? s.retryCount : undefined,
        })),
        summary: generateSummary(run),
    };
}

/** Generate a readable summary */
function generateSummary(run: WorkflowRun): string {
    const total = run.steps.length;
    const completed = run.steps.filter(s => s.status === 'completed').length;
    const failed = run.steps.filter(s => s.status === 'failed').length;
    const skipped = run.steps.filter(s => s.status === 'skipped').length;

    const statusText = {
        running: 'Running',
        completed: '✅ Completed',
        failed: '❌ Failed',
        cancelled: 'Cancelled',
    }[run.status];

    let summary = `Workflow "${run.templateName}" ${statusText}`;
    summary += ` — ${completed}/${total} steps completed`;
    if (failed > 0) summary += `, ${failed} steps failed`;
    if (skipped > 0) summary += `, ${skipped} steps skipped`;
    if (run.error) summary += `\nFailure reason: ${run.error}`;

    return summary;
}

/** Truncate long text */
function truncate(data: unknown, maxLen: number = 300): unknown {
    if (data === undefined || data === null) return data;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length > maxLen) {
        return str.slice(0, maxLen) + '...(truncated)';
    }
    return data;
}
