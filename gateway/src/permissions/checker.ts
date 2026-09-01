/** Central operational risk assessment for every ToolRegistry execution. */

import { homedir } from 'node:os';
import { parse, resolve } from 'node:path';

export enum RiskLevel {
    None = 0,
    Low = 1,
    Medium = 2,
    High = 3,
}

export const APPROVAL_MODES = ['ask', 'risk_based', 'full_access'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'risk_based';

export function isApprovalMode(value: unknown): value is ApprovalMode {
    return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function normalizeApprovalMode(
    value: unknown,
    fallback: ApprovalMode = DEFAULT_APPROVAL_MODE,
): ApprovalMode {
    return isApprovalMode(value) ? value : fallback;
}

export interface RiskAssessment {
    level: RiskLevel;
    reason: string;
    /** Immutable safety policy. A user-selected approval mode cannot bypass this. */
    blocked?: boolean;
}

function isProtectedDeleteTarget(value: unknown): boolean {
    if (typeof value !== 'string' || !value.trim()) return false;
    const raw = value.trim();
    if (raw === '~' || /^%userprofile%$/i.test(raw)) return true;

    try {
        const expanded = raw.startsWith('~') ? `${homedir()}${raw.slice(1)}` : raw;
        const target = resolve(expanded);
        return target === parse(target).root || target === resolve(homedir());
    } catch {
        return false;
    }
}

export class PermissionChecker {
    private autoApproveLevel: RiskLevel;

    constructor(autoApproveLevel: RiskLevel = RiskLevel.Low) {
        this.autoApproveLevel = autoApproveLevel;
    }

    assess(tool: string, args: Record<string, unknown> = {}): RiskAssessment {
        const name = tool.toLowerCase();
        const action = String(args.action || '').toLowerCase();
        const command = String(args.command || '').toLowerCase();
        const executableText = [args.command, args.script, args.code]
            .filter(value => typeof value === 'string')
            .join('\n');

        // Broad WMI/CIM inventory queries can leave the shared WMI Provider Host
        // saturated long after an Agent turn ends. OpenFlux has bounded, WMI-free
        // system/browser probes, so runtime-authored scripts must use those instead.
        const invokesWmi = /\b(?:wmic(?:\.exe)?|get-(?:ciminstance|wmiobject|computerinfo|nettcpconnection|netadapter|netipconfiguration|physicaldisk|disk|volume|pnpdevice)|gwmi|gcim|msinfo32(?:\.exe)?)\b/i.test(executableText);
        if (invokesWmi && ['process', 'windows', 'opencode', 'coding_agent'].includes(name)) {
            return {
                level: RiskLevel.High,
                reason: 'WMI/CIM inventory commands are blocked because they can saturate WMI Provider Host; use windows action=system',
                blocked: true,
            };
        }

        if (name === 'filesystem') {
            if (['read', 'list', 'search', 'exists', 'info', 'stat'].includes(action)) {
                return { level: RiskLevel.None, reason: `Read-only filesystem action: ${action}` };
            }
            if (action === 'delete') {
                const target = args.path ?? args.target ?? args.source;
                if (isProtectedDeleteTarget(target)) {
                    return {
                        level: RiskLevel.High,
                        reason: 'Deleting a filesystem root or the user home directory is blocked',
                        blocked: true,
                    };
                }
                return { level: RiskLevel.High, reason: 'Deleting files is destructive' };
            }
            return { level: RiskLevel.Low, reason: `Filesystem mutation: ${action || 'write'}` };
        }

        if (name === 'file_reader' || name === 'sessions_search') {
            return { level: RiskLevel.None, reason: 'Read-only data access' };
        }

        if (name === 'request_plan_input' || name === 'publish_plan_document') {
            return { level: RiskLevel.None, reason: 'Internal interactive plan state transition' };
        }

        if (name === 'memory_tool') {
            return action === 'save'
                ? { level: RiskLevel.Low, reason: 'Persisting long-term memory' }
                : { level: RiskLevel.None, reason: 'Reading long-term memory' };
        }

        if (name === 'process' || name === 'opencode' || name === 'coding_agent') {
            if (['status', 'list', 'list_drivers'].includes(action)) {
                return { level: RiskLevel.None, reason: 'Read-only process status' };
            }
            const hardBlockedCommand = /(?:^|[\s;&|])(?:diskpart|clear-disk|remove-partition)(?=\s|$)/i.test(command)
                || /(?:^|[\s;&|])format(?:\.com)?\s+[a-z]:/i.test(command)
                || /(?:^|[\s;&|])bcdedit(?:\.exe)?\s+\/delete(?=\s|$)/i.test(command);
            if (hardBlockedCommand) {
                return {
                    level: RiskLevel.High,
                    reason: 'Disk, partition, or boot configuration destruction is blocked',
                    blocked: true,
                };
            }
            const destructiveCommand = /\b(?:rm\s+-rf|del\s+\/s|shutdown|reboot)\b/.test(command)
                || /(?:^|[\s;&|])format(?:\.com)?(?=\s|$)/.test(command);
            if (action === 'kill' || destructiveCommand) {
                return { level: RiskLevel.High, reason: 'Destructive process operation' };
            }
            return { level: RiskLevel.Medium, reason: 'Executing a local process or coding agent' };
        }

        if (name === 'browser') {
            if (['status', 'snapshot', 'content', 'tabs', 'console'].includes(action)) {
                return { level: RiskLevel.None, reason: 'Read-only browser action' };
            }
            return { level: RiskLevel.Medium, reason: `Interactive browser action: ${action || 'unknown'}` };
        }

        if (name === 'windows') {
            const subAction = String(args.subAction || '').toLowerCase();
            if (
                action === 'system'
                || (action === 'clipboard' && subAction !== 'write')
                || (['window', 'app'].includes(action) && subAction === 'list')
            ) {
                return { level: RiskLevel.None, reason: `Read-only Windows action: ${action}${subAction ? `/${subAction}` : ''}` };
            }
            return { level: RiskLevel.Medium, reason: `Interactive Windows action: ${action || 'unknown'}` };
        }

        if (name === 'web_search' || name === 'web_fetch') {
            return { level: RiskLevel.Low, reason: 'Outbound read-only network request' };
        }

        if (name === 'inspect_presentation_references') {
            return { level: RiskLevel.None, reason: 'Read-only visual inspection of local presentation references' };
        }

        if (name === 'office') {
            if (['read', 'list', 'get', 'status'].includes(action)) {
                return { level: RiskLevel.None, reason: 'Read-only Office action' };
            }
            return { level: RiskLevel.Low, reason: `Office document mutation: ${action || 'unknown'}` };
        }

        if (name === 'email') {
            if (['status', 'list', 'read', 'search'].includes(action)) {
                return { level: RiskLevel.None, reason: 'Read-only email action' };
            }
            return { level: RiskLevel.High, reason: `Email external side effect: ${action || 'unknown'}` };
        }

        if (name === 'scheduler' || name === 'workflow') {
            if (['list', 'get', 'status'].includes(action)) {
                return { level: RiskLevel.None, reason: 'Read-only automation action' };
            }
            if (['delete', 'remove', 'disable'].includes(action)) {
                return { level: RiskLevel.High, reason: 'Destructive automation change' };
            }
            return { level: RiskLevel.Medium, reason: 'Creating or executing persistent automation' };
        }

        if (['macos', 'desktop', 'notify_user', 'spawn', 'sessions_spawn', 'sessions_send'].includes(name)) {
            return { level: RiskLevel.Medium, reason: `System or cross-agent side effect: ${name}` };
        }

        if (name === 'generate_image' || name === 'generate_video' || name === 'generate_presentation' || name === 'design_canvas' || name === 'skill_store') {
            return { level: RiskLevel.Low, reason: `Content or local configuration mutation: ${name}` };
        }

        // Unknown, plug-in and MCP tools are never implicitly trusted.
        return { level: RiskLevel.Medium, reason: `Unclassified tool requires approval: ${tool}` };
    }

    async assessRisk(tool: string, args?: Record<string, unknown>): Promise<RiskLevel> {
        return this.assess(tool, args).level;
    }

    async requiresConfirmation(
        tool: string,
        args?: Record<string, unknown>,
        approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
    ): Promise<boolean> {
        const assessment = this.assess(tool, args);
        if (assessment.blocked) return false;

        const threshold = approvalMode === 'ask'
            ? RiskLevel.None
            : approvalMode === 'full_access'
                ? RiskLevel.High
                : this.autoApproveLevel;
        return assessment.level > threshold;
    }

    setAutoApproveLevel(level: RiskLevel): void {
        this.autoApproveLevel = level;
    }

    getAutoApproveLevel(): RiskLevel {
        return this.autoApproveLevel;
    }

    getRiskDescription(level: RiskLevel): 'none' | 'low' | 'medium' | 'high' {
        switch (level) {
            case RiskLevel.None: return 'none';
            case RiskLevel.Low: return 'low';
            case RiskLevel.Medium: return 'medium';
            case RiskLevel.High: return 'high';
        }
    }
}
