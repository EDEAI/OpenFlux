// Tool-call log/summary helpers extracted from main.ts.
// Pure aside from i18n lookups via t().
import { t } from '../i18n/index';
import { formatBytes } from './format';

/** Return a friendly file-type description from the file extension. */
export function getFileTypeDesc(ext: string, filename: string): string {
    const typeMap: Record<string, string> = {
        'py': t('filetype.script'), 'js': t('filetype.script'), 'ts': t('filetype.script'), 'sh': t('filetype.script'), 'bat': t('filetype.script'),
        'pptx': t('filetype.ppt'), 'ppt': t('filetype.ppt'),
        'xlsx': t('filetype.excel'), 'xls': t('filetype.excel'), 'csv': t('filetype.table'),
        'docx': t('filetype.word'), 'doc': t('filetype.word'),
        'pdf': t('filetype.pdf'),
        'png': t('filetype.image'), 'jpg': t('filetype.image'), 'jpeg': t('filetype.image'), 'gif': t('filetype.image'), 'svg': t('filetype.image'), 'webp': t('filetype.image'),
        'mp4': t('filetype.video'), 'webm': t('filetype.video'), 'avi': t('filetype.video'), 'mov': t('filetype.video'),
        'mp3': t('filetype.audio'), 'wav': t('filetype.audio'),
        'zip': t('filetype.archive'), 'rar': t('filetype.archive'), '7z': t('filetype.archive'),
        'html': t('filetype.webpage'), 'css': t('filetype.stylesheet'),
        'json': t('filetype.config'), 'yaml': t('filetype.config'), 'yml': t('filetype.config'), 'toml': t('filetype.config'),
        'md': t('filetype.document'), 'txt': t('filetype.text'),
    };
    return typeMap[ext] || t('filetype.file');
}

/** Infer a friendly description from a command string. */
export function describeCommand(cmd: string): string {
    // pip / conda
    if (/^(pip|pip3|conda)\s+install\b/i.test(cmd)) {
        const pkg = cmd.match(/install\s+([^\s-]+)/)?.[1] || '';
        return `${t('cmd.install_dep')}${pkg ? ': ' + pkg : ''}`;
    }

    // Python inline -c: infer intent from imported libraries
    if (/^python[23]?\s+-c\s/i.test(cmd)) {
        if (/pptx|Presentation/i.test(cmd)) return t('cmd.gen_ppt');
        if (/openpyxl|xlsxwriter|Workbook/i.test(cmd)) return t('cmd.gen_excel');
        if (/docx|Document/i.test(cmd)) return t('cmd.gen_word');
        if (/matplotlib|plotly|seaborn|chart/i.test(cmd)) return t('cmd.gen_chart');
        if (/PIL|Pillow|cv2|opencv/i.test(cmd)) return t('cmd.process_image');
        if (/requests|urllib|httpx|aiohttp/i.test(cmd)) return t('cmd.fetch_data');
        if (/pandas|numpy|scipy/i.test(cmd)) return t('cmd.data_processing');
        if (/pdf|reportlab|fpdf/i.test(cmd)) return t('cmd.gen_pdf');
        if (/selenium|playwright/i.test(cmd)) return t('cmd.automate_browser');
        if (/smtp|email/i.test(cmd)) return t('cmd.send_email');
        if (/sqlite|mysql|postgres/i.test(cmd)) return t('cmd.database_op');
        return t('cmd.run_python');
    }

    // Python script file
    if (/^python[23]?\s+[\w/\\.-]+\.py/i.test(cmd)) {
        const scriptName = cmd.match(/[\w/\\.-]+\.py/)?.[0]?.split(/[/\\]/).pop() || '';
        return `${t('cmd.run_script')}: ${scriptName}`;
    }

    // node
    if (/^node\s/i.test(cmd)) return t('cmd.run_node');

    // npm / pnpm / yarn
    if (/^(npm|pnpm|yarn)\s/i.test(cmd)) {
        if (/install/i.test(cmd)) return t('cmd.npm_install');
        if (/run\s+build/i.test(cmd)) return t('cmd.npm_build');
        if (/run\s+dev/i.test(cmd)) return t('cmd.npm_dev');
        if (/run\s+test/i.test(cmd)) return t('cmd.npm_test');
        return t('cmd.npm_cmd');
    }

    // git
    if (/^git\s/i.test(cmd)) {
        if (/clone/i.test(cmd)) return t('cmd.git_clone');
        if (/pull/i.test(cmd)) return t('cmd.git_pull');
        if (/push/i.test(cmd)) return t('cmd.git_push');
        if (/commit/i.test(cmd)) return t('cmd.git_commit');
        if (/status/i.test(cmd)) return t('cmd.git_status');
        return t('cmd.git_op');
    }

    // Directory operations
    if (/^(mkdir|md)\s/i.test(cmd)) return t('cmd.mkdir');
    if (/^(rmdir|rd)\s/i.test(cmd)) return t('cmd.rmdir');
    if (/^(del|rm)\s/i.test(cmd)) return t('cmd.del');
    if (/^(copy|cp|xcopy)\s/i.test(cmd)) return t('cmd.copy');
    if (/^(move|mv)\s/i.test(cmd)) return t('cmd.move');
    if (/^(dir|ls)\s/i.test(cmd)) return t('cmd.dir');
    if (/^(type|cat)\s/i.test(cmd)) return t('cmd.cat');
    if (/^(curl|wget)\s/i.test(cmd)) return t('cmd.download');
    if (/^chcp\s/i.test(cmd)) return t('cmd.chcp');

    // Generic: show the full command (strip the chcp prefix, truncate if too long)
    let displayCmd = cmd.replace(/^chcp\s+\d+\s*>?\s*nul\s*&&\s*/i, '').trim();
    if (displayCmd.length > 60) {
        displayCmd = displayCmd.slice(0, 57) + '...';
    }
    return `${t('cmd.execute')}: ${displayCmd}`;
}

