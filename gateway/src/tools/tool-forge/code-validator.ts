/**
 * Code Validator
 * 对 Agent 生成的工具代码进行静态安全验证（AST 分析 + 黑名单检测）
 * 不使用沙盒，而是在执行前验证代码安全性
 */

import { Logger } from '../../utils/logger';

const log = new Logger('CodeValidator');

/** 验证结果 */
export interface ValidationResult {
    /** 验证状态: PASS=安全, WARN=有风险但可执行, BLOCK=包含危险操作 */
    status: 'PASS' | 'WARN' | 'BLOCK';
    /** 发现的问题 */
    issues: ValidationIssue[];
    /** 人工确认时展示的非技术语言摘要 */
    humanSummary: string;
}

export interface ValidationIssue {
    type: 'danger' | 'warning' | 'info';
    category: string;
    message: string;
    line?: number;
}

// ========================
// 危险操作黑名单
// ========================

/** 文件系统操作黑名单 */
const FS_DANGER_PATTERNS = [
    { pattern: /\brm\s+-rf\b/i, message: '递归强制删除文件', category: 'fs_delete' },
    { pattern: /\brmSync\b|\brmdir\b|\bunlinkSync\b|\brm\(/, message: '删除文件/目录操作', category: 'fs_delete' },
    { pattern: /\bformat\s+[a-z]:/i, message: '格式化磁盘', category: 'fs_format' },
];

/** 系统命令黑名单 */
const SYSTEM_DANGER_PATTERNS = [
    { pattern: /\bexec\s*\(|\bexecSync\b|\bspawnSync\b|\bchild_process\b/, message: '执行系统命令', category: 'sys_exec' },
    { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b/, message: '系统关机/重启', category: 'sys_power' },
    { pattern: /\breg\s+delete\b|\breg\s+add\b/i, message: '修改注册表', category: 'sys_registry' },
];

/** 数据泄露黑名单 */
const EXFILTRATION_PATTERNS = [
    { pattern: /\bfetch\s*\(|\bhttp\.request\b|\baxios\b|\bgot\(/, message: '网络请求（可能外传数据）', category: 'network' },
    { pattern: /\bWebSocket\b/, message: 'WebSocket 连接', category: 'network' },
    { pattern: /\bsmtp\b|\bsendmail\b/i, message: '发送邮件', category: 'exfil_email' },
];

/** 权限提升黑名单 */
const PRIVILEGE_PATTERNS = [
    { pattern: /\bsudo\b|\brunas\b/, message: '提权操作', category: 'priv_escalation' },
    { pattern: /\bchmod\s+[0-7]*7[0-7]*\b/, message: '修改文件权限', category: 'priv_chmod' },
];

/** 代码注入黑名单 */
const INJECTION_PATTERNS = [
    { pattern: /\beval\s*\(/, message: '动态代码执行 (eval)', category: 'inject_eval' },
    { pattern: /\bFunction\s*\(/, message: '动态函数构造', category: 'inject_function' },
    { pattern: /\bimport\s*\(/, message: '动态模块导入', category: 'inject_import' },
    { pattern: /\b__import__\b/, message: 'Python 动态导入', category: 'inject_python_import' },
    { pattern: /\bcompile\s*\(/, message: '动态代码编译', category: 'inject_compile' },
];

/** 路径遍历黑名单 */
const PATH_TRAVERSAL_PATTERNS = [
    { pattern: /\.\.[\/\\]/, message: '目录遍历 (../', category: 'traversal' },
    { pattern: /[\/\\]etc[\/\\]passwd/, message: '访问系统文件', category: 'traversal_sys' },
    { pattern: /[\/\\](windows|system32)[\/\\]/i, message: '访问 Windows 系统目录', category: 'traversal_win' },
];

// BLOCK 级（直接拦截）
const BLOCK_PATTERNS = [
    ...FS_DANGER_PATTERNS.filter(p => ['fs_format'].includes(p.category)),
    ...SYSTEM_DANGER_PATTERNS.filter(p => ['sys_power', 'sys_registry'].includes(p.category)),
    ...PRIVILEGE_PATTERNS,
    ...INJECTION_PATTERNS,
    ...PATH_TRAVERSAL_PATTERNS.filter(p => ['traversal_sys', 'traversal_win'].includes(p.category)),
];

// WARN 级（提醒但允许）
const WARN_PATTERNS = [
    ...FS_DANGER_PATTERNS.filter(p => !['fs_format'].includes(p.category)),
    ...SYSTEM_DANGER_PATTERNS.filter(p => !['sys_power', 'sys_registry'].includes(p.category)),
    ...EXFILTRATION_PATTERNS,
    ...PATH_TRAVERSAL_PATTERNS.filter(p => !['traversal_sys', 'traversal_win'].includes(p.category)),
];

/**
 * 验证代码安全性
 */
export function validateCode(code: string, scriptType: 'python' | 'node' | 'shell'): ValidationResult {
    const issues: ValidationIssue[] = [];
    const lines = code.split('\n');

    // 逐行扫描
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // BLOCK 级检查
        for (const rule of BLOCK_PATTERNS) {
            if (rule.pattern.test(line)) {
                issues.push({
                    type: 'danger',
                    category: rule.category,
                    message: rule.message,
                    line: lineNum,
                });
            }
        }

        // WARN 级检查
        for (const rule of WARN_PATTERNS) {
            if (rule.pattern.test(line)) {
                issues.push({
                    type: 'warning',
                    category: rule.category,
                    message: rule.message,
                    line: lineNum,
                });
            }
        }
    }

    // Python 额外检查
    if (scriptType === 'python') {
        validatePython(code, issues);
    }

    // Shell 额外检查
    if (scriptType === 'shell') {
        validateShell(code, issues);
    }

    // 判定状态
    const hasDanger = issues.some(i => i.type === 'danger');
    const hasWarning = issues.some(i => i.type === 'warning');
    const status = hasDanger ? 'BLOCK' : hasWarning ? 'WARN' : 'PASS';

    // 生成人类可读的摘要（非技术语言）
    const humanSummary = generateHumanSummary(status, issues, scriptType);

    log.info(`Code validation: ${status} (${issues.length} issues)`);
    return { status, issues, humanSummary };
}

/**
 * Python 特定检查
 */
function validatePython(code: string, issues: ValidationIssue[]): void {
    if (/\bos\.system\b|\bsubprocess\b/.test(code)) {
        issues.push({ type: 'warning', category: 'py_subprocess', message: 'Python 系统命令调用' });
    }
    if (/\bpickle\.loads?\b/.test(code)) {
        issues.push({ type: 'danger', category: 'py_pickle', message: 'Pickle 反序列化（可执行任意代码）' });
    }
    if (/\bctypes\b/.test(code)) {
        issues.push({ type: 'warning', category: 'py_ctypes', message: 'C 语言层面操作' });
    }
}

/**
 * Shell 特定检查
 */
function validateShell(code: string, issues: ValidationIssue[]): void {
    if (/\bcurl\b.*\|\s*bash\b|\bwget\b.*\|\s*sh\b/.test(code)) {
        issues.push({ type: 'danger', category: 'sh_pipe_exec', message: '下载并直接执行远程脚本' });
    }
    if (/\bdd\s+if=/.test(code)) {
        issues.push({ type: 'danger', category: 'sh_dd', message: '磁盘底层操作' });
    }
}

/**
 * 生成非技术语言的安全摘要
 * 按方案要求给非技术用户的确认提示
 */
function generateHumanSummary(status: ValidationResult['status'], issues: ValidationIssue[], scriptType: string): string {
    const typeLabel = scriptType === 'python' ? 'Python' : scriptType === 'node' ? 'JavaScript' : 'Shell';

    if (status === 'PASS') {
        return `这是一个安全的 ${typeLabel} 脚本，经过检查没有发现任何风险操作。`;
    }

    if (status === 'BLOCK') {
        const dangers = issues.filter(i => i.type === 'danger');
        const reasons = [...new Set(dangers.map(i => i.message))].slice(0, 3);
        return `⚠️ 这个脚本包含危险操作被拦截：${reasons.join('、')}。为了安全起见，无法启用。`;
    }

    // WARN
    const warnings = issues.filter(i => i.type === 'warning');
    const reasons = [...new Set(warnings.map(i => i.message))].slice(0, 3);
    return `这个 ${typeLabel} 脚本整体安全，但包含一些需要注意的操作：${reasons.join('、')}。`;
}
