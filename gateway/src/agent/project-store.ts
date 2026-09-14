import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger';

const log = new Logger('ProjectStore');

export interface UserProject {
    id: string;
    kind: 'project';
    name: string;
    description?: string;
    defaultRules?: string;
    /** Primary directory: default cwd, default output root and the first tool boundary. */
    workspace: string;
    /**
     * Additional directories that belong to the same project. Tools may read
     * and write inside them exactly like the primary directory; the primary
     * directory stays the default location for new files and commands.
     */
    extraWorkspaces?: string[];
    /** Projects intentionally use an implementation-oriented execution policy. */
    codeFirst: true;
    icon?: string;
    color?: string;
    /** 归档后仍保留在 projects.json，但不再参与普通列表和路由。 */
    status: 'active' | 'archived';
    archivedAt?: number;
    createdAt: number;
    updatedAt: number;
}

interface ProjectData {
    version: 1;
    projects: UserProject[];
}

export type ProjectInput = Pick<UserProject, 'name' | 'workspace'> & Partial<Pick<
    UserProject,
    'description' | 'defaultRules' | 'icon' | 'color' | 'extraWorkspaces'
>>;

export function isProjectEntityId(id: string): boolean {
    return id.startsWith('project-');
}

/** Resolve and validate a user-selected project root before it becomes a tool boundary. */
export function normalizeProjectWorkspace(input: string): string {
    const value = input.trim();
    if (!value) throw new Error('项目目录不能为空');
    const absolute = normalize(isAbsolute(value) ? value : resolve(value));
    if (!existsSync(absolute)) throw new Error(`项目目录不存在: ${absolute}`);
    if (!statSync(absolute).isDirectory()) throw new Error(`项目路径不是目录: ${absolute}`);
    return normalize(realpathSync(absolute));
}

function sameDirectory(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Validate the additional directories of a project. Entries are normalized like
 * the primary directory, de-duplicated, and the primary directory itself is
 * dropped so it is never listed twice.
 */
export function normalizeExtraWorkspaces(primary: string, input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const result: string[] = [];
    for (const raw of input) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const dir = normalizeProjectWorkspace(raw);
        if (sameDirectory(dir, primary) || result.some(existing => sameDirectory(existing, dir))) continue;
        result.push(dir);
    }
    return result;
}

/** All directories of a project, primary first. */
export function projectWorkspaceRoots(project: Pick<UserProject, 'workspace' | 'extraWorkspaces'>): string[] {
    return [project.workspace, ...(project.extraWorkspaces || [])];
}

export function describeProjectWorkspaces(project: Pick<UserProject, 'workspace' | 'extraWorkspaces'>): string {
    const extras = project.extraWorkspaces || [];
    if (extras.length === 0) return project.workspace;
    return [
        `主目录：${project.workspace}`,
        ...extras.map(dir => `附加目录：${dir}`),
        '主目录是新文件、命令和产物的默认位置；附加目录同样属于本项目，可以直接读取和修改，引用其中的文件时使用绝对路径。',
    ].join('\n');
}

export function buildProjectSystemPrompt(project: Pick<
    UserProject,
    'name' | 'description' | 'defaultRules' | 'workspace' | 'extraWorkspaces'
>): string {
    const sections = [
        `你正在 OpenFlux 项目“${project.name}”中工作。`,
        project.description ? `## 项目描述\n${project.description}` : '',
        `## 项目工作目录\n${describeProjectWorkspaces(project)}`,
        project.defaultRules ? `## 项目默认规则\n${project.defaultRules}` : '',
        [
            '## 代码优先执行策略',
            '- 优先检查项目中的现有文件、配置和运行状态，再决定修改方式。',
            '- 能通过修改代码、脚本、配置或自动化命令可靠完成的任务，优先直接实现。',
            '- 项目工作目录是内容输入、构建和产物输出的默认根目录；不要使用 OpenFlux 全局 output 目录替代项目目录。',
            '- Python、Node.js、FFmpeg、编译器及其他运行时/命令可以位于项目目录之外；调用这些环境不等于访问项目外的业务数据。',
            '- 用户拖入或显式附加的项目外文件是本会话授权的只读输入；需要修改时先复制到项目目录，所有新产物仍写入项目目录。',
            '- “本地配置”“当前配置”等未明确范围的说法，默认只指项目工作目录内的配置。',
            '- 除用户显式附加的输入外，不要搜索或读取项目目录之外的用户目录、AppData、OpenFlux 应用配置或系统配置；项目内找不到时应如实说明并询问用户。查找可执行程序本身不受此限制。',
            '- 不要枚举 API Key、Token、Secret、Password 等环境变量，也不要在回复中展示底层模型或供应商标识。',
            '- 修改后应运行与风险相称的构建、测试、静态检查或最小验证。',
            '- 保留并复用项目现有结构与约定，不覆盖无关的用户改动。',
            '- 对纯解释、咨询或无需改动的任务直接回答，不为了“代码优先”而制造无意义代码。',
        ].join('\n'),
    ];
    return sections.filter(Boolean).join('\n\n');
}

