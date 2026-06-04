/**
 * Tool Forge
 * Agent-callable tool forging tools - allowing Agents to create new tools autonomously
 * Security model: static code verification + manual confirmation
 */

import type { Tool, ToolResult } from '../types';
import type { EvolutionDataManager, CustomToolMeta } from '../../evolution/data-manager';
import { validateCode, type ValidationResult } from './code-validator';
import { Logger } from '../../utils/logger';
import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const log = new Logger('ToolForge');

export interface ToolForgeOptions {
    evolutionData: EvolutionDataManager;
    /**
     * Confirmation callback: When the Agent creates a new tool, it pushes a confirmation request to the front end through the Gateway
     * Returns true to indicate that the user has confirmed the enablement
     */
    onConfirmRequired?: (toolName: string, description: string, humanSummary: string, validation: ValidationResult) => Promise<boolean>;
    /** Tool registration callback */
    onToolRegistered?: (tool: Tool) => void;
}

/**
 * Create tool_forge tool
 */
export function createToolForgeTool(options: ToolForgeOptions): Tool {
    const { evolutionData, onConfirmRequired, onToolRegistered } = options;

    return {
        name: 'tool_forge',
        description: '工具锻造：编写新的自定义工具脚本（Python/Node.js/Shell），经安全验证后注册为可用工具。',
        parameters: {
            action: {
                type: 'string',
                description: '操作类型',
                required: true,
                enum: ['create', 'list', 'delete', 'execute', 'verify'],
            },
            name: {
                type: 'string',
                description: '工具名称（action=create/delete/execute/verify 时必填）',
            },
            description: {
                type: 'string',
                description: '工具描述（action=create 时必填）',
            },
            script_type: {
                type: 'string',
                description: '脚本类型（action=create 时必填）',
                enum: ['python', 'node', 'shell'],
            },
            code: {
                type: 'string',
                description: '脚本代码（action=create/verify 时必填）',
            },
            args: {
                type: 'string',
                description: '执行参数（action=execute 时可选，JSON 字符串）',
            },
        },
        execute: async (toolArgs): Promise<ToolResult> => {
            const action = toolArgs.action as string;

            switch (action) {
                case 'create':
                    return await handleCreate(toolArgs, evolutionData, onConfirmRequired, onToolRegistered);
                case 'list':
                    return handleList(evolutionData);
                case 'delete':
                    return handleDelete(toolArgs.name as string, evolutionData);
                case 'execute':
                    return await handleExecute(toolArgs.name as string, toolArgs.args as string, evolutionData);
                case 'verify':
                    return handleVerify(toolArgs.code as string, toolArgs.script_type as string);
                default:
                    return { success: false, error: `未知操作: ${action}` };
            }
        },
    };
}

// ========================
// Action Handlers
// ========================

async function handleCreate(
    args: Record<string, unknown>,
    evolutionData: EvolutionDataManager,
    onConfirm?: (name: string, desc: string, summary: string, validation: ValidationResult) => Promise<boolean>,
    onRegister?: (tool: Tool) => void,
): Promise<ToolResult> {
    const name = args.name as string;
    const description = args.description as string;
    const scriptType = args.script_type as 'python' | 'node' | 'shell';
    const code = args.code as string;

    if (!name || !description || !scriptType || !code) {
        return { success: false, error: '缺少必填参数：name, description, script_type, code' };
    }

    // 1. Static code verification
    const validation = validateCode(code, scriptType);

    if (validation.status === 'BLOCK') {
        log.warn(`Tool "${name}" BLOCKED: ${validation.issues.map(i => i.message).join(', ')}`);
        return {
            success: false,
            error: `工具「${name}」包含危险操作，已被安全系统拦截:\n${validation.humanSummary}`,
            data: { validation },
        };
    }

    // 2. Request human confirmation (non-technical language)
    let confirmed = false;
    if (onConfirm) {
        const confirmMessage = buildConfirmMessage(name, description, scriptType, validation);
        confirmed = await onConfirm(name, description, confirmMessage, validation);
    } else {
        // When there is no confirmation callback, PASS is automatically passed and WARN is rejected.
        confirmed = validation.status === 'PASS';
    }

    if (!confirmed) {
        log.info(`Tool "${name}" creation rejected by user`);
        return {
            success: false,
            error: `工具「${name}」的创建已被取消`,
        };
    }

    // 3. Save to evolution data layer
    const meta: CustomToolMeta = {
        name,
        description,
        scriptType,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        hash: '',
        confirmed: true,
        validatorResult: validation.status,
    };

    evolutionData.saveCustomTool(name, code, meta);

    // 4. Register as an available tool
    const dynamicTool = createDynamicTool(name, description, scriptType, evolutionData);
    onRegister?.(dynamicTool);

    log.info(`Tool "${name}" created and registered`);
    return {
        success: true,
        data: {
            message: `✅ 工具「${name}」已创建并启用！\n${description}\n\n现在可以直接使用 ${name}() 来调用它。`,
            tool: { name, description, scriptType, validation: validation.status },
        },
    };
}

