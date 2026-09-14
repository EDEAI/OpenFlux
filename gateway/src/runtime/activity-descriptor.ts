import { redactSecrets } from '../security/redaction';

type ActivityLanguage = 'zh' | 'ja' | 'ko' | 'en';

function compact(value: unknown, maxLength = 96): string {
    const text = String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeInline(value: unknown, maxLength = 96): string {
    return compact(value, maxLength)
        .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s;]+/gi, '$1[REDACTED]')
        .replace(/(authorization\s*:\s*bearer\s+)[^\s;]+/gi, '$1[REDACTED]');
}

function lastPathSegment(value: unknown): string {
    const path = compact(value, 160).replace(/[\\/]+$/, '');
    if (!path) return '';
    const parts = path.split(/[\\/]/).filter(Boolean);
    return compact(parts.at(-1) || path, 72);
}

function toolLeaf(tool: string): string {
    return tool.trim().split(/[./:]/).filter(Boolean).at(-1) || tool.trim();
}

function firstString(args: Record<string, unknown> | undefined, keys: string[]): string {
    for (const key of keys) {
        if (typeof args?.[key] === 'string' && String(args[key]).trim()) return String(args[key]);
    }
    return '';
}

const COMMAND_TOOLS = new Set([
    'process', 'shell', 'terminal', 'powershell', 'cmd', 'bash', 'exec', 'exec_command', 'shell_command',
]);

