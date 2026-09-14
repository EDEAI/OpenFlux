/**
 * Agent icon catalog.
 *
 * The UI stores a stable `tabler:*` id instead of SVG markup. Assets are a
 * curated subset of Tabler Icons v3.46.0 (MIT) vendored under
 * public/agent-icons/tabler so rendering is identical across desktop systems.
 */

export interface AgentIconOption {
    id: string;
    assetName: string;
    labelKey: string;
}

export const DEFAULT_AGENT_ICON = 'tabler:robot';

export const AGENT_ICON_OPTIONS: readonly AgentIconOption[] = [
    { id: 'tabler:robot', assetName: 'robot', labelKey: 'agent.icon_option_assistant' },
    { id: 'tabler:message-chatbot', assetName: 'message-chatbot', labelKey: 'agent.icon_option_chat' },
    { id: 'tabler:brain', assetName: 'brain', labelKey: 'agent.icon_option_analysis' },
    { id: 'tabler:bulb', assetName: 'bulb', labelKey: 'agent.icon_option_ideas' },
    { id: 'tabler:palette', assetName: 'palette', labelKey: 'agent.icon_option_design' },
    { id: 'tabler:tool', assetName: 'tool', labelKey: 'agent.icon_option_tools' },
    { id: 'tabler:code', assetName: 'code', labelKey: 'agent.icon_option_code' },
    { id: 'tabler:chart-bar', assetName: 'chart-bar', labelKey: 'agent.icon_option_data' },
    { id: 'tabler:pencil', assetName: 'pencil', labelKey: 'agent.icon_option_writing' },
    { id: 'tabler:search', assetName: 'search', labelKey: 'agent.icon_option_research' },
    { id: 'tabler:rocket', assetName: 'rocket', labelKey: 'agent.icon_option_launch' },
    { id: 'tabler:bolt', assetName: 'bolt', labelKey: 'agent.icon_option_fast' },
    { id: 'tabler:target-arrow', assetName: 'target-arrow', labelKey: 'agent.icon_option_goals' },
    { id: 'tabler:shield-check', assetName: 'shield-check', labelKey: 'agent.icon_option_security' },
    { id: 'tabler:book-2', assetName: 'book-2', labelKey: 'agent.icon_option_knowledge' },
    { id: 'tabler:music', assetName: 'music', labelKey: 'agent.icon_option_audio' },
    { id: 'tabler:world', assetName: 'world', labelKey: 'agent.icon_option_web' },
    { id: 'tabler:users-group', assetName: 'users-group', labelKey: 'agent.icon_option_collaboration' },
    { id: 'tabler:terminal-2', assetName: 'terminal-2', labelKey: 'agent.icon_option_terminal' },
    { id: 'tabler:automation', assetName: 'automation', labelKey: 'agent.icon_option_automation' },
] as const;

const SELECTABLE_ASSETS = new Map(AGENT_ICON_OPTIONS.map(option => [option.id, option.assetName]));

/** Extra assets are render-only aliases for values created by older versions. */
const COMPATIBILITY_ASSETS = new Map<string, string>([
    ['tabler:folder', 'folder'],
    ['tabler:building-store', 'building-store'],
    ['tabler:shopping-bag', 'shopping-bag'],
    ['tabler:briefcase', 'briefcase'],
]);

const LEGACY_ICON_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    '🤖': 'tabler:robot',
    '💬': 'tabler:message-chatbot',
    '🧠': 'tabler:brain',
    '💡': 'tabler:bulb',
    '🎨': 'tabler:palette',
    '🔧': 'tabler:tool',
    '🛠': 'tabler:tool',
    '🛠️': 'tabler:tool',
    '💻': 'tabler:code',
    '📊': 'tabler:chart-bar',
    '📝': 'tabler:pencil',
    '🔍': 'tabler:search',
    '🚀': 'tabler:rocket',
    '⚡': 'tabler:bolt',
    '🎯': 'tabler:target-arrow',
    '🛡': 'tabler:shield-check',
    '🛡️': 'tabler:shield-check',
    '📚': 'tabler:book-2',
    '🎵': 'tabler:music',
    '🌐': 'tabler:world',
    '🤝': 'tabler:users-group',
    '👨‍💻': 'tabler:terminal-2',
    '🧑‍💻': 'tabler:terminal-2',
    '🦾': 'tabler:automation',
    '📁': 'tabler:folder',
    '🏪': 'tabler:building-store',
    '🛍': 'tabler:shopping-bag',
    '🛍️': 'tabler:shopping-bag',
    '💼': 'tabler:briefcase',
});

/** Resolve old emoji values without rewriting persisted user data. */
export function normalizeAgentIcon(icon?: string): string {
    const value = icon?.trim() || DEFAULT_AGENT_ICON;
    return LEGACY_ICON_ALIASES[value] || value;
}

export function getAgentIconAssetName(icon?: string): string | undefined {
    const value = normalizeAgentIcon(icon);
    return SELECTABLE_ASSETS.get(value) || COMPATIBILITY_ASSETS.get(value);
}

/** Render a trusted catalog entry as a currentColor CSS-mask glyph. */
export function renderAgentVectorIcon(icon?: string, size: number = 24): string | undefined {
    const assetName = getAgentIconAssetName(icon);
    if (!assetName) return undefined;
    const safeSize = Math.min(128, Math.max(8, Math.round(Number.isFinite(size) ? size : 24)));
    return `<span class="agent-vector-icon" aria-hidden="true" style="--agent-icon-size:${safeSize}px;--agent-icon-mask:url('/agent-icons/tabler/${assetName}.svg')"></span>`;
}