function handleList(evolutionData: EvolutionDataManager): ToolResult {
    const tools = evolutionData.listCustomTools();

    if (tools.length === 0) {
        return {
            success: true,
            data: { message: '目前没有自定义工具。需要我为你创建一个吗？', tools: [] },
        };
    }

    const formatted = tools.map((t, i) =>
        `${i + 1}. **${t.name}** (${t.scriptType}) — ${t.description}\n   状态: ${t.confirmed ? '✅ 已启用' : '⏳ 待确认'} | 验证: ${t.validatorResult}`
    ).join('\n');

    return {
        success: true,
        data: { message: `已创建 ${tools.length} 个自定义工具：\n${formatted}`, tools, count: tools.length },
    };
}

function handleDelete(name: string, evolutionData: EvolutionDataManager): ToolResult {
    if (!name) return { success: false, error: '请提供工具名称' };

    const removed = evolutionData.removeCustomTool(name);
    if (!removed) {
        return { success: false, error: `工具 "${name}" 不存在` };
    }

    log.info(`Tool "${name}" deleted`);
    return { success: true, data: { message: `✅ 工具「${name}」已删除` } };
}

async function handleExecute(name: string, argsStr: string, evolutionData: EvolutionDataManager): Promise<ToolResult> {
    if (!name) return { success: false, error: '请提供工具名称' };

    const tool = evolutionData.readToolScript(name);
    if (!tool) {
        return {
            success: false,
            error: `Custom tool "${name}" does not exist. ` +
                `If "${name}" was installed via skill_store, it is an instruction-based skill, not an executable tool. ` +
                `Check your system prompt "Installed Skills" section and follow the instructions there directly.`,
        };
    }

    if (!tool.meta.confirmed) {
        return { success: false, error: `工具 "${name}" 尚未确认启用` };
    }

    // Verify integrity
    if (!evolutionData.verifyToolIntegrity(name)) {
        return { success: false, error: `工具 "${name}" 文件被篡改，拒绝执行` };
    }

    return await executeTool(name, tool.script, tool.meta.scriptType, argsStr);
}

function handleVerify(code: string, scriptType: string): ToolResult {
    if (!code || !scriptType) {
        return { success: false, error: '请提供 code 和 script_type' };
    }

    const validation = validateCode(code, scriptType as 'python' | 'node' | 'shell');
    return {
        success: true,
        data: {
            message: validation.humanSummary,
            validation: {
                status: validation.status,
                issues: validation.issues,
            },
        },
    };
}

// ========================
// Dynamic Tool Creation
// ========================

/**
 * Create dynamic Tool objects for confirmed custom tools
 */
export function createDynamicTool(
    name: string,
    description: string,
    scriptType: 'python' | 'node' | 'shell',
    evolutionData: EvolutionDataManager,
): Tool {
    return {
        name: `custom_${name}`,
        description: `[自定义工具] ${description}`,
        parameters: {
            args: {
                type: 'string',
                description: '执行参数（JSON 格式）',
            },
        },
        execute: async (toolArgs): Promise<ToolResult> => {
            const tool = evolutionData.readToolScript(name);
            if (!tool || !tool.meta.confirmed) {
                return { success: false, error: `工具 "${name}" 不可用` };
            }
            return executeTool(name, tool.script, scriptType, toolArgs.args as string);
        },
    };
}

/**
 * Execute tool script
 */
async function executeTool(
    name: string,
    script: string,
    scriptType: 'python' | 'node' | 'shell',
    argsStr?: string,
): Promise<ToolResult> {
    try {
        const args = argsStr ? JSON.parse(argsStr) : {};
        let cmd: string;

        switch (scriptType) {
            case 'python':
                cmd = `python -c ${JSON.stringify(script)}`;
                break;
            case 'node':
                cmd = `node -e ${JSON.stringify(script)}`;
                break;
            case 'shell':
                cmd = script;
                break;
            default:
                return { success: false, error: `不支持的脚本类型: ${scriptType}` };
        }

        log.info(`Executing custom tool: ${name} (${scriptType})`);
        const output = execSync(cmd, {
            timeout: 30000,
            encoding: 'utf-8',
            env: { ...process.env, TOOL_ARGS: JSON.stringify(args) },
            maxBuffer: 1024 * 1024, // 1MB
        });

        return {
            success: true,
            data: { output: output.trim() },
        };
    } catch (error: any) {
        log.error(`Tool "${name}" execution failed: ${error.message}`);
        return {
            success: false,
            error: `工具执行失败: ${error.message}`,
            data: { stderr: error.stderr?.toString() },
        };
    }
}

// ========================
// Helpers
// ========================

/**
 * Construct a confirmation message in non-technical language
 */
function buildConfirmMessage(name: string, description: string, scriptType: string, validation: ValidationResult): string {
    const typeLabel = scriptType === 'python' ? 'Python' : scriptType === 'node' ? 'JavaScript' : 'Shell';

    let msg = `我创建了一个新的「${name}」工具：\n\n`;
    msg += `📝 功能：${description}\n`;
    msg += `🔧 类型：${typeLabel} 脚本\n`;
    msg += `🔒 安全检查：${validation.humanSummary}\n\n`;
    msg += `需要我启用它吗？`;

    return msg;
}

/**
 * Load all confirmed custom tools
 */
export function loadConfirmedTools(evolutionData: EvolutionDataManager): Tool[] {
    const tools: Tool[] = [];
    const metas = evolutionData.listCustomTools();

    for (const meta of metas) {
        if (!meta.confirmed) continue;
        tools.push(createDynamicTool(meta.name, meta.description, meta.scriptType, evolutionData));
    }

    log.info(`Loaded ${tools.length} confirmed custom tools`);
    return tools;
}
