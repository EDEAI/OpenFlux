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
    workspace: string;
    /** Projects intentionally use an implementation-oriented execution policy. */
    codeFirst: true;
    icon?: string;
    color?: string;
    createdAt: number;
    updatedAt: number;
}

interface ProjectData {
    version: 1;
    projects: UserProject[];
}

export type ProjectInput = Pick<UserProject, 'name' | 'workspace'> & Partial<Pick<
    UserProject,
    'description' | 'defaultRules' | 'icon' | 'color'
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

export function buildProjectSystemPrompt(project: Pick<
    UserProject,
    'name' | 'description' | 'defaultRules' | 'workspace'
>): string {
    const sections = [
        `你正在 OpenFlux 项目“${project.name}”中工作。`,
        project.description ? `## 项目描述\n${project.description}` : '',
        `## 项目工作目录\n${project.workspace}`,
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
                    .map(project => ({ ...project, icon: '📁' }))
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

    list(): UserProject[] {
        return this.projects.map(project => ({ ...project }));
    }

    get(id: string): UserProject | undefined {
        const project = this.projects.find(item => item.id === id);
        return project ? { ...project } : undefined;
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
            codeFirst: true,
            icon: '📁',
            color: input.color || '#2563eb',
            createdAt: now,
            updatedAt: now,
        };
        this.projects.push(project);
        this.save();
        log.info(`Created project: ${project.id}`, { name: project.name, workspace: project.workspace });
        return { ...project };
    }

    update(id: string, updates: Partial<ProjectInput>): UserProject | null {
        const project = this.projects.find(item => item.id === id);
        if (!project) return null;
        if (updates.name !== undefined) {
            if (!updates.name.trim()) throw new Error('项目名称不能为空');
            project.name = updates.name.trim();
        }
        if (updates.description !== undefined) project.description = updates.description.trim() || undefined;
        if (updates.defaultRules !== undefined) project.defaultRules = updates.defaultRules.trim() || undefined;
        if (updates.workspace !== undefined) project.workspace = normalizeProjectWorkspace(updates.workspace);
        project.icon = '📁';
        if (updates.color !== undefined) project.color = updates.color || '#2563eb';
        project.codeFirst = true;
        project.updatedAt = Date.now();
        this.save();
        log.info(`Updated project: ${id}`, { workspace: project.workspace });
        return { ...project };
    }

    delete(id: string): boolean {
        const index = this.projects.findIndex(item => item.id === id);
        if (index < 0) return false;
        this.projects.splice(index, 1);
        this.save();
        log.info(`Deleted project: ${id}`);
        return true;
    }
}