export class ProjectStore {
    private readonly filePath: string;
    private projects: UserProject[] = [];

    constructor(dataDir: string) {
        this.filePath = join(dataDir, 'projects.json');
        this.load();
    }

    private load(): void {
        if (!existsSync(this.filePath)) return;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<ProjectData>;
            this.projects = Array.isArray(parsed.projects)
                ? parsed.projects
                    .filter(project => project?.kind === 'project' && typeof project.id === 'string')
                    .map(project => ({
                        ...project,
                        extraWorkspaces: Array.isArray(project.extraWorkspaces)
                            ? project.extraWorkspaces.filter((dir): dir is string => typeof dir === 'string' && !!dir.trim())
                            : [],
                        icon: '📁',
                        status: project.status === 'archived' ? 'archived' : 'active',
                    }))
                : [];
        } catch (error) {
            log.warn('Failed to load projects, starting with an empty list', error);
            this.projects = [];
        }
    }

    private save(): void {
        const parent = dirname(this.filePath);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        const data: ProjectData = { version: 1, projects: this.projects };
        writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    list(options?: { includeArchived?: boolean }): UserProject[] {
        return this.projects
            .filter(project => options?.includeArchived || project.status !== 'archived')
            .map(project => ({ ...project }));
    }

    get(id: string, options?: { includeArchived?: boolean }): UserProject | undefined {
        const project = this.projects.find(item => item.id === id);
        if (!project || (!options?.includeArchived && project.status === 'archived')) return undefined;
        return { ...project };
    }

    create(input: ProjectInput): UserProject {
        if (!input.name?.trim()) throw new Error('项目名称不能为空');
        const now = Date.now();
        const project: UserProject = {
            id: `project-${randomUUID().slice(0, 8)}`,
            kind: 'project',
            name: input.name.trim(),
            description: input.description?.trim() || undefined,
            defaultRules: input.defaultRules?.trim() || undefined,
            workspace: normalizeProjectWorkspace(input.workspace),
            extraWorkspaces: [],
            codeFirst: true,
            icon: '📁',
            color: input.color || '#2563eb',
            status: 'active',
            createdAt: now,
            updatedAt: now,
        };
        project.extraWorkspaces = normalizeExtraWorkspaces(project.workspace, input.extraWorkspaces);
        this.projects.push(project);
        this.save();
        log.info(`Created project: ${project.id}`, {
            name: project.name,
            workspace: project.workspace,
            extraWorkspaces: project.extraWorkspaces,
        });
        return { ...project };
    }

    update(id: string, updates: Partial<ProjectInput>): UserProject | null {
        const project = this.projects.find(item => item.id === id && item.status !== 'archived');
        if (!project) return null;
        if (updates.name !== undefined) {
            if (!updates.name.trim()) throw new Error('项目名称不能为空');
            project.name = updates.name.trim();
        }
        if (updates.description !== undefined) project.description = updates.description.trim() || undefined;
        if (updates.defaultRules !== undefined) project.defaultRules = updates.defaultRules.trim() || undefined;
        if (updates.workspace !== undefined) project.workspace = normalizeProjectWorkspace(updates.workspace);
        if (updates.extraWorkspaces !== undefined || updates.workspace !== undefined) {
            // Re-validate against the (possibly new) primary directory so the
            // primary is never duplicated inside the extra list.
            project.extraWorkspaces = normalizeExtraWorkspaces(
                project.workspace,
                updates.extraWorkspaces !== undefined ? updates.extraWorkspaces : project.extraWorkspaces,
            );
        }
        project.icon = '📁';
        if (updates.color !== undefined) project.color = updates.color || '#2563eb';
        project.codeFirst = true;
        project.updatedAt = Date.now();
        this.save();
        log.info(`Updated project: ${id}`, { workspace: project.workspace, extraWorkspaces: project.extraWorkspaces });
        return { ...project };
    }

    /** 归档项目，保留完整持久化记录。 */
    archive(id: string): boolean {
        const project = this.projects.find(item => item.id === id);
        if (!project || project.status === 'archived') return false;
        project.status = 'archived';
        project.archivedAt = Date.now();
        project.updatedAt = project.archivedAt;
        this.save();
        log.info(`Archived project: ${id}`);
        return true;
    }

    /** 兼容旧调用：过去的 delete 现在只做归档。 */
    delete(id: string): boolean {
        return this.archive(id);
    }
}
