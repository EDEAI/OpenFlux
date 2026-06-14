/**
 * Workflow execution engine
 * Receive a WorkflowTemplate + parameters and gradually call the tools in ToolRegistry for execution
 * Supports mixed steps: tool (deterministic tool call) + llm (LLM intelligent processing)
 */

import { randomUUID } from 'crypto';
import type { ToolRegistry } from '../tools/registry';
import type { LLMProvider } from '../llm/provider';
import type {
    WorkflowTemplate,
    WorkflowRun,
    WorkflowStepRun,
    WorkflowStepTemplate,
    WorkflowProgressEvent,
} from './types';
import type { WorkflowStore } from './workflow-store';
import { Logger } from '../utils/logger';

const log = new Logger('WorkflowEngine');

// ========================
// Configuration
// ========================

export interface WorkflowEngineConfig {
    /** Tool registry (used to execute tool steps) */
    tools: ToolRegistry;
    /** LLM Provider (for executing llm steps) */
    llm?: LLMProvider;
    /** Persistent storage (used to save/load custom templates) */
    store?: WorkflowStore;
    /** Progress callback */
    onProgress?: (event: WorkflowProgressEvent) => void;
}

// ========================
// engine
// ========================

export class WorkflowEngine {
    private tools: ToolRegistry;
    private llm?: LLMProvider;
    private store?: WorkflowStore;
    private onProgress?: (event: WorkflowProgressEvent) => void;
    /** All running instances (indexed by ID) */
    private runs: Map<string, WorkflowRun> = new Map();
    /** Registered custom templates */
    private customTemplates: Map<string, WorkflowTemplate> = new Map();

    constructor(config: WorkflowEngineConfig) {
        this.tools = config.tools;
        this.llm = config.llm;
        this.store = config.store;
        this.onProgress = config.onProgress;

        // Load custom templates from persistent storage
        if (this.store) {
            const templates = this.store.loadAll();
            for (const t of templates) {
                this.customTemplates.set(t.id, t);
            }
            if (templates.length > 0) {
                log.info(`Loaded ${templates.length} custom workflow templates from store`);
            }
        }
    }

    /**
     * Register custom workflow template (persistent at the same time)
     */
    registerTemplate(template: WorkflowTemplate): void {
        this.customTemplates.set(template.id, template);
        // Persistence to disk
        if (this.store) {
            this.store.save(template);
        }
        log.info(`Custom workflow registered: ${template.id} (${template.name})`);
    }

    /**
     * Delete a custom workflow template
     */
    deleteTemplate(id: string): boolean {
        const existed = this.customTemplates.delete(id);
        if (this.store) {
            this.store.delete(id);
        }
        if (existed) {
            log.info(`Custom workflow deleted: ${id}`);
        }
        return existed;
    }

    /**
     * Get a custom template
     */
    getCustomTemplate(id: string): WorkflowTemplate | undefined {
        return this.customTemplates.get(id);
    }

    /**
     * Get all custom templates
     */
    getAllCustomTemplates(): WorkflowTemplate[] {
        return Array.from(this.customTemplates.values());
    }

