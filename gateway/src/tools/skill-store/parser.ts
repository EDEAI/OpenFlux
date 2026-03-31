/**
 * SKILL.md Parser
 * 解析 ClawHub/SkillHub 标准格式的 SKILL.md 文件
 * 
 * 格式：
 * ---
 * name: skill-name
 * description: 技能描述
 * metadata:
 *   openclaw:
 *     requires:
 *       env: [API_KEY]
 *       bins: [curl]
 * ---
 * (Markdown body = 技能指令内容)
 */

import { Logger } from '../../utils/logger';

const log = new Logger('SkillParser');

/** 解析后的技能结构 */
export interface ParsedSkill {
    /** 技能 ID (来自 name 字段) */
    id: string;
    /** 技能标题 (来自 description 字段) */
    title: string;
    /** 技能指令内容 (Markdown body) */
    content: string;
    /** 依赖的环境变量 */
    requiredEnv: string[];
    /** 依赖的二进制工具 */
    requiredBins: string[];
    /** 安装命令 */
    installCommands: string[];
    /** 原始 frontmatter */
    rawFrontmatter: Record<string, unknown>;
}

/**
 * 解析 SKILL.md 内容
 */
export function parseSkillMd(content: string): ParsedSkill {
    const { frontmatter, body } = splitFrontmatter(content);

    const id = (frontmatter.name as string) || 'unknown';
    const title = (frontmatter.description as string) || id;

    // 提取依赖信息
    const metadata = (frontmatter.metadata || {}) as Record<string, unknown>;
    const openclaw = (metadata.openclaw || {}) as Record<string, unknown>;
    const requires = (openclaw.requires || {}) as Record<string, unknown>;

    const requiredEnv = Array.isArray(requires.env) ? requires.env : [];
    const requiredBins = Array.isArray(requires.bins) ? requires.bins : [];

    // 提取安装命令
    const install = (metadata.install || openclaw.install) as Record<string, unknown> | undefined;
    const installCommands: string[] = [];
    if (install) {
        for (const [_pkg, cmd] of Object.entries(install)) {
            if (typeof cmd === 'string') installCommands.push(cmd);
        }
    }

    return {
        id,
        title,
        content: body.trim(),
        requiredEnv,
        requiredBins,
        installCommands,
        rawFrontmatter: frontmatter,
    };
}

/**
 * 将 ParsedSkill 转换为 OpenFlux 的 skill 配置格式
 */
export function toOpenFluxSkill(parsed: ParsedSkill): { id: string; title: string; content: string } {
    return {
        id: `skillhub:${parsed.id}`,
        title: parsed.title,
        content: parsed.content,
    };
}

/**
 * 检查技能依赖是否满足
 */
export function checkDependencies(parsed: ParsedSkill): { satisfied: boolean; missing: { env: string[]; bins: string[] } } {
    const missingEnv = parsed.requiredEnv.filter(e => !process.env[e]);
    const missingBins: string[] = []; // bins 检查需要 which 命令，暂时不实现

    return {
        satisfied: missingEnv.length === 0 && missingBins.length === 0,
        missing: { env: missingEnv, bins: missingBins },
    };
}

// ========================
// YAML Frontmatter Parser (简化版，避免引入 yaml 依赖)
// ========================

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlStr = match[1];
    const body = match[2];

    try {
        const frontmatter = parseSimpleYaml(yamlStr);
        return { frontmatter, body };
    } catch (e) {
        log.warn(`Failed to parse SKILL.md frontmatter: ${e}`);
        return { frontmatter: {}, body: content };
    }
}

/**
 * 简化的 YAML 解析器（只处理常见结构）
 * 支持: 字符串、列表、嵌套对象
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -1 }];

    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const indent = line.search(/\S/);
        const trimmed = line.trim();

        // 弹出栈到正确的层级
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        const current = stack[stack.length - 1].obj;

        // 列表项: - value
        if (trimmed.startsWith('- ')) {
            const parent = stack[stack.length - 1];
            const parentKey = Object.keys(parent.obj).pop();
            if (parentKey && Array.isArray(parent.obj[parentKey])) {
                (parent.obj[parentKey] as unknown[]).push(trimmed.substring(2).trim().replace(/^['"]|['"]$/g, ''));
            }
            continue;
        }

        // key: value
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const key = trimmed.substring(0, colonIdx).trim();
        const rawValue = trimmed.substring(colonIdx + 1).trim();

        if (rawValue === '' || rawValue === '|' || rawValue === '>') {
            // 嵌套对象
            current[key] = {};
            stack.push({ obj: current[key] as Record<string, unknown>, indent });
        } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
            // 内联列表: [item1, item2]
            current[key] = rawValue
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        } else {
            // 普通值
            current[key] = rawValue.replace(/^['"]|['"]$/g, '');
        }
    }

    return result;
}
