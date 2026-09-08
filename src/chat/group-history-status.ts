/** History progress is local to its group, not a permanent chat banner. */
export function groupHistoryStatusView(status: string): { text: string; retry: boolean } {
    if (['completed', 'not_requested'].includes(status)) return { text: '', retry: false };
    if (['pending', 'fetching', 'delivery_pending'].includes(status)) {
        return { text: '正在同步历史消息…', retry: false };
    }
    if (status === 'cancelled') return { text: '历史同步已暂停', retry: false };
    return { text: '历史消息暂未同步完成', retry: true };
}
