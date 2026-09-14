export type SidebarEntitySectionId = 'pinned' | 'projects' | 'agents';
export type SidebarEntitySortMode = 'newest' | 'manual';
export type SidebarEntitySortModes = Partial<Record<SidebarEntitySectionId, SidebarEntitySortMode>>;

export interface SidebarEntityLike {
    id: string;
    kind?: string;
}

export interface SidebarEntitySection<T> {
    id: SidebarEntitySectionId;
    items: T[];
}

export interface SidebarEntityDividerSortOptions {
    activeMode?: SidebarEntitySortMode;
    menuLabel: string;
    newestLabel: string;
    manualLabel: string;
    onSelect: (mode: SidebarEntitySortMode) => void;
}

const SIDEBAR_SECTION_IDS = new Set<SidebarEntitySectionId>(['pinned', 'projects', 'agents']);
const SIDEBAR_SORT_MODES = new Set<SidebarEntitySortMode>(['newest', 'manual']);

/** Parse persisted section sort preferences while ignoring stale or malformed values. */
export function parseSidebarEntitySortModes(raw: string | null): SidebarEntitySortModes {
    if (!raw) return {};
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const result: SidebarEntitySortModes = {};
        for (const [sectionId, mode] of Object.entries(value)) {
            if (SIDEBAR_SECTION_IDS.has(sectionId as SidebarEntitySectionId)
                && SIDEBAR_SORT_MODES.has(mode as SidebarEntitySortMode)) {
                result[sectionId as SidebarEntitySectionId] = mode as SidebarEntitySortMode;
            }
        }
        return result;
    } catch {
        return {};
    }
}

/** Sort one section by activity time without disturbing ties. */
export function sortSidebarEntitySection<T>(
    items: T[],
    mode: SidebarEntitySortMode | undefined,
    timestamp: (item: T) => number,
): T[] {
    if (!mode || mode === 'manual') return [...items];
    const sourceRank = new Map(items.map((item, index) => [item, index]));
    return [...items].sort((left, right) => {
        const delta = timestamp(right) - timestamp(left);
        return delta || (sourceRank.get(left) ?? 0) - (sourceRank.get(right) ?? 0);
    });
}

/**
 * Split an already sorted entity list into stable sidebar sections. Pinned
 * entities stay together at the top regardless of whether they are projects or
 * Agents; unpinned projects and Agents then receive their own sections.
 */
export function buildSidebarEntitySections<T extends SidebarEntityLike>(
    entities: T[],
    pinnedIds: Iterable<string>,
): SidebarEntitySection<T>[] {
    const pinned = new Set(pinnedIds);
    const sections: Record<SidebarEntitySectionId, T[]> = {
        pinned: [],
        projects: [],
        agents: [],
    };

    for (const entity of entities) {
        if (pinned.has(entity.id)) sections.pinned.push(entity);
        else if (entity.kind === 'project') sections.projects.push(entity);
        else sections.agents.push(entity);
    }

    return (['pinned', 'projects', 'agents'] as const)
        .map(id => ({ id, items: sections[id] }))
        .filter(section => section.items.length > 0);
}

/** Create the section heading used between pinned, project, and Agent groups. */
export function createSidebarEntityDivider(
    document: Document,
    sectionId: SidebarEntitySectionId,
    label: string,
    sort?: SidebarEntityDividerSortOptions,
): HTMLElement {
    const divider = document.createElement('div');
    divider.className = 'sidebar-entity-divider';
    divider.dataset.sidebarSection = sectionId;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', label);

    const labelElement = document.createElement('span');
    labelElement.className = 'sidebar-entity-divider-label';
    labelElement.textContent = label;
    divider.appendChild(labelElement);

    if (sort) {
        const control = document.createElement('div');
        control.className = 'sidebar-section-sort-control';

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'sidebar-section-sort-trigger';
        trigger.setAttribute('aria-label', sort.menuLabel);
        trigger.setAttribute('title', sort.menuLabel);
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

        const menu = document.createElement('div');
        menu.className = 'sidebar-section-sort-menu hidden';
        menu.setAttribute('role', 'menu');

        const closeMenu = () => {
            menu.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
        };

        const addOption = (mode: SidebarEntitySortMode, optionLabel: string) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'sidebar-section-sort-option';
            option.dataset.sortMode = mode;
            option.setAttribute('role', 'menuitemradio');
            option.setAttribute('aria-checked', String(sort.activeMode === mode));

            const check = document.createElement('span');
            check.className = 'sidebar-section-sort-check';
            check.textContent = sort.activeMode === mode ? '✓' : '';
            check.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.textContent = optionLabel;
            option.append(check, text);
            option.addEventListener('click', event => {
                event.stopPropagation();
                closeMenu();
                sort.onSelect(mode);
            });
            menu.appendChild(option);
        };

        addOption('newest', sort.newestLabel);
        addOption('manual', sort.manualLabel);

        trigger.addEventListener('click', event => {
            event.stopPropagation();
            const opening = menu.classList.contains('hidden');
            document.querySelectorAll('.sidebar-section-sort-menu').forEach(element => element.classList.add('hidden'));
            document.querySelectorAll('.sidebar-section-sort-trigger').forEach(element => element.setAttribute('aria-expanded', 'false'));
            menu.classList.remove('opens-upward');
            menu.classList.toggle('hidden', !opening);
            trigger.setAttribute('aria-expanded', String(opening));
            if (opening) {
                const boundary = divider.parentElement?.getBoundingClientRect();
                const dividerBounds = divider.getBoundingClientRect();
                const menuBounds = menu.getBoundingClientRect();
                if (boundary
                    && menuBounds.bottom > boundary.bottom
                    && dividerBounds.top - menuBounds.height >= boundary.top) {
                    menu.classList.add('opens-upward');
                }
            }
        });
        control.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            closeMenu();
            trigger.focus();
        });

        control.append(trigger, menu);
        divider.appendChild(control);
    }
    return divider;
}
