/**
 * SKILL.md Parser
 * Parse SKILL.md file in ClawHub/SkillHub standard format
 * 
 * Format:
 * ---
 * name: skill-name
 * description: skill description
 * metadata:
 *   openclaw:
 *     requires:
 *       env: [API_KEY]
 *       bins: [curl]
 * ---
 * (Markdown body = skill command content)
 */

import { Logger } from '../../utils/logger';

const log = new Logger('SkillParser');

/** Analyzed skill structure */
export interface ParsedSkill {
    /** Skill ID (from name field) */
    id: string;
    /** Skill title (from description field) */
    title: string;
    /** Skill command content (Markdown body) */
    content: string;
    /** Dependent environment variables */
    requiredEnv: string[];
    /** Dependent binary tools */
    requiredBins: string[];
    /** Installation command */
    installCommands: string[];
    /** Original frontmatter */
    rawFrontmatter: Record<string, unknown>;
}

/**
 * Parsing the contents of SKILL.md
 */
export function parseSkillMd(content: string): ParsedSkill {
    const { frontmatter, body } = splitFrontmatter(content);

    const id = (frontmatter.name as string) || 'unknown';
    const title = (frontmatter.description as string) || id;

    // Extract dependency information
    const metadata = (frontmatter.metadata || {}) as Record<string, unknown>;
    const openclaw = (metadata.openclaw || {}) as Record<string, unknown>;
    const requires = (openclaw.requires || {}) as Record<string, unknown>;

    const requiredEnv = Array.isArray(requires.env) ? requires.env : [];
    const requiredBins = Array.isArray(requires.bins) ? requires.bins : [];

    // Extract installation commands
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
 * Convert ParsedSkill to OpenFlux's skill configuration format
 */
export function toOpenFluxSkill(parsed: ParsedSkill, idOverride?: string): { id: string; title: string; content: string } {
    return {
        id: idOverride || `skillhub:${parsed.id}`,
        title: parsed.title,
        content: parsed.content,
    };
}

/**
 * Check whether skill dependencies are met
 */
export function checkDependencies(parsed: ParsedSkill): { satisfied: boolean; missing: { env: string[]; bins: string[] } } {
    const missingEnv = parsed.requiredEnv.filter(e => !process.env[e]);
    const missingBins: string[] = []; // Bins check requires which command, which is not implemented yet.

    return {
        satisfied: missingEnv.length === 0 && missingBins.length === 0,
        missing: { env: missingEnv, bins: missingBins },
    };
}

// ========================
// YAML Frontmatter Parser (simplified version, avoids introducing yaml dependency)
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
 * Simplified YAML parser (only handles common structures)
 * Support: strings, lists, nested objects
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = yaml.split('\n');
    const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -1 }];

    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const indent = line.search(/\S/);
        const trimmed = line.trim();

        // Pop the stack to the correct level
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        const current = stack[stack.length - 1].obj;

        // list item: - value
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
            // Nested objects
            current[key] = {};
            stack.push({ obj: current[key] as Record<string, unknown>, indent });
        } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
            // Inline list: [item1, item2]
            current[key] = rawValue
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        } else {
            // Normal value
            current[key] = rawValue.replace(/^['"]|['"]$/g, '');
        }
    }

    return result;
}