    /**
     * Execute workflow
     */
    async execute(
        template: WorkflowTemplate,
        parameters: Record<string, unknown>,
    ): Promise<WorkflowRun> {
        // 1. Verify required parameters
        this.validateParameters(template, parameters);

        // 2. Fill in default values
        const fullParams = this.applyDefaults(template, parameters);

        // 3. Create a running instance
        const run: WorkflowRun = {
            id: randomUUID(),
            templateId: template.id,
            templateName: template.name,
            parameters: fullParams,
            status: 'running',
            steps: template.steps.map(s => ({
                stepId: s.id,
                name: s.name,
                tool: s.tool || (s.type === 'llm' ? 'llm' : ''),
                status: 'pending' as const,
                retryCount: 0,
            })),
            currentStep: 0,
            startedAt: Date.now(),
        };

        this.runs.set(run.id, run);

        this.emit({
            type: 'workflow_start',
            workflowId: run.id,
            workflowName: template.name,
            totalSteps: template.steps.length,
        });

        log.info(`Workflow started: ${template.name} (${run.id})`, {
            params: Object.keys(fullParams),
            steps: template.steps.length,
        });

        // 4. Implement step by step
        for (let i = 0; i < template.steps.length; i++) {
            run.currentStep = i;
            const stepTemplate = template.steps[i];
            const stepRun = run.steps[i];

            // condition check
            if (stepTemplate.condition && !this.evaluateCondition(stepTemplate.condition, fullParams)) {
                stepRun.status = 'skipped';
                this.emit({
                    type: 'step_skipped',
                    workflowId: run.id,
                    workflowName: template.name,
                    stepId: stepTemplate.id,
                    stepName: stepTemplate.name,
                    stepIndex: i,
                    totalSteps: template.steps.length,
                });
                log.info(`Step skipped (condition not met): ${stepTemplate.name}`);
                continue;
            }

            // Execution steps
            const success = await this.executeStep(run, stepTemplate, stepRun, i, template.steps.length);

            if (!success) {
                const failAction = stepTemplate.onFailure || 'stop';
                if (failAction === 'stop') {
                    run.status = 'failed';
                    run.error = `步骤 "${stepTemplate.name}" 失败: ${stepRun.error}`;
                    run.completedAt = Date.now();

                    this.emit({
                        type: 'workflow_failed',
                        workflowId: run.id,
                        workflowName: template.name,
                        error: run.error,
                    });

                    log.error(`Workflow failed: ${template.name}`, { step: stepTemplate.name, error: stepRun.error });
                    return run;
                }
                // skip: continue to the next step
            }
        }

        // 5. All done
        run.status = 'completed';
        run.completedAt = Date.now();

        this.emit({
            type: 'workflow_complete',
            workflowId: run.id,
            workflowName: template.name,
            totalSteps: template.steps.length,
        });

        const duration = run.completedAt - run.startedAt;
        const completed = run.steps.filter(s => s.status === 'completed').length;
        const skipped = run.steps.filter(s => s.status === 'skipped').length;
        log.info(`Workflow completed: ${template.name} (${duration}ms, ${completed}/${template.steps.length} steps done, ${skipped} skipped)`);

        return run;
    }

