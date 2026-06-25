/**
 * browser_recording 工具
 * 让 Agent 列出/查看/回放浏览器录制，并把录制转成 Workflow / Skill。
 * - replay：顺序调用现有 `browser` 工具执行每个可回放步骤
 */

import type { AnyTool, ToolResult, ToolExecutionContext } from '../types';
import type { ToolRegistry } from '../registry';
import type { RecordingStore } from '../../recording/recording-store';
import type { WorkflowStore } from '../../workflow/workflow-store';
import type { EvolutionDataManager } from '../../evolution/data-manager';
import {
    stepToBrowserActionCandidates,
    recordingToWorkflow,
    recordingToSkill,
} from '../../recording/converter';
import { readStringParam, validateAction, jsonResult, errorResult } from '../common';

const ACTIONS = ['list', 'get', 'replay', 'toWorkflow', 'toSkill'] as const;

export interface BrowserRecordingToolOptions {
    store: RecordingStore;
    registry: ToolRegistry;
    workflowStore: WorkflowStore;
    dataManager: EvolutionDataManager;
    /** 步骤之间的等待（毫秒），默认 600ms，给页面留出响应时间 */
    stepDelayMs?: number;
    /** click/type 前对录制选择器做可见性预等待的上限（毫秒），默认 1500ms */
    stepWaitMs?: number;
}

export function createBrowserRecordingTool(options: BrowserRecordingToolOptions): AnyTool {
    const { store, registry, workflowStore, dataManager } = options;
    const stepDelay = options.stepDelayMs ?? 600;
    const stepWaitMs = options.stepWaitMs ?? 1500;

    return {
        name: 'browser_recording',
        description:
            '管理与复用浏览器录制。可列出已保存录制(list)、查看明细(get)、回放(replay，逐步驱动 browser 工具)、'
            + '将录制转为可执行 Workflow(toWorkflow) 或 Skill(toSkill)。录制由 OpenFlux Chrome 扩展产生。',
        priority: 40,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型：${ACTIONS.join(' / ')}`,
                required: true,
                enum: [...ACTIONS],
            },
            recordingId: {
                type: 'string',
                description: '录制 ID（get/replay/toWorkflow/toSkill 必填）',
                required: false,
            },
        },

        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            try {
                const action = validateAction(args, ACTIONS);
                switch (action) {
                    case 'list': {
                        return jsonResult({ recordings: store.list() });
                    }
                    case 'get': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        return jsonResult({ recording: rec });
                    }
                    case 'toWorkflow': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        const workflowId = recordingToWorkflow(rec, workflowStore);
                        return jsonResult({ workflowId, message: `已生成 Workflow：${workflowId}` });
                    }
                    case 'toSkill': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        const skillId = recordingToSkill(rec, dataManager);
                        return jsonResult({ skillId, message: `已生成 Skill：${skillId}` });
                    }
                    case 'replay': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);

                        const browser = registry.getTool('browser');
                        if (!browser) return errorResult('browser 工具不可用，无法回放');

                        const results: Array<{ step: number; type: string; via?: string; success: boolean; error?: string; tried?: string[] }> = [];
                        let stepNo = 0;
                        for (const step of rec.steps) {
                            const candidates = stepToBrowserActionCandidates(step);
                            if (candidates.length === 0) continue; // 跳过仅元数据步骤（如 select）
                            stepNo += 1;

                            // 自动等待：click/type 前给录制选择器一点出现的时间（非致命，失效则继续走兜底）
                            if ((step.type === 'click' || step.type === 'type') && step.selectors?.css && stepWaitMs > 0) {
                                await browser
                                    .execute({ action: 'wait', selector: step.selectors.css, timeout: stepWaitMs }, context)
                                    .catch(() => undefined);
                            }

                            // 多选择器兜底：按 css → role → text → aria → xpath 顺序逐个尝试
                            let ok = false;
                            let usedVia: string | undefined;
                            let lastError: string | undefined;
                            const tried: string[] = [];
                            for (const cand of candidates) {
                                tried.push(cand.via);
                                const r = await browser.execute(cand.args, context);
                                if (r.success) {
                                    ok = true;
                                    usedVia = cand.via;
                                    break;
                                }
                                lastError = r.error;
                            }

                            results.push({
                                step: stepNo,
                                type: step.type,
                                via: usedVia,
                                success: ok,
                                error: ok ? undefined : lastError,
                                tried,
                            });
                            if (!ok) {
                                return jsonResult({
                                    replayed: stepNo,
                                    completed: false,
                                    failedAt: stepNo,
                                    error: lastError,
                                    results,
                                });
                            }
                            if (stepDelay > 0) await new Promise((res) => setTimeout(res, stepDelay));
                        }
                        return jsonResult({ replayed: stepNo, completed: true, results });
                    }
                    default:
                        return errorResult(`未知操作：${action}`);
                }
            } catch (e) {
                return errorResult(e instanceof Error ? e.message : String(e));
            }
        },
    };
}
