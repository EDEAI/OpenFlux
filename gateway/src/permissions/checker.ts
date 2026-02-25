/**
 * 权限检查器 - 操作风险评估
 */

export enum RiskLevel {
    None = 0,    // 只读操作
    Low = 1,     // 低风险写操作
    Medium = 2,  // 中风险操作
    High = 3,    // 高风险操作
}

interface RiskRule {
    tool: string;
    level: RiskLevel;
    conditions?: (args: Record<string, unknown>) => RiskLevel;
}

export class PermissionChecker {
    private autoApproveLevel: RiskLevel = RiskLevel.Low;
    private rules: RiskRule[] = [];

    constructor() {
        this.initDefaultRules();
    }

    private initDefaultRules(): void {
        this.rules = [
            // 只读操作
            { tool: 'read_file', level: RiskLevel.None },
            { tool: 'list_directory', level: RiskLevel.None },

            // 低风险写操作
            { tool: 'write_file', level: RiskLevel.Low },

            // 中风险操作
            {
                tool: 'run_command',
                level: RiskLevel.Medium,
                conditions: (args) => {
                    const cmd = (args.command as string || '').toLowerCase();
                    // 危险命令提升为高风险
                    if (cmd.includes('rm -rf') || cmd.includes('del /s') || cmd.includes('format')) {
                        return RiskLevel.High;
                    }
                    return RiskLevel.Medium;
                }
            },
            { tool: 'browser_open', level: RiskLevel.Medium },
            { tool: 'opencode', level: RiskLevel.Medium },

            // 高风险操作
            { tool: 'delete_file', level: RiskLevel.High },
        ];
    }

    /**
     * 评估操作风险级别
     */
    async assessRisk(tool: string, args?: Record<string, unknown>): Promise<RiskLevel> {
        const rule = this.rules.find(r => r.tool === tool);

        if (!rule) {
            // 未知工具默认为中风险
            return RiskLevel.Medium;
        }

        if (rule.conditions && args) {
            return rule.conditions(args);
        }

        return rule.level;
    }

    /**
     * 检查是否需要确认
     */
    async requiresConfirmation(tool: string, args?: Record<string, unknown>): Promise<boolean> {
        const level = await this.assessRisk(tool, args);
        return level > this.autoApproveLevel;
    }

    /**
     * 设置自动批准级别
     */
    setAutoApproveLevel(level: RiskLevel): void {
        this.autoApproveLevel = level;
    }

    /**
     * 获取风险描述
     */
    getRiskDescription(level: RiskLevel): string {
        switch (level) {
            case RiskLevel.None: return '无风险（只读）';
            case RiskLevel.Low: return '低风险';
            case RiskLevel.Medium: return '中风险';
            case RiskLevel.High: return '高风险';
        }
    }
}