/** Sanitize before shortening so a credential crossing the length limit cannot leak. */
export function sanitizeActivityCommand(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const redacted = redactSecrets(value).value
        .replace(/(\bBearer\s+)(?!\[REDACTED\])[^\s"';]+/gi, '$1[REDACTED]')
        // Replace the complete header value even when an earlier pass already
        // redacted its first token (for example "Cookie: [REDACTED]; sid=...").
        .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n"']*/gi, '$1[REDACTED]')
        // Quoted values accept escaped quotes so the remainder cannot escape
        // the match. These patterns are intentionally limited to credential
        // names and well-known curl credential flags.
        .replace(/((?:\$env:)?(?:[a-z\d]+[_-])*(?:api[_-]?key|token|password|passwd|pwd|passcode|secret|authorization|cookie)(?:[_-][a-z\d]+)*["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,"']+)/gi, '$1[REDACTED]')
        .replace(/((?:^|\s)--?(?:[a-z\d]+[_-])*(?:api[_-]?key|token|password|passwd|pwd|passcode|secret|authorization|cookie)(?:[_-][a-z\d]+)*(?:\s+|\s*=\s*))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;"']+)/gi, '$1[REDACTED]')
        .replace(/((?:^|\s)(?:-b|-u|--cookie|--user|--proxy-user)(?:\s+|\s*=\s*))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;"']+)/gi, '$1[REDACTED]');
    return compact(redacted, 600) || undefined;
}

/** Explicit public command projection; unrelated arguments never enter the activity event. */
export function describeToolCommand(tool: string, args?: Record<string, unknown>): string | undefined {
    const name = toolLeaf(tool).toLowerCase();
    if (name === 'windows') {
        if (firstString(args, ['action']).toLowerCase() !== 'powershell') return undefined;
        return sanitizeActivityCommand(firstString(args, ['script', 'command', 'cmd']));
    }
    if (!COMMAND_TOOLS.has(name)) return undefined;
    return sanitizeActivityCommand(firstString(args, ['command', 'cmd', 'script']));
}

/**
 * Pull the file a shell read command targets (`Get-Content 'x'`, `cat x`,
 * `type x`) so the activity label can show just its name.
 */
function readCommandFile(cmd: string): string {
    const match = /\b(?:Get-Content|type|cat)\b(?:\s+-(?:Path|LiteralPath))?\s+(?:'([^']+)'|"([^"]+)"|([^\s|;&>]+))/i.exec(cmd);
    if (!match) return '';
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    // A flag is not a path (`cat -n file`): fall back to the plain label.
    if (!raw || raw.startsWith('-')) return '';
    return lastPathSegment(raw);
}

function commandLabel(command: string, zh: boolean): string {
    const cmd = compact(command, 600);
    if (!cmd) return zh ? '执行本地命令' : 'Run local command';
    if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i.test(cmd)) return zh ? '运行测试' : 'Run tests';
    if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/i.test(cmd)) return zh ? '构建项目' : 'Build project';
    if (/\bgit\s+status\b/i.test(cmd)) return zh ? '检查 Git 工作区状态' : 'Check Git workspace status';
    if (/\bgit\s+(?:diff|show)\b/i.test(cmd)) return zh ? '检查代码差异' : 'Inspect code changes';
    if (/\b(?:Get-Content|type|cat)\b/i.test(cmd)) {
        // Name the file, not the shell incantation around it.
        const file = readCommandFile(cmd);
        if (file) return zh ? `读取文件：${file}` : `Read file: ${file}`;
        return zh ? '读取文件' : 'Read file';
    }
    if (/\b(?:Select-String|rg|grep)\b/i.test(cmd)) return zh ? '搜索代码' : 'Search code';
    if (/\b(?:Get-ChildItem|dir|ls)\b/i.test(cmd)) return zh ? '列出文件' : 'List files';
    return zh ? '执行命令' : 'Run command';
}

/**
 * Build a deterministic public action label from a tool call. The result is
 * safe to persist in the user-visible activity stream; raw arguments are never
 * returned to the client.
 */
export function describeToolAction(
    tool: string,
    args?: Record<string, unknown>,
    language: ActivityLanguage = 'en',
): string {
    const name = toolLeaf(tool);
    const action = firstString(args, ['action', 'subAction']);
    const zh = language === 'zh';
    const path = firstString(args, ['path', 'file', 'filePath', 'dir', 'directory', 'target']);
    const file = lastPathSegment(path);

    if (name === 'filesystem') {
        if (action === 'read') return zh ? `读取文件：${file || '目标文件'}` : `Read file: ${file || 'target file'}`;
        if (action === 'list') return zh ? `列出目录：${file || compact(path, 72) || '目标目录'}` : `List folder: ${file || compact(path, 72) || 'target folder'}`;
        if (action === 'write') return zh ? `写入文件：${file || '目标文件'}` : `Write file: ${file || 'target file'}`;
        if (action === 'append') return zh ? `追加文件：${file || '目标文件'}` : `Append file: ${file || 'target file'}`;
        if (action === 'delete') return zh ? `删除文件：${file || '目标文件'}` : `Delete file: ${file || 'target file'}`;
        if (action === 'copy') return zh ? `复制文件：${file || '目标文件'}` : `Copy file: ${file || 'target file'}`;
        if (action === 'move') return zh ? `移动文件：${file || '目标文件'}` : `Move file: ${file || 'target file'}`;
        if (action === 'mkdir') return zh ? `创建目录：${file || compact(path, 72) || '目标目录'}` : `Create folder: ${file || compact(path, 72) || 'target folder'}`;
        if (action === 'exists' || action === 'info') return zh ? `检查文件：${file || '目标文件'}` : `Inspect file: ${file || 'target file'}`;
    }

    if (name === 'file_reader') {
        return zh ? `解析文件：${file || '目标文件'}` : `Parse file: ${file || 'target file'}`;
    }

    if (name === 'windows' && action === 'system') {
        return zh ? '读取系统配置' : 'Read system configuration';
    }
    if (COMMAND_TOOLS.has(name.toLowerCase()) || (name === 'windows' && action === 'powershell')) {
        return commandLabel(firstString(args, name === 'windows' ? ['script', 'command', 'cmd'] : ['command', 'cmd', 'script']), zh);
    }

    if (name === 'web_search') {
        const query = safeInline(firstString(args, ['query', 'q']), 80);
        return zh ? `搜索网页：${query || '目标主题'}` : `Search the web: ${query || 'target topic'}`;
    }

    if (name === 'web_fetch') {
        const url = safeInline(firstString(args, ['url']), 88);
        return zh ? `读取网页：${url || '目标页面'}` : `Read webpage: ${url || 'target page'}`;
    }

    if (name === 'sessions_spawn' || name === 'spawn_agent' || name === 'spawn') {
        const batch = Array.isArray(args?.batch) ? args.batch : Array.isArray(args?.tasks) ? args.tasks : undefined;
        if (batch) return zh ? `并行启动 ${batch.length} 个子任务` : `Start ${batch.length} parallel subtasks`;
        const label = safeInline(firstString(args, ['label', 'task', 'message']), 72);
        return zh ? `启动子任务${label ? `：${label}` : ''}` : `Start subtask${label ? `: ${label}` : ''}`;
    }

    if (name === 'sessions_send' || name === 'wait_agent' || name === 'send_message_to_agent') {
        const sendAction = firstString(args, ['action']);
        const ids = Array.isArray(args?.sessionIds) ? args.sessionIds.length : 0;
        if (sendAction === 'waitAll' || name === 'wait_agent') {
            return zh ? `等待${ids ? ` ${ids} 个` : ''}子任务结果` : `Wait for${ids ? ` ${ids}` : ''} subtask results`;
        }
        if (sendAction === 'status') return zh ? '查询子任务状态' : 'Check subtask status';
        return zh ? '向子任务发送消息' : 'Send message to subtask';
    }

    if (name === 'browser') {
        const target = safeInline(firstString(args, ['url', 'selector', 'text']), 72);
        const verb: Record<string, [string, string]> = {
            navigate: ['打开网页', 'Open webpage'],
            click: ['点击页面元素', 'Click page element'],
            type: ['填写页面内容', 'Type into page'],
            screenshot: ['截取网页', 'Capture webpage'],
            content: ['读取网页内容', 'Read page content'],
        };
        const labels = verb[action] || ['操作浏览器', 'Use browser'];
        return `${zh ? labels[0] : labels[1]}${target ? `：${target}` : ''}`;
    }

    const readable = name.replace(/[_-]+/g, ' ');
    return zh ? `执行 ${readable}${action ? `：${action}` : ''}` : `Run ${readable}${action ? `: ${action}` : ''}`;
}

function resultRecord(result: unknown): Record<string, unknown> | undefined {
    return result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
}

/** Canonical tool failure detection shared by Agent execution and activity UI. */
export function isToolResultFailure(result: unknown): boolean {
    if (result == null) return false;
    if (result instanceof Error) return true;
    if (typeof result !== 'object') return false;
    const record = result as Record<string, unknown>;
    if (record.success === false || record.isError === true || record.error === true) return true;
    if (record.error instanceof Error) return true;
    if (typeof record.error === 'string' && record.error.trim().length > 0) return true;
    if (typeof record.content === 'string') {
        try {
            return isToolResultFailure(JSON.parse(record.content));
        } catch { /* Plain text tool content is not an error by itself. */ }
    }
    return false;
}

/** Return a compact public result detail. Empty means the row status is enough. */
export function describeToolCompletion(
    tool: string,
    args: Record<string, unknown> | undefined,
    result: unknown,
    failed: boolean,
    language: ActivityLanguage = 'en',
): string | undefined {
    const zh = language === 'zh';
    const record = resultRecord(result);
    const nested = resultRecord(record?.data);
    const error = record?.error ?? nested?.error;
    if (failed || isToolResultFailure(result)) {
        const detail = safeInline(error || (zh ? '操作失败' : 'Operation failed'), 140);
        return zh ? `失败：${detail}` : `Failed: ${detail}`;
    }

    const name = toolLeaf(tool);
    if (name === 'generate_presentation') {
        const qa = resultRecord(nested?.qa);
        const stage = String(nested?.stage || '');
        const errors = typeof qa?.errors === 'number' ? qa.errors : 0;
        if (stage === 'sample') return zh ? '已生成设计方向，等待视觉比较' : 'Design directions generated; awaiting visual comparison';
        if (stage === 'visual_review') {
            return errors > 0
                ? (zh ? `已生成审阅稿，发现 ${errors} 项质量错误，等待视觉审阅` : `Review draft generated with ${errors} quality errors; awaiting visual review`)
                : (zh ? '已生成审阅稿，等待逐页视觉审阅' : 'Review draft generated; awaiting slide-by-slide visual review');
        }
        if (stage === 'revision') return zh ? '视觉审阅完成，进入修订' : 'Visual review completed; revision required';
        if (stage === 'completed') return zh ? '演示文稿已通过质量门禁' : 'Presentation passed the quality gate';
    }
    if (name === 'filesystem') {
        // `read` results also carry `size`, so decide by what the tool did —
        // the action plus the result's own flags — never by `size` alone, or
        // every read would be reported as a write.
        const action = firstString(args, ['action', 'subAction']);
        if (record?.code === 'DUPLICATE_READ_SKIPPED' || nested?.skipped === true) {
            return zh ? '与之前读取相同，已跳过' : 'Same as an earlier read; skipped';
        }
        const bytes = record?.bytesWritten ?? record?.size ?? nested?.bytesWritten ?? nested?.size;
        const content = record?.content ?? nested?.content;
        const wrote = action === 'write' || action === 'append'
            || record?.written === true || record?.appended === true
            || nested?.written === true || nested?.appended === true;
        if (wrote && typeof bytes === 'number') return zh ? `已写入 ${bytes} 字节` : `Wrote ${bytes} bytes`;
        if (typeof content === 'string') return zh ? `已读取 ${content.length} 个字符` : `Read ${content.length} characters`;
        if ((action === 'read' || action === 'info' || action === 'exists') && typeof bytes === 'number') {
            return zh ? `文件大小 ${bytes} 字节` : `File size ${bytes} bytes`;
        }
    }
    if (name === 'process') {
        const exitCode = record?.exitCode ?? record?.code ?? nested?.exitCode ?? nested?.code;
        if (typeof exitCode === 'number' && exitCode !== 0) {
            return zh ? `退出码 ${exitCode}` : `Exit code ${exitCode}`;
        }
    }
    if (name === 'web_search') {
        const results = record?.results ?? nested?.results;
        if (Array.isArray(results)) return zh ? `找到 ${results.length} 条结果` : `Found ${results.length} results`;
    }
    if (name === 'web_fetch' && (record?.code === 'browser_required' || nested?.blocked === true)) {
        return zh ? '网页要求真实浏览器访问，已返回回退指引' : 'Page requires a real browser; browser fallback requested';
    }
    return undefined;
}
