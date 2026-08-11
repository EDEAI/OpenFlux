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