/** Build an icon + human-readable label for a tool call. */
export function getToolLog(tool: string, args?: Record<string, unknown>): { icon: string; text: string } {
    const action = (args?.action as string) || '';
    const subAction = (args?.subAction as string) || '';

    switch (tool) {
        case 'windows': {
            if (action === 'system') return { icon: '💻', text: t('tool.system_info') };
            if (action === 'clipboard') return { icon: '📋', text: subAction === 'write' ? t('tool.clipboard_write') : t('tool.clipboard_read') };
            if (action === 'notification') return { icon: '🔔', text: `${t('tool.send_notification')}: ${args?.title || ''}` };
            if (action === 'window') {
                const winTitle = (args?.windowTitle as string) || '';
                if (subAction === 'activate') return { icon: '🪟', text: `${t('tool.window_activate')}: ${winTitle}` };
                if (subAction === 'list' || subAction === 'find') return { icon: '🔍', text: `${t('tool.window_find')}${winTitle ? ': ' + winTitle : ''}` };
                if (subAction === 'close') return { icon: '', text: `${t('tool.window_close')}: ${winTitle}` };
                return { icon: '🪟', text: `${t('tool.window_op')}: ${winTitle || subAction}` };
            }
            if (action === 'powershell') return { icon: '', text: t('tool.powershell') };
            return { icon: '🖥', text: t('tool.system_op') };
        }

        case 'filesystem': {
            const path = (args?.path as string) || (args?.dir as string) || '';
            const filename = path.split(/[/\\]/).pop() || path;
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const friendlyName = filename.length > 30 ? filename.slice(0, 27) + '...' : filename;

            if (action === 'list') return { icon: '📂', text: t('tool.browse_folder') };
            if (action === 'read') return { icon: '📖', text: `${t('tool.read_file')}: ${friendlyName}` };
            if (action === 'write') {
                const fileDesc = getFileTypeDesc(ext, filename);
                return { icon: '💾', text: `${t('tool.save_file')}${fileDesc}: ${friendlyName}` };
            }
            if (action === 'delete') return { icon: '🗑', text: `${t('tool.delete_file')}: ${friendlyName}` };
            if (action === 'exists' || action === 'info') return { icon: '🔍', text: `${t('tool.check_file')}: ${friendlyName}` };
            if (action === 'mkdir') return { icon: '📁', text: t('tool.create_folder') };
            if (action === 'copy') return { icon: '📄', text: `${t('tool.copy_file')}: ${friendlyName}` };
            if (action === 'move') return { icon: '📄', text: `${t('tool.move_file')}: ${friendlyName}` };
            return { icon: '📄', text: `${t('tool.file_op')}(${action}): ${friendlyName}` };
        }

        case 'process': {
            const cmd = (args?.command as string) || (args?.name as string) || '';
            if (action === 'run' || action === 'shell') {
                return { icon: '⚙️', text: describeCommand(cmd) };
            }
            if (action === 'spawn') return { icon: '⚙️', text: t('tool.spawn_process') };
            if (action === 'list') return { icon: '📋', text: t('tool.list_processes') };
            if (action === 'kill') return { icon: '', text: t('tool.kill_process') };
            return { icon: '⚙️', text: t('tool.execute_op') };
        }

        case 'opencode': {
            const cmd = (args?.command as string) || '';
            if (action === 'run') {
                return { icon: '⚙️', text: describeCommand(cmd) };
            }
            return { icon: '⚙️', text: t('tool.execute_code') };
        }

        case 'spawn': {
            const task = (args?.task as string) || '';
            const shortTask = task.length > 30 ? task.slice(0, 27) + '...' : task;
            return { icon: '🔀', text: `${t('tool.subtask')}: ${shortTask}` };
        }

        case 'browser': {
            if (action === 'navigate') {
                const url = (args?.url as string) || '';
                const domain = url.replace(/https?:\/\//, '').split('/')[0] || url;
                return { icon: '🌐', text: `${t('tool.open_web')}: ${domain}` };
            }
            if (action === 'screenshot') return { icon: '📸', text: t('tool.screenshot_web') };
            if (action === 'click') return { icon: '👆', text: t('tool.click_element') };
            if (action === 'type') return { icon: '⌨️', text: t('tool.type_content') };
            if (action === 'content') return { icon: '📃', text: t('tool.get_content') };
            if (action === 'snapshot') return { icon: '📃', text: t('tool.analyze_structure') };
            if (action === 'evaluate') return { icon: '💻', text: t('tool.execute_script') };
            if (action === 'scroll') return { icon: '📜', text: t('tool.scroll_page') };
            if (action === 'wait') return { icon: '', text: t('tool.wait_page') };
            return { icon: '🌐', text: `${t('tool.browser_op')}: ${action}` };
        }

        case 'desktop': {
            if (action === 'screen' || action === 'capture') return { icon: '📸', text: t('tool.screenshot_screen') };
            if (action === 'keyboard') return { icon: '⌨️', text: t('tool.keyboard_input') };
            if (action === 'mouse') return { icon: '🖱', text: t('tool.mouse_op') };
            if (action === 'window') return { icon: '🪟', text: t('tool.window_op') };
            return { icon: '🖥', text: t('tool.desktop_op') };
        }

        case 'scheduler': {
            if (action === 'create') return { icon: '📅', text: t('tool.create_task') };
            if (action === 'list') return { icon: '📋', text: t('tool.list_tasks') };
            if (action === 'delete') return { icon: '🗑', text: t('tool.delete_task') };
            if (action === 'update') return { icon: '✏️', text: t('tool.update_task') };
            return { icon: '📅', text: t('tool.manage_tasks') };
        }

        case 'web_search': {
            const query = (args?.query as string) || '';
            return { icon: '🔍', text: `${t('tool.search')}: ${query.slice(0, 40)}${query.length > 40 ? '...' : ''}` };
        }

        case 'web_fetch': {
            const url = (args?.url as string) || '';
            const domain = url.replace(/https?:\/\//, '').split('/')[0] || url;
            return { icon: '📥', text: `${t('tool.fetch_web')}: ${domain}` };
        }

        case 'sessions_spawn': {
            const targetAgent = (args?.agentId as string) || '';
            const taskDesc = (args?.task as string) || '';
            const shortTask = taskDesc.length > 25 ? taskDesc.slice(0, 22) + '...' : taskDesc;
            if (args?.batch) {
                const batchArr = args.batch as unknown[];
                return { icon: '🚀', text: t('tool.parallel_subtasks').replace('{0}', String(batchArr.length)) };
            }
            return { icon: '🚀', text: `${t('tool.dispatch_subtask')}${targetAgent ? ' ' + targetAgent : ''}: ${shortTask}` };
        }

        case 'sessions_send': {
            const sendAction = (args?.action as string) || '';
            if (sendAction === 'status') return { icon: '📊', text: t('tool.query_subtask') };
            if (sendAction === 'waitAll') return { icon: '', text: t('tool.wait_subtasks') };
            if (sendAction === 'send') return { icon: '💬', text: t('tool.send_to_subtask') };
            return { icon: '📡', text: `${t('tool.collab_comm')}: ${sendAction}` };
        }

        default:
            return { icon: '⚙️', text: `${t('tool.default_op')}: ${tool}${action ? ' / ' + action : ''}` };
    }
}

/** Extract key info from a tool result. */
export function getToolResultSummary(tool: string, args?: Record<string, unknown>, result?: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const r = result as Record<string, unknown>;

    // Error check: keep error info but without emoji
    if (r.error) return String(r.error).slice(0, 60);

    switch (tool) {
        case 'filesystem': {
            const action = args?.action as string;
            if (action === 'write' && r.success) {
                const size = r.size || r.bytesWritten;
                return size ? formatBytes(size as number) : '';
            }
            if (action === 'read' && typeof r.content === 'string') {
                return `${(r.content.length / 1000).toFixed(1)}K`;
            }
            return '';
        }
        case 'web_search': {
            const results = r.results as unknown[];
            return results ? `${results.length} results` : '';
        }
        case 'web_fetch': {
            const content = r.content as string || r.text as string;
            if (content) return `${(content.length / 1000).toFixed(1)}K`;
            return '';
        }
        case 'process':
        case 'opencode': {
            const exitCode = r.exitCode ?? r.code;
            if (exitCode !== undefined && exitCode !== 0) return `exit ${exitCode}`;
            if (r.pid) return `PID: ${r.pid}`;
            return '';
        }
        case 'browser': {
            const action = args?.action as string;
            if (action === 'navigate') return r.title ? String(r.title).slice(0, 30) : '';
            return '';
        }
        case 'spawn': {
            if (typeof r === 'object' && r.output) {
                const out = String(r.output);
                return out.slice(0, 40) + (out.length > 40 ? '...' : '');
            }
            return '';
        }
        default:
            return '';
    }
}
