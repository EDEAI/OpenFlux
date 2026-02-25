/**
 * 工作流执行引擎
 * 接收一个 WorkflowTemplate + 参数，逐步调用 ToolRegistry 中的工具执行
 * 支持混合步骤：tool（确定性工具调用）+ llm（LLM 智能处理）
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
// 配置
// ========================

export interface WorkflowEngineConfig {
    /** 工具注册表（用于执行 tool 步骤） */
    tools: ToolRegistry;
    /** LLM Provider（用于执行 llm 步骤） */
    llm?: LLMProvider;
    /** 持久化存储（用于保存/加载自定义模板） */
    store?: WorkflowStore;
    /** 进度回调 */
    onProgress?: (event: WorkflowProgressEvent) => void;
}

// ========================
// 引擎
// ========================

export class WorkflowEngine {
    private tools: ToolRegistry;
    private llm?: LLMProvider;
    private store?: WorkflowStore;
    private onProgress?: (event: WorkflowProgressEvent) => void;
    /** 所有运行实例（按 ID 索引） */
    private runs: Map<string, WorkflowRun> = new Map();
    /** 已注册的自定义模板 */
    private customTemplates: Map<string, WorkflowTemplate> = new Map();

    constructor(config: WorkflowEngineConfig) {
        this.tools = config.tools;
        this.llm = config.llm;
        this.store = config.store;
        this.onProgress = config.onProgress;

        // 从持久化存储加载自定义模板
        if (this.store) {
            const templates = this.store.loadAll();
            for (const t of templates) {
                this.customTemplates.set(t.id, t);
            }
            if (templates.length > 0) {
                log.info(`从存储加载了 ${templates.length} 个自定义工作流模板`);
            }
        }
    }

    /**
     * 注册自定义工作流模板（同时持久化）
     */
    registerTemplate(template: WorkflowTemplate): void {
        this.customTemplates.set(template.id, template);
        // 持久化到磁盘
        if (this.store) {
            this.store.save(template);
        }
        log.info(`注册自定义工作流: ${template.id} (${template.name})`);
    }

    /**
     * 删除自定义工作流模板
     */
    deleteTemplate(id: string): boolean {
        const existed = this.customTemplates.delete(id);
        if (this.store) {
            this.store.delete(id);
        }
        if (existed) {
            log.info(`已删除自定义工作流: ${id}`);
        }
        return existed;
    }

    /**
     * 获取自定义模板
     */
    getCustomTemplate(id: string): WorkflowTemplate | undefined {
        return this.customTemplates.get(id);
    }

    /**
     * 获取所有自定义模板
     */
    getAllCustomTemplates(): WorkflowTemplate[] {
        return Array.from(this.customTemplates.values());
    }

    /**
     * 执行工作流
     */
    async execute(
        template: WorkflowTemplate,
        parameters: Record<string, unknown>,
    ): Promise<WorkflowRun> {
        // 1. 校验必填参数
        this.validateParameters(template, parameters);

        // 2. 填充默认值
        const fullParams = this.applyDefaults(template, parameters);

        // 3. 创建运行实例
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

        log.info(`工作流启动: ${template.name} (${run.id})`, {
            params: Object.keys(fullParams),
            steps: template.steps.length,
        });

        // 4. 逐步执行
        for (let i = 0; i < template.steps.length; i++) {
            run.currentStep = i;
            const stepTemplate = template.steps[i];
            const stepRun = run.steps[i];

            // 条件检查
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
                log.info(`步骤跳过(条件不满足): ${stepTemplate.name}`);
                continue;
            }

            // 执行步骤
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

                    log.error(`工作流失败: ${template.name}`, { step: stepTemplate.name, error: stepRun.error });
                    return run;
                }
                // skip: 继续下一步
            }
        }

        // 5. 全部完成
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
        log.info(`工作流完成: ${template.name} (${duration}ms, ${completed}/${template.steps.length} 步完成, ${skipped} 步跳过)`);

        return run;
    }

    /**
     * 执行单个步骤（含重试）
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

            log.info(`步骤执行: ${stepTemplate.name} [${stepTemplate.type || 'tool'}]${attempt > 0 ? ` (重试 #${attempt})` : ''}`);

            try {
                let stepResult: unknown;
                let stepSuccess = false;

                if (stepTemplate.type === 'llm') {
                    // === LLM 智能步骤 ===
                    if (!this.llm) {
                        throw new Error('工作流引擎未配置 LLM Provider，无法执行 llm 类型步骤');
                    }
                    if (!stepTemplate.prompt) {
                        throw new Error('llm 类型步骤缺少 prompt 字段');
                    }

                    // 构建上下文并解析模板变量
                    const ctx = this.buildTemplateContext(run);
                    const resolvedPrompt = this.resolveValue(stepTemplate.prompt, ctx) as string;

                    log.info(`LLM 步骤提示词: ${resolvedPrompt.slice(0, 200)}...`);

                    const llmResult = await this.llm.chat([
                        { role: 'system', content: '你是一个数据处理助手。请根据用户的指示处理提供的数据，直接输出处理结果，不要添加多余的解释。' },
                        { role: 'user', content: resolvedPrompt },
                    ]);

                    stepResult = llmResult;
                    stepSuccess = true;

                } else {
                    // === 工具调用步骤（默认） ===
                    if (!stepTemplate.tool) {
                        throw new Error('tool 类型步骤缺少 tool 字段');
                    }

                    const resolvedArgs = this.resolveArgs(stepTemplate.args || {}, run);
                    const result = await this.tools.executeTool(stepTemplate.tool, resolvedArgs);
                    stepResult = result.data;
                    stepSuccess = result.success;

                    if (!stepSuccess) {
                        stepRun.error = result.error || '工具执行返回失败';
                        log.warn(`步骤失败: ${stepTemplate.name}`, { error: stepRun.error, attempt });
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
                log.warn(`步骤异常: ${stepTemplate.name}`, { error: stepRun.error, attempt });
            }
        }

        // 所有尝试均失败
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
     * 获取运行实例
     */
    getRun(runId: string): WorkflowRun | undefined {
        return this.runs.get(runId);
    }

    // ========================
    // 内部方法
    // ========================

    /** 校验必填参数 */
    private validateParameters(template: WorkflowTemplate, params: Record<string, unknown>): void {
        const missing = template.parameters
            .filter(p => p.required && !(p.name in params))
            .map(p => `${p.name}(${p.description})`);

        if (missing.length > 0) {
            throw new Error(`缺少必填参数: ${missing.join(', ')}`);
        }
    }

    /** 填充默认值 */
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
     * 构建模板上下文（参数 + 已完成步骤结果）
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
     * 解析 {{paramName}} 和 {{steps.stepId.result}} 模板语法
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

    /** 递归解析模板值 */
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

    /** 条件评估（简单版：检查参数是否 truthy） */
    private evaluateCondition(condition: string, params: Record<string, unknown>): boolean {
        // 支持 "!" 前缀取反
        if (condition.startsWith('!')) {
            return !params[condition.slice(1)];
        }
        return !!params[condition];
    }

    /** 截断结果（避免日志过长） */
    private truncateResult(data: unknown): unknown {
        const str = JSON.stringify(data);
        if (str && str.length > 500) {
            return str.slice(0, 500) + '...(截断)';
        }
        return data;
    }

    /** 发送进度事件 */
    private emit(event: WorkflowProgressEvent): void {
        this.onProgress?.(event);
    }
}
