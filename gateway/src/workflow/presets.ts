/**
 * 预置工作流模板
 * Agent 在 ReAct 循环中可自行判断是否进入这些固定流程
 */

import type { WorkflowTemplate } from './types';

/**
 * 所有预置工作流
 */
export const PRESET_WORKFLOWS: WorkflowTemplate[] = [

    // ========== 1. 项目初始化 ==========
    {
        id: 'project-init',
        name: '项目初始化',
        description: '创建标准项目目录结构、配置文件和基础代码框架。适用于从零开始搭建 Node.js/Python 项目。',
        triggers: ['初始化项目', '创建项目', '新建项目', 'init project', 'create project', 'scaffold'],
        parameters: [
            { name: 'projectName', description: '项目名称', type: 'string', required: true },
            { name: 'projectDir', description: '项目根目录路径', type: 'string', required: true },
            { name: 'type', description: '项目类型: node 或 python', type: 'string', required: false, default: 'node' },
        ],
        steps: [
            {
                id: 'create-readme',
                name: '创建 README',
                description: '创建项目 README.md',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/README.md',
                    content: '# {{projectName}}\n\n> 项目描述\n\n## 快速开始\n\n```bash\nnpm install\nnpm run dev\n```\n',
                },
            },
            {
                id: 'create-entry',
                name: '创建入口文件',
                description: '创建 src/index.ts 入口',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/src/index.ts',
                    content: '/**\n * {{projectName}} 入口\n */\n\nconsole.log("{{projectName}} started");\n',
                },
            },
            {
                id: 'create-package',
                name: '创建 package.json',
                description: '创建项目配置文件',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/package.json',
                    content: '{\n  "name": "{{projectName}}",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": {\n    "dev": "tsx src/index.ts",\n    "build": "tsc"\n  }\n}\n',
                },
            },
            {
                id: 'create-tsconfig',
                name: '创建 tsconfig.json',
                description: '创建 TypeScript 配置',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/tsconfig.json',
                    content: '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "ESNext",\n    "moduleResolution": "bundler",\n    "outDir": "dist",\n    "rootDir": "src",\n    "strict": true,\n    "esModuleInterop": true\n  },\n  "include": ["src"]\n}\n',
                },
            },
            {
                id: 'create-gitignore',
                name: '创建 .gitignore',
                description: '创建 Git 忽略规则',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/.gitignore',
                    content: 'node_modules/\ndist/\n.env\n.env.local\n*.log\n.DS_Store\n',
                },
            },
        ],
    },

    // ========== 2. 系统化 Bug 修复 ==========
    {
        id: 'bug-fix',
        name: '系统化 Bug 修复',
        description: '按"定位→分析→修复→验证"四步流程修复 Bug。适用于有明确文件路径和错误描述的场景。',
        triggers: ['修复bug', '修复错误', 'fix bug', 'debug', '排查问题', '系统化修复'],
        parameters: [
            { name: 'description', description: 'Bug 描述', type: 'string', required: true },
            { name: 'filePath', description: '相关文件路径', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'read-source',
                name: '读取源码',
                description: '读取问题相关的源文件',
                tool: 'filesystem',
                args: { action: 'read', path: '{{filePath}}' },
            },
            {
                id: 'search-error',
                name: '搜索错误模式',
                description: '在相关目录中搜索错误关键词',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'findstr /s /n /i "error throw catch" "{{filePath}}"',
                },
                onFailure: 'skip',
            },
            {
                id: 'check-deps',
                name: '检查依赖关系',
                description: '查看文件的 import/require 依赖',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'findstr /n "import require from" "{{filePath}}"',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 3. 代码审查 ==========
    {
        id: 'code-review',
        name: '代码审查',
        description: '对指定文件进行结构化代码审查：读取代码→检查结构→分析依赖→汇总问题。',
        triggers: ['代码审查', '代码评审', 'code review', 'review code', '检查代码'],
        parameters: [
            { name: 'targetPath', description: '要审查的文件路径', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'read-target',
                name: '读取目标文件',
                description: '读取待审查的文件内容',
                tool: 'filesystem',
                args: { action: 'read', path: '{{targetPath}}' },
            },
            {
                id: 'check-info',
                name: '获取文件信息',
                description: '检查文件大小和修改时间',
                tool: 'filesystem',
                args: { action: 'info', path: '{{targetPath}}' },
                onFailure: 'skip',
            },
            {
                id: 'check-structure',
                name: '检查目录结构',
                description: '查看文件所在目录的整体结构',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'dir /b "{{targetPath}}/.."',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 4. 部署前检查 ==========
    {
        id: 'deploy-check',
        name: '部署前检查',
        description: '执行部署前的标准检查清单：依赖检查→构建测试→配置验证→生成报告。',
        triggers: ['部署检查', '发布前检查', 'deploy check', 'pre-deploy', '上线检查'],
        parameters: [
            { name: 'projectDir', description: '项目根目录', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'check-package',
                name: '检查依赖配置',
                description: '读取 package.json 确认依赖完整',
                tool: 'filesystem',
                args: { action: 'read', path: '{{projectDir}}/package.json' },
            },
            {
                id: 'check-env',
                name: '检查环境配置',
                description: '确认 .env.example 存在',
                tool: 'filesystem',
                args: { action: 'exists', path: '{{projectDir}}/.env.example' },
                onFailure: 'skip',
            },
            {
                id: 'check-gitignore',
                name: '检查 Git 忽略规则',
                description: '确认 .gitignore 包含必要规则',
                tool: 'filesystem',
                args: { action: 'read', path: '{{projectDir}}/.gitignore' },
                onFailure: 'skip',
            },
            {
                id: 'try-build',
                name: '尝试构建',
                description: '执行项目构建命令验证可编译',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'cd "{{projectDir}}" && npm run build',
                },
                requiresConfirmation: true,
                onFailure: 'skip',
            },
        ],
    },

    // ========== 5. 文件批量处理 ==========
    {
        id: 'batch-file-ops',
        name: '文件批量处理',
        description: '对指定目录下的文件进行批量操作：扫描目录→列出文件→执行操作。适用于批量重命名、格式化等。',
        triggers: ['批量处理', '批量操作', 'batch', '批量文件', '批量重命名'],
        parameters: [
            { name: 'targetDir', description: '目标目录路径', type: 'string', required: true },
            { name: 'pattern', description: '文件匹配模式', type: 'string', required: false, default: '*' },
        ],
        steps: [
            {
                id: 'scan-dir',
                name: '扫描目录',
                description: '列出目标目录下的所有文件',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
            },
            {
                id: 'search-pattern',
                name: '搜索匹配文件',
                description: '按模式搜索匹配的文件',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'dir /s /b "{{targetDir}}\\{{pattern}}"',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 6. 日报生成 ==========
    {
        id: 'daily-report',
        name: '日报生成',
        description: '扫描指定目录下的工作文件，提取关键信息并生成 Word 格式日报文档。',
        triggers: ['日报', '写日报', '生成日报', 'daily report', '工作日报', '今日总结'],
        parameters: [
            { name: 'workDir', description: '工作目录（扫描此目录下的文件）', type: 'string', required: true },
            { name: 'outputPath', description: '日报输出路径（.docx）', type: 'string', required: true },
            { name: 'author', description: '日报作者', type: 'string', required: false, default: 'OpenFlux' },
        ],
        steps: [
            {
                id: 'scan-work-dir',
                name: '扫描工作目录',
                description: '列出工作目录下的所有文件',
                tool: 'filesystem',
                args: { action: 'list', path: '{{workDir}}' },
            },
            {
                id: 'read-recent-files',
                name: '读取最近文件',
                description: '读取最近修改的文件内容（由 Agent 根据时间筛选）',
                tool: 'filesystem',
                args: { action: 'list', path: '{{workDir}}', recursive: true },
                onFailure: 'skip',
            },
            {
                id: 'create-report',
                name: '生成日报文档',
                description: '基于收集的信息创建 Word 日报',
                tool: 'office',
                args: {
                    action: 'word',
                    subAction: 'create',
                    filePath: '{{outputPath}}',
                    title: '工作日报 - {{author}}',
                    paragraphs: ['（Agent 将根据扫描结果填充具体内容）'],
                },
            },
        ],
    },

    // ========== 7. 数据提取 ==========
    {
        id: 'data-extract',
        name: '数据提取',
        description: '从多个 Excel/CSV 文件中提取数据并合并到一个新的 Excel 文件中。',
        triggers: ['数据提取', '合并Excel', 'Excel合并', 'data extract', '提取数据', '合并表格', '数据汇总'],
        parameters: [
            { name: 'sourceDir', description: '源文件所在目录', type: 'string', required: true },
            { name: 'outputPath', description: '输出文件路径（.xlsx）', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'list-sources',
                name: '列出源文件',
                description: '扫描目录下的 Excel/CSV 文件',
                tool: 'filesystem',
                args: { action: 'list', path: '{{sourceDir}}' },
            },
            {
                id: 'create-output',
                name: '创建输出文件',
                description: '创建合并后的 Excel 文件（Agent 将逐个读取源文件并写入）',
                tool: 'office',
                args: {
                    action: 'excel',
                    subAction: 'create',
                    filePath: '{{outputPath}}',
                    sheet: '汇总',
                },
            },
        ],
    },

    // ========== 8. 文件整理 ==========
    {
        id: 'file-organize',
        name: '文件整理',
        description: '按文件类型自动整理指定目录：扫描所有文件→按扩展名分类→移动到对应子目录（如 文档/图片/视频 等）。',
        triggers: ['文件整理', '整理文件', '文件分类', 'organize files', '归类文件', '清理目录'],
        parameters: [
            { name: 'targetDir', description: '要整理的目标目录', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'scan-files',
                name: '扫描文件',
                description: '列出目标目录下的所有文件',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
            },
            {
                id: 'check-existing',
                name: '检查已有分类目录',
                description: '检查是否已有分类子目录（如 文档/图片/视频）',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
                onFailure: 'skip',
            },
        ],
    },
];

/**
 * 根据 ID 获取预置工作流
 */
export function getPresetWorkflow(id: string): WorkflowTemplate | undefined {
    return PRESET_WORKFLOWS.find(w => w.id === id);
}

/**
 * 获取所有预置工作流的摘要（用于 LLM 工具描述）
 */
export function getWorkflowSummary(): string {
    return PRESET_WORKFLOWS.map(w => {
        const params = w.parameters
            .map(p => `${p.name}${p.required ? '(必填)' : '(可选)'}: ${p.description}`)
            .join(', ');
        return `- **${w.id}**: ${w.name} — ${w.description}\n  参数: ${params}\n  关键词: ${w.triggers.join(', ')}`;
    }).join('\n\n');
}
