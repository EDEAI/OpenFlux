/**
 * Preset workflow templates
 * The Agent can determine whether to enter these fixed processes by itself in the ReAct loop.
 */

import type { WorkflowTemplate } from './types';

/**
 * All preset workflows
 */
export const PRESET_WORKFLOWS: WorkflowTemplate[] = [

    // ========== 1. Project initialization ==========
    {
        id: 'project-init',
        name: 'Project Initialization',
        description: 'Create standard project directory structure, config files, and basic code framework. For scaffolding Node.js/Python projects from scratch.',
        intent: 'User wants to create a new project from scratch, needs to generate standard directory structure and config file templates',
        triggers: ['初始化项目', '创建项目', '新建项目', 'init project', 'create project', 'scaffold', 'initialize project'],
        parameters: [
            { name: 'projectName', description: 'Project name', type: 'string', required: true },
            { name: 'projectDir', description: 'Project root directory path', type: 'string', required: true },
            { name: 'type', description: 'Project type: node or python', type: 'string', required: false, default: 'node' },
        ],
        steps: [
            {
                id: 'create-readme',
                name: 'Create README',
                description: 'Create project README.md',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/README.md',
                    content: '# {{projectName}}\n\n> Project description\n\n## Quick Start\n\n```bash\nnpm install\nnpm run dev\n```\n',
                },
            },
            {
                id: 'create-entry',
                name: 'Create entry file',
                description: 'Create src/index.ts entry',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/src/index.ts',
                    content: '/** \n * {{projectName}} entry\n */\n\nconsole.log("{{projectName}} started");\n',
                },
            },
            {
                id: 'create-package',
                name: 'Create package.json',
                description: 'Create project config file',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/package.json',
                    content: '{\n  "name": "{{projectName}}",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": {\n    "dev": "tsx src/index.ts",\n    "build": "tsc"\n  }\n}\n',
                },
            },
            {
                id: 'create-tsconfig',
                name: 'Create tsconfig.json',
                description: 'Create TypeScript config',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/tsconfig.json',
                    content: '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "ESNext",\n    "moduleResolution": "bundler",\n    "outDir": "dist",\n    "rootDir": "src",\n    "strict": true,\n    "esModuleInterop": true\n  },\n  "include": ["src"]\n}\n',
                },
            },
            {
                id: 'create-gitignore',
                name: 'Create .gitignore',
                description: 'Create Git ignore rules',
                tool: 'filesystem',
                args: {
                    action: 'write',
                    path: '{{projectDir}}/.gitignore',
                    content: 'node_modules/\ndist/\n.env\n.env.local\n*.log\n.DS_Store\n',
                },
            },
        ],
    },

    // ========== 2. Systematic bug fixes ==========
    {
        id: 'bug-fix',
        name: 'Systematic Bug Fix',
        description: 'Fix bugs following "Locate→Analyze→Fix→Verify" four-step process. Suitable for scenarios with clear file paths and error descriptions.',
        intent: 'User reported a specific bug or error, needs systematic locating, analyzing, fixing, and verification',
        triggers: ['修复bug', '修复错误', 'fix bug', 'debug', '排查问题', '系统化修复', 'troubleshoot'],
        parameters: [
            { name: 'description', description: 'Bug description', type: 'string', required: true },
            { name: 'filePath', description: 'Related file path', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'read-source',
                name: 'Read source code',
                description: 'Read source files related to the issue',
                tool: 'filesystem',
                args: { action: 'read', path: '{{filePath}}' },
            },
            {
                id: 'search-error',
                name: 'Search error patterns',
                description: 'Search for error keywords in related directories',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'findstr /s /n /i "error throw catch" "{{filePath}}"',
                },
                onFailure: 'skip',
            },
            {
                id: 'check-deps',
                name: 'Check dependencies',
                description: 'View file import/require dependencies',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'findstr /n "import require from" "{{filePath}}"',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 3. Code review ==========
    {
        id: 'code-review',
        name: 'Code Review',
        description: 'Perform structured code review on specified files: read code→check structure→analyze dependencies→summarize issues.',
        intent: 'User wants to perform quality review, audit, or inspection on existing code to find potential issues',
        triggers: ['代码审查', '代码评审', 'code review', 'review code', '检查代码', 'inspect code'],
        parameters: [
            { name: 'targetPath', description: 'File path to review', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'read-target',
                name: 'Read target file',
                description: 'Read target file contents for review',
                tool: 'filesystem',
                args: { action: 'read', path: '{{targetPath}}' },
            },
            {
                id: 'check-info',
                name: 'Get file info',
                description: 'Check file size and modification time',
                tool: 'filesystem',
                args: { action: 'info', path: '{{targetPath}}' },
                onFailure: 'skip',
            },
            {
                id: 'check-structure',
                name: 'Check directory structure',
                description: 'View overall structure of the file\'s directory',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'dir /b "{{targetPath}}/.."',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 4. Pre-deployment checks ==========
    {
        id: 'deploy-check',
        name: 'Pre-deployment Check',
        description: 'Execute pre-deployment standard checklist: dependency check→build test→config validation→generate report.',
        intent: 'User is preparing to deploy or release a project, needs to execute standard pre-release checks',
        triggers: ['部署检查', '发布前检查', 'deploy check', 'pre-deploy', '上线检查', 'release check'],
        parameters: [
            { name: 'projectDir', description: 'Project root directory', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'check-package',
                name: 'Check dependency config',
                description: 'Read package.json to verify dependencies are complete',
                tool: 'filesystem',
                args: { action: 'read', path: '{{projectDir}}/package.json' },
            },
            {
                id: 'check-env',
                name: 'Check environment config',
                description: 'Verify .env.example exists',
                tool: 'filesystem',
                args: { action: 'exists', path: '{{projectDir}}/.env.example' },
                onFailure: 'skip',
            },
            {
                id: 'check-gitignore',
                name: 'Check Git ignore rules',
                description: 'Verify .gitignore contains necessary rules',
                tool: 'filesystem',
                args: { action: 'read', path: '{{projectDir}}/.gitignore' },
                onFailure: 'skip',
            },
            {
                id: 'try-build',
                name: 'Try build',
                description: 'Execute project build command to verify compilability',
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

    // ========== 5. Batch processing of files ==========
    {
        id: 'batch-file-ops',
        name: 'Batch File Processing',
        description: 'Batch operations on files in a specified directory: scan directory→list files→execute operations. Suitable for batch renaming, formatting, etc.',
        intent: 'User needs to perform unified batch operations on a large number of files, such as renaming, format conversion, categorization, etc.',
        triggers: ['批量处理', '批量操作', 'batch', '批量文件', '批量重命名', 'batch process'],
        parameters: [
            { name: 'targetDir', description: 'Target directory path', type: 'string', required: true },
            { name: 'pattern', description: 'File matching pattern', type: 'string', required: false, default: '*' },
        ],
        steps: [
            {
                id: 'scan-dir',
                name: 'Scan directory',
                description: 'List all files in the target directory',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
            },
            {
                id: 'search-pattern',
                name: 'Search matching files',
                description: 'Search files matching the pattern',
                tool: 'process',
                args: {
                    action: 'run',
                    command: 'dir /s /b "{{targetDir}}\\{{pattern}}"',
                },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 6. Daily report generation ==========
    {
        id: 'daily-report',
        name: 'Daily Report Generation',
        description: 'Scan work files in the specified directory, extract key information and generate a Word format daily report.',
        intent: 'User needs to automatically generate a daily work report or summary based on the day\'s work',
        triggers: ['日报', '写日报', '生成日报', 'daily report', '工作日报', '今日总结', 'generate report'],
        parameters: [
            { name: 'workDir', description: 'Work directory (scans files in this directory)', type: 'string', required: true },
            { name: 'outputPath', description: 'Report output path (.docx)', type: 'string', required: true },
            { name: 'author', description: 'Report author', type: 'string', required: false, default: 'OpenFlux' },
        ],
        steps: [
            {
                id: 'scan-work-dir',
                name: 'Scan work directory',
                description: 'List all files in the work directory',
                tool: 'filesystem',
                args: { action: 'list', path: '{{workDir}}' },
            },
            {
                id: 'read-recent-files',
                name: 'Read recent files',
                description: 'Read recently modified file contents (Agent filters by time)',
                tool: 'filesystem',
                args: { action: 'list', path: '{{workDir}}', recursive: true },
                onFailure: 'skip',
            },
            {
                id: 'create-report',
                name: 'Generate report document',
                description: 'Create Word daily report based on collected information',
                tool: 'office',
                args: {
                    action: 'word',
                    subAction: 'create',
                    filePath: '{{outputPath}}',
                    title: 'Daily Report - {{author}}',
                    paragraphs: ['(Agent will fill in specific content based on scan results)'],
                },
            },
        ],
    },

    // ========== 7. Data extraction ==========
    {
        id: 'data-extract',
        name: 'Data Extraction',
        description: 'Extract data from multiple Excel/CSV files and merge into a new Excel file.',
        intent: 'User has multiple data files to consolidate, or needs to extract specific data from multiple tables',
        triggers: ['数据提取', '合并Excel', 'Excel合并', 'data extract', '提取数据', '合并表格', '数据汇总', 'merge data'],
        parameters: [
            { name: 'sourceDir', description: 'Source files directory', type: 'string', required: true },
            { name: 'outputPath', description: 'Output file path (.xlsx)', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'list-sources',
                name: 'List source files',
                description: 'Scan Excel/CSV files in the directory',
                tool: 'filesystem',
                args: { action: 'list', path: '{{sourceDir}}' },
            },
            {
                id: 'create-output',
                name: 'Create output file',
                description: 'Create merged Excel file (Agent will read source files and write one by one)',
                tool: 'office',
                args: {
                    action: 'excel',
                    subAction: 'create',
                    filePath: '{{outputPath}}',
                    sheet: 'Summary',
                },
            },
        ],
    },

    // ========== 8. Document organization ==========
    {
        id: 'file-organize',
        name: 'File Organization',
        description: 'Auto-organize files in a directory by type: scan all files→categorize by extension→move to corresponding subdirectories (e.g., Documents/Images/Videos).',
        intent: 'User\'s directory is messy, wants to auto-categorize files by type (e.g., images to images folder, docs to docs folder)',
        triggers: ['文件整理', '整理文件', '文件分类', 'organize files', '归类文件', '清理目录', 'sort files'],
        parameters: [
            { name: 'targetDir', description: 'Target directory to organize', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'scan-files',
                name: 'Scan files',
                description: 'List all files in the target directory',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
            },
            {
                id: 'check-existing',
                name: 'Check existing category directories',
                description: 'Check if category subdirectories exist (e.g., Documents/Images/Videos)',
                tool: 'filesystem',
                args: { action: 'list', path: '{{targetDir}}' },
                onFailure: 'skip',
            },
        ],
    },

    // ========== 9. Learning skills ==========
    {
        id: 'learn-skill',
        name: 'Learn New Skill',
        description: [
            'Search, download, and install new skills from online skill libraries (OpenClaw/ClawHub), converting them into locally executable workflows.',
            'Installed skills can be viewed via workflow.list and executed via workflow.execute.',
            'Supports keyword search or direct GitHub link installation. If no existing skill is found, it will self-create based on its own knowledge.',
        ].join('\n'),
        intent: 'User wants to permanently master a certain area\'s capability/methodology, solidifying it into a reusable standard process',
        triggers: [
            '学习技能', '学技能', '安装技能', '下载技能',
            'learn skill', 'install skill', '学一下', '学会',
            '获取技能', '添加技能', '新技能', 'add skill',
        ],
        parameters: [
            { name: 'keyword', description: 'Skill keyword (e.g., "deep research", "ppt") or full GitHub URL of SKILL.md', type: 'string', required: true },
        ],
        steps: [
            {
                id: 'search-skill',
                name: 'Search skill',
                description: 'Search for matching OpenClaw Skill on GitHub',
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
                name: 'Download skill content',
                description: 'Get the full content of SKILL.md',
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
                name: 'Convert to workflow and save',
                description: 'Convert SKILL.md content to OpenFlux WorkflowTemplate and save via workflow.save',
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
 * Get preset workflow based on ID
 */
export function getPresetWorkflow(id: string): WorkflowTemplate | undefined {
    return PRESET_WORKFLOWS.find(w => w.id === id);
}

/**
 * Get a summary of all pre-built workflows (for LLM tool description)
 */
export function getWorkflowSummary(): string {
    return PRESET_WORKFLOWS.map(w => {
        const params = w.parameters
            .map(p => `${p.name}${p.required ? '(required)' : '(optional)'}: ${p.description}`)
            .join(', ');
        let summary = `- **${w.id}**: ${w.name} — ${w.description}`;
        if (w.intent) summary += `\n  Intent: ${w.intent}`;
        summary += `\n  Parameters: ${params}`;
        if (w.triggers?.length) summary += `\n  Keywords: ${w.triggers.join(', ')}`;
        return summary;
    }).join('\n\n');
}
