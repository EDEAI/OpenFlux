/**
 * Small, pure heuristics the agent loop uses to catch three failure shapes
 * seen in real sessions:
 *
 * 1. A turn that calls no tool yet answers "restarted / fixed / done" — the
 *    model narrated an action it never took.
 * 2. A turn that re-reads the same file over and over through different
 *    channels (filesystem read, `type`, `Get-Content`), burning iterations.
 * 3. A final answer that is the previous answer verbatim even though new tool
 *    evidence arrived this turn.
 *
 * Kept free of loop state so they can be unit-tested directly.
 */

const ACTION_REQUEST = /(重启|重新启动|启动|停止|停掉|关掉|运行|跑一下|修复|修好|修改|改一下|改成|删除|删掉|创建|新建|安装|部署|执行|打开|关闭|重新|你来|帮我|把.{0,20}(改|删|加|换)|加上|去掉|清理|提交|推送|回滚|restart|start|stop|run|fix|deploy|install|uninstall|delete|remove|create|open|close|kill|rebuild|rerun|revert|commit|push)/i;

const ACTION_CLAIM = /(已(?:经)?(?:重启|重新启动|启动|停止|修复|修好|修改|更新|删除|创建|安装|部署|执行|完成|生效|重新|清理|提交|推送|回滚|写入|保存|应用|运行|就绪|加载|通过|成功|验证|确认|打开)|我来重启|正在重启|现在重启|重启完成|重启了|修好了|改好了|已改|已修|已启|已停|已删|已建|加载完成|has been (?:restarted|started|stopped|fixed|updated|deployed|installed|deleted|created|applied|verified)|(?:I(?:'ve| have) |just )?(?:restarted|started|stopped|fixed|updated|deployed|installed|deleted|created|applied|reran|re-ran|verified|confirmed)\b|is now (?:running|fixed|restarted|up|ready)|(?:is|are) (?:running|ready|up)\b)/i;

/**
 * Text that reads like a report of tool output: timings, status codes, JSON
 * fragments, "returned / satisfied / shows N rows". Without a single tool
 * call behind it, such a report is invented evidence.
 */
const TOOL_EVIDENCE = /(\d+(?:\.\d+)?\s*(?:ms|毫秒|s\b|秒)|\{\s*"[^"]+"\s*:|状态码|status\s*(?:code)?\s*[:=]?\s*\d{3}|\b[1-5]\d{2}\s*(?:OK|ok)\b|返回(?:了|值|结果)?[:：]?\s*\S|响应[:：]?\s*\S|满足|不满足|耗时|列表显示|显示\s*\d+\s*条|共\s*\d+\s*条|输出(?:为|是|如下)|结果(?:为|是|如下|[:：])|returned\b|responded\b|satisfied|took \d|shows \d+|rows?\b.*\d)/i;

/** A short imperative message asking for something to be done, not explained. */
export function looksLikeActionRequest(input: string): boolean {
    const text = (input || '').trim();
    if (!text || text.length > 400) return false;
    // Questions are requests for information, not actions.
    if (/[?？]\s*$/.test(text) && !/(帮我|你来|please)/i.test(text)) return false;
    return ACTION_REQUEST.test(text);
}

/** The reply states that an action was carried out. */
export function claimsActionPerformed(content: string): boolean {
    const text = (content || '').trim();
    if (!text) return false;
    return ACTION_CLAIM.test(text);
}

const LIVE_STATE_QUESTION = /(启动|运行|在跑|跑起来|起来了|开着|开了|挂了|停了|存在|可用|能用|正常|好了|完成了|成功了|通了|端口|服务|进程|状态|在线|连得上|访问|打得开)/;
const LIVE_STATE_CLAIM = /(正在运行|已启动|已在运行|运行中|已运行|未启动|没启动|没有启动|没有运行|未运行|已停止|已挂|在线|离线|可以访问|无法访问|已就绪|已经起来|起来了|没起来|端口.{0,6}(开放|监听|占用|可用|不通)|✅|❌|\b(?:is|are) (?:running|up|down|ready|not running)\b|(?:isn't|is not|aren't) running)/i;

/**
 * A question about the live state of the environment ("没启动？", "服务在跑吗",
 * "端口通了吗"): short, about services/ports/processes/pages. Such a question
 * cannot be answered from memory — only a tool can observe the current state.
 */
export function looksLikeLiveStateQuestion(input: string): boolean {
    const text = (input || '').trim();
    if (!text || text.length > 200) return false;
    return LIVE_STATE_QUESTION.test(text);
}

/** The reply asserts a current environment state ("正在运行 ✅", "没启动"). */
export function claimsLiveState(content: string): boolean {
    const text = (content || '').trim();
    if (!text) return false;
    return LIVE_STATE_CLAIM.test(text);
}

/** The reply reports concrete tool-style evidence (timings, statuses, payloads). */
export function claimsToolEvidence(content: string): boolean {
    const text = (content || '').trim();
    if (!text) return false;
    return TOOL_EVIDENCE.test(text);
}

/** Collapse whitespace/markdown noise so two answers can be compared for sameness. */
export function normalizeAnswer(content: string): string {
    return (content || '')
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const READ_COMMAND = /^(?:\s*(?:cd\s+\/d\s+\S+\s*&&\s*|cd\s+\S+\s*&&\s*|powershell(?:\.exe)?\s+(?:-NoProfile\s+)?(?:-Command\s+)?["']?))?\s*\(?(?:Get-Content|gc|type|cat|more|head|tail|Get-ChildItem|gci|dir|ls|findstr|Select-String|sls|grep|rg|wc|Get-Item|Test-Path|tasklist|netstat|where|which)\b/i;
const WRITE_HINT = /(?:^|[^>])>(?!>)|>>|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\bNew-Item\b|\bRemove-Item\b|\bdel\b|\berase\b|\bmove\b|\bcopy\b|\bmkdir\b|\brmdir\b|\bnpm\b|\bgit\s+(?!status|diff|log|show)|\bpython\b|\bnode\b|\bphp\b|\btaskkill\b|\bkill\b/i;

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function normalizePath(p: unknown): string {
    return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * A cache key for a read-only tool call, or null when the call can change
 * state. Equal keys mean "the same information was already fetched".
 */
export function readOnlyToolKey(tool: string, args: unknown): string | null {
    const name = (tool || '').toLowerCase();
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    if (name === 'filesystem') {
        const action = String(a.action || '').toLowerCase();
        if (['read', 'list', 'exists', 'info'].includes(action)) {
            return `filesystem:${action}:${normalizePath(a.path)}:${stableJson({ ...a, action: undefined, path: undefined })}`;
        }
        return null;
    }
    if (name === 'file_reader') {
        return `file_reader:${normalizePath(a.path ?? a.file ?? a.filePath)}:${stableJson({ ...a, path: undefined, file: undefined, filePath: undefined })}`;
    }
    if (name === 'process' || name === 'shell' || name === 'terminal' || name === 'powershell' || name === 'cmd' || name === 'bash' || name === 'exec') {
        const action = String(a.action || 'run').toLowerCase();
        if (action !== 'run' && action !== 'shell') return null;
        const command = String(a.command || a.cmd || a.script || '');
        if (!READ_COMMAND.test(command) || WRITE_HINT.test(command)) return null;
        return `command:${normalizePath(a.cwd)}:${command.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    }
    return null;
}

/** Stable identity of a tool call (name + canonical args), for novelty tracking. */
export function toolCallSignature(tool: string, args: unknown): string {
    return `${(tool || '').toLowerCase()}:${stableJson(args ?? {})}`;
}

/** Calls that may change files or processes; any of these invalidates read caches. */
export function isMutatingToolCall(tool: string, args: unknown): boolean {
    const name = (tool || '').toLowerCase();
    if (readOnlyToolKey(tool, args) !== null) return false;
    return ['filesystem', 'process', 'shell', 'terminal', 'powershell', 'cmd', 'bash', 'exec', 'opencode', 'coding_agent', 'office', 'windows', 'desktop', 'browser', 'browser_control'].includes(name);
}