    /**
     * Execute a single step (with retries)
     */
    private async executeStep(
        run: WorkflowRun,
        stepTemplate: WorkflowStepTemplate,
        stepRun: WorkflowStepRun,
        index: number,
        total: number,
    ): Promise<boolean> {
        const maxAttempts = stepTemplate.onFailure === 'retry'
            ? (stepTemplate.maxRetries ?? 1) + 1
            : 1;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            stepRun.retryCount = attempt;
            stepRun.status = 'running';
            stepRun.startedAt = Date.now();

            this.emit({
                type: 'step_start',
                workflowId: run.id,
                workflowName: run.templateName,
                stepId: stepTemplate.id,
                stepName: stepTemplate.name,
                stepIndex: index,
                totalSteps: total,
            });

            log.info(`Step executing: ${stepTemplate.name} [${stepTemplate.type || 'tool'}]${attempt > 0 ? ` (retry #${attempt})` : ''}`);

            try {
                let stepResult: unknown;
                let stepSuccess = false;

                if (stepTemplate.type === 'llm') {
                    // === LLM SMART STEPS ===
                    if (!this.llm) {
                        throw new Error('Workflow engine has no LLM Provider configured, cannot execute llm type step');
                    }
                    if (!stepTemplate.prompt) {
                        throw new Error('llm type step missing prompt field');
                    }

                    // Build context and resolve template variables
                    const ctx = this.buildTemplateContext(run);
                    const resolvedPrompt = this.resolveValue(stepTemplate.prompt, ctx) as string;

                    log.info(`LLM step prompt: ${resolvedPrompt.slice(0, 200)}...`);

                    const llmResult = await this.llm.chat([
                        { role: 'system', content: 'You are a data processing assistant. Process the provided data according to the user\'s instructions and output the result directly without adding unnecessary explanations.' },
                        { role: 'user', content: resolvedPrompt },
                    ]);

                    stepResult = llmResult;
                    stepSuccess = true;

                } else {
                    // === Tool calling steps (default) ===
                    if (!stepTemplate.tool) {
                        throw new Error('tool type step missing tool field');
                    }

                    const resolvedArgs = this.resolveArgs(stepTemplate.args || {}, run);
                    const result = await this.tools.executeTool(stepTemplate.tool, resolvedArgs);
                    stepResult = result.data;
                    stepSuccess = result.success;

                    if (!stepSuccess) {
                        stepRun.error = result.error || '工具执行返回失败';
                        log.warn(`Step failed: ${stepTemplate.name}`, { error: stepRun.error, attempt });
                        continue;
                    }
                }

                if (stepSuccess) {
                    stepRun.result = stepResult;
                    stepRun.status = 'completed';
                    stepRun.completedAt = Date.now();

                    this.emit({
                        type: 'step_complete',
                        workflowId: run.id,
                        workflowName: run.templateName,
                        stepId: stepTemplate.id,
                        stepName: stepTemplate.name,
                        stepIndex: index,
                        totalSteps: total,
                        result: this.truncateResult(stepResult),
                    });

                    return true;
                }

            } catch (error) {
                stepRun.error = error instanceof Error ? error.message : String(error);
                log.warn(`Step error: ${stepTemplate.name}`, { error: stepRun.error, attempt });
            }
        }

        // All attempts failed
        stepRun.status = 'failed';
        stepRun.completedAt = Date.now();

        this.emit({
            type: 'step_failed',
            workflowId: run.id,
            workflowName: run.templateName,
            stepId: stepTemplate.id,
            stepName: stepTemplate.name,
            stepIndex: index,
            totalSteps: total,
            error: stepRun.error,
        });

        return false;
    }

    /**
     * Get running instance
     */
    getRun(runId: string): WorkflowRun | undefined {
        return this.runs.get(runId);
    }

    // ========================
    // internal method
    // ========================

    /** Verify required parameters */
    private validateParameters(template: WorkflowTemplate, params: Record<string, unknown>): void {
        const missing = template.parameters
            .filter(p => p.required && !(p.name in params))
            .map(p => `${p.name}(${p.description})`);

        if (missing.length > 0) {
            throw new Error(`Missing required parameters: ${missing.join(', ')}`);
        }
    }

    /** Fill in default value */
    private applyDefaults(template: WorkflowTemplate, params: Record<string, unknown>): Record<string, unknown> {
        const result = { ...params };
        for (const p of template.parameters) {
            if (!(p.name in result) && p.default !== undefined) {
                result[p.name] = p.default;
            }
        }
        return result;
    }

    /**
     * Build template context (parameters + completed step results)
     */
    private buildTemplateContext(run: WorkflowRun): Record<string, unknown> {
        const ctx: Record<string, unknown> = { ...run.parameters };
        for (const step of run.steps) {
            if (step.status === 'completed' && step.result !== undefined) {
                ctx[`steps.${step.stepId}.result`] = step.result;
            }
        }
        return ctx;
    }

    /**
     * Parse {{paramName}} and {{steps.stepId.result}} template syntax
     */
    private resolveArgs(
        args: Record<string, unknown>,
        run: WorkflowRun,
    ): Record<string, unknown> {
        const ctx = this.buildTemplateContext(run);
        const resolved: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(args)) {
            resolved[key] = this.resolveValue(value, ctx);
        }
        return resolved;
    }

    /** Recursively parse template values */
    private resolveValue(value: unknown, ctx: Record<string, unknown>): unknown {
        if (typeof value === 'string') {
            return value.replace(/\{\{([\w.]+)\}\}/g, (_, name) => {
                const v = ctx[name];
                return v !== undefined ? String(v) : '';
            });
        }
        if (Array.isArray(value)) {
            return value.map(item => this.resolveValue(item, ctx));
        }
        if (value && typeof value === 'object') {
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
                obj[k] = this.resolveValue(v, ctx);
            }
            return obj;
        }
        return value;
    }

    /** Conditional evaluation (simple version: check whether the parameters are truthy) */
    private evaluateCondition(condition: string, params: Record<string, unknown>): boolean {
        // Support "!" prefix inversion
        if (condition.startsWith('!')) {
            return !params[condition.slice(1)];
        }
        return !!params[condition];
    }

    /** Truncate results (to avoid too long logs) */
    private truncateResult(data: unknown): unknown {
        const str = JSON.stringify(data);
        if (str && str.length > 500) {
            return str.slice(0, 500) + '...(截断)';
        }
        return data;
    }

    /** Send progress events */
    private emit(event: WorkflowProgressEvent): void {
        this.onProgress?.(event);
    }
}
