/**
 * Permissions Checker - Operational Risk Assessment
 */

export enum RiskLevel {
    None = 0,    // read-only operation
    Low = 1,     // low risk write operations
    Medium = 2,  // medium risk operation
    High = 3,    // high risk operations
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
            // read-only operation
            { tool: 'read_file', level: RiskLevel.None },
            { tool: 'list_directory', level: RiskLevel.None },

            // low risk write operations
            { tool: 'write_file', level: RiskLevel.Low },

            // medium risk operation
            {
                tool: 'run_command',
                level: RiskLevel.Medium,
                conditions: (args) => {
                    const cmd = (args.command as string || '').toLowerCase();
                    // Dangerous orders elevated to high risk
                    if (cmd.includes('rm -rf') || cmd.includes('del /s') || cmd.includes('format')) {
                        return RiskLevel.High;
                    }
                    return RiskLevel.Medium;
                }
            },
            { tool: 'browser_open', level: RiskLevel.Medium },
            { tool: 'opencode', level: RiskLevel.Medium },

            // high risk operations
            { tool: 'delete_file', level: RiskLevel.High },
        ];
    }

    /**
     * Assess operational risk levels
     */
    async assessRisk(tool: string, args?: Record<string, unknown>): Promise<RiskLevel> {
        const rule = this.rules.find(r => r.tool === tool);

        if (!rule) {
            // Unknown tools default to medium risk
            return RiskLevel.Medium;
        }

        if (rule.conditions && args) {
            return rule.conditions(args);
        }

        return rule.level;
    }

    /**
     * Check if confirmation is needed
     */
    async requiresConfirmation(tool: string, args?: Record<string, unknown>): Promise<boolean> {
        const level = await this.assessRisk(tool, args);
        return level > this.autoApproveLevel;
    }

    /**
     * Set automatic approval levels
     */
    setAutoApproveLevel(level: RiskLevel): void {
        this.autoApproveLevel = level;
    }

    /**
     * Get risk description
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
