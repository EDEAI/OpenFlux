/**
 * 工作流工具 - 供 AgentLoop 调用的结构化流程入口
 *
 * LLM 在 ReAct 循环中判断任务匹配某个预置流程时，调用此工具进入结构化执行。
 *
 * 动作：
 *   list    — 列出所有可用工作流及其参数说明
 *   execute — 执行指定工作流
 *   status  — 查询某次工作流运行的结果
 *   save    — 保存自定义工作流模板（持久化）
 *   delete  — 删除自定义工作流模板
 */

import type { AnyTool, ToolResult } from '../types';
import { validateAction, readStringParam, jsonResult, errorResult } from '../common';
import type { WorkflowEngine } from '../../workflow/engine';
import { PRESET_WORKFLOWS, getPresetWorkflow } from '../../workflow/presets';
import type { WorkflowTemplate, WorkflowRun } from '../../workflow/types';

// 支持的动作
const WORKFLOW_ACTIONS = ['list', 'execute', 'status', 'save', 'delete'] as const;
type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export interface WorkflowToolOptions {
    /** 工作流引擎实例 */
    engine: WorkflowEngine;
}

/**
 * 创建工作流工具
 */
export function createWorkflowTool(opts: WorkflowToolOptions): AnyTool {
    const { engine } = opts;

    return {
        name: 'workflow',
        description: [
            '执行、管理结构化工作流程。包括预置和自定义工作流。',
            '',
            '动作:',
            '  list    — 列出所有可用工作流（包含预置和自定义）',
            '  execute — 执行指定工作流（需提供 workflowId 和 params）',
            '  status  — 查询某次运行的详细结果（需提供 runId）',
            '  save    — 保存自定义工作流模板（需提供 template）',
            '  delete  — 删除自定义工作流（需提供 workflowId）',
            '',
            '工作流步骤支持两种类型:',
            '  type="tool" — 调用工具（确定性执行）',
            '  type="llm"  — LLM 智能处理（如分析、总结、翻译）',
        ].join('\n'),

        parameters: {
            action: {
                type: 'string',
                description: '动作: list | execute | status | save | delete',
                required: true,
                enum: [...WORKFLOW_ACTIONS],
            },
            workflowId: {
                type: 'string',
                description: '工作流 ID（execute/delete 时必填）',
                required: false,
            },
            params: {
                type: 'object',
                description: '工作流参数（execute 时传入，JSON 对象）',
                required: false,
            },
            runId: {
                type: 'string',
                description: '运行 ID（status 时必填）',
                required: false,
            },
            template: {
                type: 'object',
                description: '工作流模板定义（save 时必填，包含 id/name/description/triggers/parameters/steps）',
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
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}

// ========================
// 动作处理
// ========================

/** 列出所有可用工作流 */
function handleList(engine: WorkflowEngine): ToolResult {
    // 合并预置 + 自定义模板
    const customTemplates = engine.getAllCustomTemplates();
    const allTemplates = [...PRESET_WORKFLOWS, ...customTemplates];

    const workflows = allTemplates.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description,
        triggers: w.triggers,
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

/** 执行工作流 */
async function handleExecute(engine: WorkflowEngine, args: Record<string, unknown>): Promise<ToolResult> {
    const workflowId = readStringParam(args, 'workflowId');
    if (!workflowId) {
        return errorResult('缺少 workflowId 参数。请先使用 list 动作查看可用工作流。');
    }

    // 查找模板：先查预置，再查自定义
    let template: WorkflowTemplate | undefined = getPresetWorkflow(workflowId);
    if (!template) {
        template = engine.getCustomTemplate(workflowId);
    }
    if (!template) {
        return errorResult(`未找到工作流: ${workflowId}。请使用 list 动作查看可用工作流。`);
    }

    // 解析参数
    const params = (args.params as Record<string, unknown>) || {};

    try {
        const run = await engine.execute(template, params);
        return jsonResult(formatRunResult(run));
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(`工作流执行失败: ${msg}`);
    }
}

/** 查询运行状态 */
function handleStatus(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const runId = readStringParam(args, 'runId');
    if (!runId) {
        return errorResult('缺少 runId 参数');
    }

    const run = engine.getRun(runId);
    if (!run) {
        return errorResult(`未找到运行实例: ${runId}`);
    }

    return jsonResult(formatRunResult(run));
}

/** 保存自定义工作流模板 */
function handleSave(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const template = args.template as WorkflowTemplate | undefined;
    if (!template) {
        return errorResult('缺少 template 参数。请提供完整的工作流模板定义（包含 id, name, description, triggers, parameters, steps）。');
    }

    // 基本校验
    if (!template.id || typeof template.id !== 'string') {
        return errorResult('模板缺少 id 字段（字符串）');
    }
    if (!template.name || typeof template.name !== 'string') {
        return errorResult('模板缺少 name 字段（字符串）');
    }
    if (!template.steps || !Array.isArray(template.steps) || template.steps.length === 0) {
        return errorResult('模板缺少 steps 字段（非空数组）');
    }

    // 校验每个步骤
    for (const step of template.steps) {
        if (!step.id || !step.name) {
            return errorResult(`步骤缺少 id 或 name 字段`);
        }
        const stepType = step.type || 'tool';
        if (stepType === 'tool' && !step.tool) {
            return errorResult(`步骤 "${step.name}" 类型为 tool 但缺少 tool 字段`);
        }
        if (stepType === 'llm' && !step.prompt) {
            return errorResult(`步骤 "${step.name}" 类型为 llm 但缺少 prompt 字段`);
        }
    }

    // 确保必要字段有默认值
    if (!template.description) template.description = template.name;
    if (!template.triggers) template.triggers = [];
    if (!template.parameters) template.parameters = [];

    // 检查是否与预置工作流冲突
    if (getPresetWorkflow(template.id)) {
        return errorResult(`不能覆盖预置工作流: ${template.id}。请使用不同的 id。`);
    }

    try {
        engine.registerTemplate(template);
        return jsonResult({
            success: true,
            message: `工作流 "${template.name}" (${template.id}) 已保存，包含 ${template.steps.length} 个步骤。下次可直接通过 execute 动作调用。`,
            workflowId: template.id,
            stepsCount: template.steps.length,
            stepTypes: template.steps.map(s => ({ name: s.name, type: s.type || 'tool' })),
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(`保存工作流失败: ${msg}`);
    }
}

/** 删除自定义工作流 */
function handleDelete(engine: WorkflowEngine, args: Record<string, unknown>): ToolResult {
    const workflowId = readStringParam(args, 'workflowId');
    if (!workflowId) {
        return errorResult('缺少 workflowId 参数。请指定要删除的工作流 ID。');
    }

    // 不允许删除预置工作流
    if (getPresetWorkflow(workflowId)) {
        return errorResult(`不能删除预置工作流: ${workflowId}`);
    }

    const deleted = engine.deleteTemplate(workflowId);
    if (deleted) {
        return jsonResult({
            success: true,
            message: `工作流 "${workflowId}" 已删除。`,
        });
    } else {
        return errorResult(`未找到自定义工作流: ${workflowId}`);
    }
}

// ========================
// 格式化
// ========================

/** 格式化运行结果（返回给 LLM 的结构化数据） */
function formatRunResult(run: WorkflowRun): Record<string, unknown> {
    const duration = run.completedAt
        ? `${((run.completedAt - run.startedAt) / 1000).toFixed(1)}s`
        : '进行中';

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

/** 生成可读摘要 */
function generateSummary(run: WorkflowRun): string {
    const total = run.steps.length;
    const completed = run.steps.filter(s => s.status === 'completed').length;
    const failed = run.steps.filter(s => s.status === 'failed').length;
    const skipped = run.steps.filter(s => s.status === 'skipped').length;

    const statusText = {
        running: '执行中',
        completed: '✅ 已完成',
        failed: '❌ 已失败',
        cancelled: '已取消',
    }[run.status];

    let summary = `工作流"${run.templateName}" ${statusText}`;
    summary += ` — ${completed}/${total} 步完成`;
    if (failed > 0) summary += `, ${failed} 步失败`;
    if (skipped > 0) summary += `, ${skipped} 步跳过`;
    if (run.error) summary += `\n失败原因: ${run.error}`;

    return summary;
}

/** 截断长文本 */
function truncate(data: unknown, maxLen: number = 300): unknown {
    if (data === undefined || data === null) return data;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length > maxLen) {
        return str.slice(0, maxLen) + '...(截断)';
    }
    return data;
}
