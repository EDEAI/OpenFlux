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
        intent: '用户想从零开始创建一个新项目，需要生成标准目录结构和配置文件模板',
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
        intent: '用户报告了具体的Bug或错误，需要系统性地定位、分析、修复和验证',
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
        intent: '用户想对已有代码进行质量审查、评审或检查，发现潜在问题',
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
        intent: '用户准备部署或发布项目，需要执行上线前的标准检查流程',
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
        intent: '用户需要对大量文件进行统一的批量操作，如重命名、格式转换、分类整理等',
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
        intent: '用户需要根据当天的工作内容自动生成工作日报或工作总结文档',
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
        intent: '用户有多个数据文件需要汇总合并，或需要从多个表格中提取特定数据整合到一起',
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
        intent: '用户的某个目录很乱，想按文件类型自动归类整理（如图片归图片文件夹、文档归文档文件夹）',
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

    // ========== 9. 学习技能 ==========
    {
        id: 'learn-skill',
        name: '学习新技能',
        description: [
            '从线上技能库（OpenClaw/ClawHub）搜索、下载并安装新技能，将其转化为本地可执行的工作流。',
            '安装后的技能可通过 workflow.list 查看，通过 workflow.execute 执行。',
            '支持通过关键词搜索或直接提供 GitHub 链接安装。找不到现成技能时，会基于自身知识自创技能。',
        ].join('\n'),
        intent: '用户希望永久掌握某个领域的能力/方法论，将其固化为可复用的标准流程，而不仅仅是临时查一次资料',
        triggers: [
            '学习技能', '学技能', '安装技能', '下载技能',
            'learn skill', 'install skill', '学一下', '学会',
            '获取技能', '添加技能', '新技能',
        ],
        parameters: [
            { name: 'keyword', description: '技能关键词（如 "deep research"、"ppt"）或 SKILL.md 的完整 GitHub URL', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'search-skill',
                name: '搜索技能',
                description: '在 GitHub 上搜索匹配的 OpenClaw Skill',
                type: 'llm',
                prompt: [
                    '用户想学习与"{{keyword}}"相关的技能。',
                    '',
                    '请执行以下操作：',
                    '',
                    '1. 判断 keyword 是否是一个完整的 GitHub URL（包含 github.com）：',
                    '   - 如果是 URL：直接记住这个 URL，跳到下一步',
                    '   - 如果是关键词：用 web_search 工具搜索 "site:github.com openclaw skills {{keyword}} SKILL.md"',
                    '',
                    '2. 从搜索结果中找到最匹配的 SKILL.md 链接',
                    '   - 优先选择 github.com/openclaw/skills/tree/main/skills/ 路径下的',
                    '   - 如果找不到，再尝试搜索 "openclaw skill {{keyword}}"',
                    '',
                    '3. 如果找到了 SKILL.md：',
                    '   - 输出 raw URL（格式：raw.githubusercontent.com/openclaw/skills/main/skills/xxx/yyy/SKILL.md）',
                    '',
                    '4. 如果搜索多次仍找不到匹配的 SKILL.md：',
                    '   - 输出 "SELF_CREATE" 标记',
                    '   - 不要继续搜索，进入自创模式——你将基于自身知识来创建这个技能',
                ].join('\n'),
            },
            {
                id: 'download-skill',
                name: '下载技能内容',
                description: '获取 SKILL.md 的完整内容',
                type: 'llm',
                prompt: [
                    '根据上一步的结果判断：',
                    '',
                    '**如果上一步输出了 SKILL.md 的 URL：**',
                    '使用 web_fetch 工具下载该 URL 的内容，记住完整的 Skill 文本，准备转化为工作流。',
                    '',
                    '**如果上一步输出了 SELF_CREATE 标记（线上没找到）：**',
                    '基于你对"{{keyword}}"领域的专业知识，自行编写一份技能指令，包括：',
                    '- 技能的角色定义和专业能力',
                    '- 使用时机（When to Use）',
                    '- 详细的工作流程（按阶段/步骤组织）',
                    '- 需要用到的工具和方法',
                    '- 输出格式要求',
                    '- 质量标准和注意事项',
                    '',
                    '自创内容要尽量详细、专业、可操作，让 Agent 按照指令就能完成该领域的任务。',
                ].join('\n'),
            },
            {
                id: 'convert-to-workflow',
                name: '转化为工作流并保存',
                description: '将 SKILL.md 内容转化为 OpenFlux WorkflowTemplate 并通过 workflow.save 保存',
                type: 'llm',
                prompt: [
                    '将获取或自创的技能内容转化为 OpenFlux 工作流模板并保存。',
                    '',
                    '转化规则：',
                    '1. id: 使用 skill 的名称，转为 kebab-case（如 "academic-deep-research"）',
                    '2. name: 使用技能标题（中文）',
                    '3. description: 简要描述功能（中文，50字以内）。如果是自创技能，加上 "[自创]" 前缀',
                    '4. triggers: 提取 5-8 个相关的中英文触发关键词',
                    '5. parameters: 根据使用场景定义参数（通常有一个 topic/query 类主参数）',
                    '6. steps: 创建一个核心步骤（type: "llm"），将技能的完整指令作为 prompt',
                    '',
                    '然后调用 workflow 工具的 save 动作：',
                    '{',
                    '  "action": "save",',
                    '  "template": {',
                    '    "id": "<skill-id>",',
                    '    "name": "<名称>",',
                    '    "description": "<描述>",',
                    '    "triggers": ["<关键词1>", ...],',
                    '    "parameters": [{ "name": "topic", "description": "研究主题", "type": "string", "required": true }],',
                    '    "steps": [{',
                    '      "id": "execute-skill",',
                    '      "name": "<步骤名>",',
                    '      "description": "<步骤描述>",',
                    '      "type": "llm",',
                    '      "prompt": "<SKILL.md 的完整内容，其中用户输入部分替换为 {{topic}} 参数>"',
                    '    }]',
                    '  }',
                    '}',
                    '',
                    '保存成功后，告诉用户："✅ 已学会「<技能名>」！你可以随时让我使用这个技能。"',
                    '并简要说明这个技能能做什么、怎么触发。',
                ].join('\n'),
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
        let summary = `- **${w.id}**: ${w.name} — ${w.description}`;
        if (w.intent) summary += `\n  意图: ${w.intent}`;
        summary += `\n  参数: ${params}`;
        if (w.triggers?.length) summary += `\n  关键词: ${w.triggers.join(', ')}`;
        return summary;
    }).join('\n\n');
}
