/**
 * SkillHub Client
 * 通过腾讯 SkillHub CLI (npm: skillhub) 进行技能搜索和安装
 * CLI 文档: https://skillhub.tencent.com
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join } from 'path';
import { Logger } from '../../utils/logger';

const log = new Logger('SkillHubClient');

/** 搜索结果项 */
export interface SkillSearchResult {
    slug: string;
    name: string;
    description: string;
    author?: string;
    downloads?: number;
    updatedAt?: string;
}

/**
 * 检查 skillhub CLI 是否可用
 */
function isCliAvailable(): boolean {
    try {
        execSync('npx skillhub --version', { stdio: 'pipe', timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * 搜索技能（通过 CLI）
 */
export async function searchSkills(keyword: string, limit: number = 10): Promise<SkillSearchResult[]> {
    if (!keyword) return [];

    try {
        log.info(`Searching SkillHub: ${keyword}`);
        const output = execSync(
            `npx skillhub search "${keyword.replace(/"/g, '\\"')}" -l ${limit}`,
            { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] },
        );

        return parseSearchOutput(output);
    } catch (err: any) {
        // CLI 的 stderr 输出也可能包含结果（PowerShell 特性）
        const stderr = err.stderr?.toString() || '';
        const stdout = err.stdout?.toString() || '';
        const combined = stdout + '\n' + stderr;

        if (combined.includes('Found') || combined.includes('[1]')) {
            return parseSearchOutput(combined);
        }

        log.warn(`SkillHub search failed: ${err.message || err}`);
        return [];
    }
}

/**
 * 解析 CLI 搜索输出
 * 格式：
 * [1]   owner/repo/slug            🛡️ Pass
 *      ⬇     97  ⭐   1.0k  描述文字...
 */
function parseSearchOutput(output: string): SkillSearchResult[] {
    const results: SkillSearchResult[] = [];
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 匹配 [N]   skill-id   badge
        const idMatch = line.match(/^\[(\d+)\]\s+(\S+)/);
        if (!idMatch) continue;

        const fullId = idMatch[2];
        // 从 fullId 提取 slug（最后一段）和 owner
        const parts = fullId.split('/');
        const slug = parts[parts.length - 1];
        const author = parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;

        // 描述在下一行
        let description = '';
        let downloads: number | undefined;
        if (i + 1 < lines.length) {
            const descLine = lines[i + 1].trim();
            // 格式: ⬇     97  ⭐   1.0k  描述文字
            const descMatch = descLine.match(/⬇\s+(\d+)\s+⭐\s+[\d.]+[kKmM]?\s+(.*)/);
            if (descMatch) {
                downloads = parseInt(descMatch[1], 10);
                description = descMatch[2] || '';
            } else {
                description = descLine;
            }
        }

        results.push({
            slug: fullId,  // 保留完整 ID 用于安装
            name: slug,
            description,
            author,
            downloads,
        });
    }

    return results;
}

/**
 * 通过 CLI 安装技能并读取 SKILL.md
 * @param skillId - 完整技能标识（如 openclaw/skills/xiaohongshu）或简单 slug
 * @param targetDir - 安装目标目录（默认使用临时目录）
 * @returns SKILL.md 内容，或 null
 */
export async function downloadSkillMd(skillId: string, targetDir?: string): Promise<string | null> {
    // 如果是简单 slug（不含 /），先搜索获取完整 ID
    let resolvedId = skillId;
    if (!skillId.includes('/')) {
        log.info(`Simple slug detected: "${skillId}", searching for full ID...`);
        const results = await searchSkills(skillId, 5);
        const match = results.find(r =>
            r.name.toLowerCase() === skillId.toLowerCase() ||
            r.slug.toLowerCase().endsWith(`/${skillId.toLowerCase()}`)
        );
        if (match) {
            resolvedId = match.slug;
            log.info(`Resolved "${skillId}" → "${resolvedId}"`);
        } else {
            log.warn(`Could not resolve simple slug "${skillId}", trying as-is`);
        }
    }

    const installDir = targetDir || join(process.cwd(), '.skillhub-tmp');

    try {
        // 确保临时目录存在
        if (!existsSync(installDir)) {
            mkdirSync(installDir, { recursive: true });
        }

        log.info(`Installing skill via CLI: ${resolvedId}`);
        execSync(
            `npx skillhub install "${resolvedId.replace(/"/g, '\\"')}" --project --force`,
            {
                cwd: installDir,
                encoding: 'utf-8',
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );

        // 安装后，SKILL.md 在 .claude/skills/<slug>/SKILL.md
        const slug = resolvedId.split('/').pop() || resolvedId;
        const skillMdPath = join(installDir, '.claude', 'skills', slug, 'SKILL.md');

        if (existsSync(skillMdPath)) {
            const content = readFileSync(skillMdPath, 'utf-8');
            log.info(`Downloaded SKILL.md for ${skillId} (${content.length} bytes)`);

            // 清理临时安装目录中的 .claude 文件
            try {
                rmSync(join(installDir, '.claude'), { recursive: true, force: true });
            } catch { /* ignore cleanup errors */ }

            return content;
        }

        log.warn(`SKILL.md not found at: ${skillMdPath}`);
        return null;
    } catch (err: any) {
        // CLI 可能通过 stderr 报告成功（PowerShell 特性）
        const slug = resolvedId.split('/').pop() || resolvedId;
        const skillMdPath = join(installDir, '.claude', 'skills', slug, 'SKILL.md');

        if (existsSync(skillMdPath)) {
            const content = readFileSync(skillMdPath, 'utf-8');
            log.info(`Downloaded SKILL.md for ${resolvedId} (${content.length} bytes, via stderr path)`);

            try {
                rmSync(join(installDir, '.claude'), { recursive: true, force: true });
            } catch { /* ignore */ }

            return content;
        }

        log.error(`CLI install failed for ${resolvedId}: ${err.message || err}`);
        return null;
    }
}

/**
 * 获取技能详情（简单包装搜索）
 */
export async function getSkillInfo(slug: string): Promise<SkillSearchResult | null> {
    const results = await searchSkills(slug, 5);
    return results.find(r => r.slug === slug || r.name === slug) || results[0] || null;
}
