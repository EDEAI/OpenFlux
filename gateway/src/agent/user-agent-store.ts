/**
 * User Agent Store-User-level Agent management
 * 
 * Separate from the routing agent (default/coder/automation configured in openflux.yaml).
 * User-level Agent is a conversation entity managed by the user on the UI, each Agent = an independent session.
 * 
 * Stored in a JSON file. A default "Main Agent" is created automatically.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger';
import type { AgentToolsConfig, ToolProfileId } from '../tools/policy';

const log = new Logger('UserAgentStore');

/** User Agent definition */
export interface UserAgent {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    systemPrompt?: string;
    default?: boolean;
    /** Stable key of the brand preset this agent was seeded from (used to backfill deleted presets) */
    presetId?: string;
    /** 受保护的内置 Agent（如「设计师」）：不可被用户删除 */
    locked?: boolean;
    /**
     * 绑定工具 Profile。设置后，该 Agent 在执行时会切换到对应的工具集，
     * 不再走自动路由（例如 'design' = 画布/图像/联网）。
     */
    profile?: ToolProfileId;
    /** 精细工具策略（在 profile 基础上叠加 allow/deny/alsoAllow） */
    tools?: AgentToolsConfig;
    createdAt: number;
    updatedAt: number;
}

/** 内置 Agent 预设（始终随版本下发，按 presetId 回填） */
const BUILTIN_AGENT_PRESETS: AgentPresetInput[] = [
    {
        id: 'designer',
        name: '设计师',
        description: '在独立画布上用 AI 生成/编辑图像、排版与创意设计',
        icon: '🎨',
        color: '#a855f7',
        profile: 'design',
        systemPrompt: [
            '你是 OpenFlux 的「设计师」Agent，专注于视觉创作与图像设计。',
            '',
            '你拥有一块独立的无限画布（design_canvas 工具）以及图像生成（generate_image）、联网检索（web_search/web_fetch）和浏览器（browser）能力。',
            '画布会自动持久化到工作区，重开窗口或重启后仍在；窗口关闭时可用 design_canvas 的 read_canvas 离线查看历史节点。',
            '',
            '核心工作流（图片槽位优先）：',
            '1. 理解用户的创意意图，必要时先用 web_search/browser 找参考与素材。',
            '2. 确定画面尺寸/比例：',
            '   · 若用户已在画布添加「图片槽位」并选好比例，先用 get_selection 或 list_images 读取它的 targetWidth/targetHeight/aspect；',
            '   · 若没有槽位，可用 design_canvas 的 add_holder 先创建一个占位（指定 aspect，如 16-9 / 3-4），再按其尺寸生成。',
            '3. 用 generate_image 按槽位比例生成，让结果贴合槽位（避免留白）：',
            '   · 把 size 设为槽位比例。Gemini(nano banana) 直接认比例串，如 "3:4"/"16:9"；',
            '   · OpenAI(gpt-image-2) 只认像素档位，按比例就近映射：竖图→1024x1536、横图→1536x1024、方图→1024x1024；',
            '   · 不确定后端时优先传比例串；图片放进槽位会保持自身比例不拉伸，比例一致才能填满。',
            '4. 用 insert_image 把结果落到画布：填充槽位时传 holderId（图片会精确占满槽位并替换占位框）；否则缺省自动排布。',
            '   · 画布上有多个槽位时，务必先用 get_selection 确认用户选中的目标槽位、或 list_images 取得各槽位 id，按 holderId 精确填充；目标不明确就先问用户，不要随意挑一个填。',
            '',
            '改图 / 迭代工作流（必须基于原图编辑，禁止凭空重画一张）：',
            '· 用户在图上做「框选」(annotations)、「箭头」(arrows) 标注，或在图上叠加「文字便签」(notes) 写说明；选中该图后用 get_selection 读取 annotations / arrows / notes，以及 selection.path（原图本地路径）。',
            '· selection.notes 是用户叠在该图上的文字便签内容（设计画布上的文字本身不会被画进图里），把它当作针对该图的额外文字指令并入 prompt。',
            '· 关键：改图必须用 generate_image 的 image-to-image —— 把 reference_image 设为 selection.path（原图），prompt 只描述「在原图基础上要改/补什么」（结合标注 label 与其归一化位置）。绝不要不带 reference_image 重新生成，否则会得到一张与原图无关的新图。',
            '· 生成后用 insert_image 传 anchorId=原图、placement="right" 放在原图旁做前后对比，不覆盖原图。',
            '· 若带 reference_image 的 image-to-image 调用报错（如参考图 mimetype / 网关代理失败），必须如实把错误告诉用户，并停下来询问；绝不可改用「不带 reference_image 重新生成」来冒充修改结果——那会产出与原图无关的新图，属于错误行为。',
            '· 能力边界：当前图像工具是「整图重绘式 image-to-image」，没有「只在空白区域局部扩展(outpaint)」的精确能力。若用户想把留白两侧补成连贯背景，做法是以原图为 reference_image、prompt 写明「向两侧延展为 16:9 的宇宙背景、主体居中保持不变」，但能否精确保住中心取决于模型，应如实告知用户。',
            '· 留白根因多是出图比例≠槽位比例：16:9 等宽幅比例 Gemini 支持更好，OpenAI 仅 1:1/2:3/3:2，必要时提醒用户切换图像模型或改槽位比例。',
            '',
            '多图合成 / 换头工作流（需要融合多张图时）：',
            '· 关键是搞清「哪张是底图、哪张是素材、要做什么」。最佳方式是看用户画的「图↔图连接箭头」。',
            '· 用户用箭头从「素材图」指向「底图」，箭头文字写操作说明。get_selection / list_images 都会返回 links 数组：每个 link={ from(素材图,箭头尾), to(底图/目标,箭头头), label(说明) }，各含 path。',
            '  据此调用 generate_image：reference_images=[link.to.path(底图), link.from.path(素材图)]，prompt 用 link.label 说明保留什么、替换/融合什么。',
            '  例：links=[{from:目标人像, to:带墨镜的猫, label:"把头换成这个"}] → reference_images=[猫图, 人像]，prompt「保留底图的墨镜与星空背景，将主体头部替换为第二张图中的人物头部，保持墨镜异色」。',
            '· 若没有连接箭头：用 get_selection 拿选中的底图 path、list_images 拿其它图 path 来推断；用户拖入画布的图片也有本地 path；目标不清就直接问用户哪张是底图/素材。',
            '· 若某张图只有 dataUrl 而无 path（极少数落盘失败），如实告知用户并请其重新拖入，不要编造路径或凭空重画。',
            '',
            '原则：主动把每一步成果可视化到画布上，让用户像在白板上协作；保持简洁高效，优先落到画布而非只用文字描述。',
        ].join('\n'),
    },
];

/** Storage file structure */
interface UserAgentData {
    version: 1;
    agents: UserAgent[];
    /** 用户删除过的预设 key（presetId）：启动回填时跳过，防止删除的预设 Agent 复活 */
    deletedPresetIds?: string[];
    /** 用户删除过的 Agent id：启动时的 session 扫描迁移逻辑跳过，防止从历史会话自动恢复 */
    deletedAgentIds?: string[];
}

/** White-label first-run preset agent (from agentPresets in openflux.brand.yaml) */
export interface AgentPresetInput {
    id?: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    systemPrompt?: string;
    default?: boolean;
    /** 绑定工具 Profile */
    profile?: ToolProfileId;
    /** 精细工具策略 */
    tools?: AgentToolsConfig;
}

export class UserAgentStore {
    private filePath: string;
    private agents: UserAgent[] = [];
    private defaultAgentName: string;
    private presets: AgentPresetInput[];
    /** 是否注入内置预设（如「设计师」）。企业版可通过 brand 配置关闭。 */
    private includeBuiltins: boolean;
    /** 用户删除过的预设 key：回填时跳过 */
    private deletedPresetIds = new Set<string>();
    /** 用户删除过的 Agent id：供启动迁移扫描跳过 */
    private deletedAgentIds = new Set<string>();

    constructor(
        dataDir: string,
        defaultAgentName: string = 'OpenFlux Assistant',
        presets: AgentPresetInput[] = [],
        includeBuiltins: boolean = true,
    ) {
        this.filePath = join(dataDir, 'user_agents.json');
        this.defaultAgentName = defaultAgentName;
        this.presets = Array.isArray(presets) ? presets : [];
        this.includeBuiltins = includeBuiltins;
        console.error(`[UserAgentStore] Init: filePath=${this.filePath}, dataDir=${dataDir}, presets=${this.presets.length}, includeBuiltins=${this.includeBuiltins}`);
        this.load();
    }

    /** Load data, then reconcile brand presets (seed on first run, backfill deleted presets later). */
    private load(): void {
        try {
            if (existsSync(this.filePath)) {
                const raw = readFileSync(this.filePath, 'utf-8');
                const data: UserAgentData = JSON.parse(raw);
                this.agents = data.agents || [];
                this.deletedPresetIds = new Set(data.deletedPresetIds || []);
                this.deletedAgentIds = new Set(data.deletedAgentIds || []);
                log.info(`Loaded ${this.agents.length} user agents`);
            }
        } catch (e) {
            log.warn('Failed to load user agents, starting fresh', e);
            this.agents = [];
        }

        this.reconcilePresets();
    }

    /** Stable identity key for a preset, used to detect whether it still exists in the store. */
    private presetKey(p: AgentPresetInput): string {
        const explicit = p.id?.trim();
        return explicit ? `id:${explicit}` : `name:${p.name}`;
    }

    /**
     * Reconcile brand presets with stored agents. Runs on every startup:
     * - First run (empty store): seed all presets, or a single default main agent if none.
     * - Later runs: re-add any brand preset the user has deleted, so enterprise presets always
     *   come back. Existing agents (matched by presetId, even if renamed/edited) are left untouched.
     */
    private reconcilePresets(): void {
        const now = Date.now();
        let added = 0;
        let changed = false;

        // 企业版关闭内置预设（如「设计师」）：移除历史已注入的内置 locked Agent，确保配置切换后生效
        if (!this.includeBuiltins) {
            const builtinKeys = new Set(BUILTIN_AGENT_PRESETS.map(p => this.presetKey(p)));
            const before = this.agents.length;
            this.agents = this.agents.filter(a => !(a.presetId && builtinKeys.has(a.presetId)));
            if (this.agents.length !== before) {
                changed = true;
                log.info('Removed built-in preset agents (disabled by brand)');
            }
        }

        // 无品牌预设时，保留原行为：仅在空库时创建默认主 Agent
        if (this.presets.length === 0 && this.agents.length === 0) {
            this.agents.push({
                id: 'main',
                name: this.defaultAgentName,
                description: '默认对话助手',
                icon: '🤖',
                color: '#6366f1',
                default: true,
                createdAt: now,
                updatedAt: now,
            });
            added++;
            log.info('Created default main agent');
        }

        // 先回填品牌预设，再回填内置预设（设计师等）。两者都按 presetId 去重回填。
        // 内置预设标记 locked=true（不可删除）；内置注入可由企业 brand 配置关闭。
        added += this.backfillPresets(this.presets, now, false);
        if (this.includeBuiltins) {
            added += this.backfillPresets(BUILTIN_AGENT_PRESETS, now, true);
        }

        // 兜底：仍为空 → 创建默认主 Agent
        if (this.agents.length === 0) {
            this.agents.push({
                id: 'main', name: this.defaultAgentName, description: '默认对话助手',
                icon: '🤖', color: '#6366f1', default: true, createdAt: now, updatedAt: now,
            });
            added++;
        } else if (!this.agents.some(a => a.default)) {
            this.agents[0].default = true;
            added++;
        }

        if (added > 0 || changed) {
            this.save();
            log.info(`Reconciled presets: added ${added} agent(s), total ${this.agents.length}`);
            console.error(`[UserAgentStore] Reconciled presets, total ${this.agents.length} agents`);
        }
    }

    /** 按 presetId 回填一组预设（已存在则跳过），返回新增数量 */
    private backfillPresets(presets: AgentPresetInput[], now: number, locked: boolean): number {
        if (!Array.isArray(presets) || presets.length === 0) return 0;

        const usedIds = new Set(this.agents.map(a => a.id));
        const existingKeys = new Set(
            this.agents.map(a => a.presetId).filter((k): k is string => !!k),
        );
        let hasDefault = this.agents.some(a => a.default);
        let added = 0;

        for (const p of presets) {
            if (!p?.name) continue;
            const key = this.presetKey(p);
            if (existingKeys.has(key)) continue; // 仍存在（可能被改名）→ 保留不动
            if (!locked && this.deletedPresetIds.has(key)) continue; // 用户删除过的非锁定预设 → 尊重删除，不再回填

            let id = p.id?.trim() || randomUUID().slice(0, 8);
            while (usedIds.has(id)) id = randomUUID().slice(0, 8);
            usedIds.add(id);

            const isDefault = !!p.default && !hasDefault;
            if (isDefault) hasDefault = true;

            this.agents.push({
                id,
                presetId: key,
                name: p.name,
                description: p.description,
                icon: p.icon || '🤖',
                color: p.color || '#6366f1',
                systemPrompt: p.systemPrompt,
                profile: p.profile,
                tools: p.tools,
                default: isDefault || undefined,
                locked: locked || undefined,
                createdAt: now,
                updatedAt: now,
            });
            existingKeys.add(key);
            added++;
        }

        return added;
    }

    /** Persistence to file */
    private save(): void {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            const data: UserAgentData = {
                version: 1,
                agents: this.agents,
                deletedPresetIds: [...this.deletedPresetIds],
                deletedAgentIds: [...this.deletedAgentIds],
            };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.error(`[UserAgentStore] Saved ${data.agents.length} agents to ${this.filePath}`);
        } catch (e) {
            log.error('Failed to save user agents', e);
            console.error(`[UserAgentStore] SAVE FAILED: ${e}`);
        }
    }

    /** Get all user Agents */
    list(): UserAgent[] {
        return [...this.agents];
    }

    /** Get the specified Agent */
    get(id: string): UserAgent | undefined {
        return this.agents.find(a => a.id === id);
    }

    /** Create new Agent */
    create(input: { name: string; description?: string; icon?: string; color?: string; systemPrompt?: string; profile?: ToolProfileId; tools?: AgentToolsConfig }): UserAgent {
        const now = Date.now();
        const agent: UserAgent = {
            id: randomUUID().slice(0, 8),
            name: input.name || '新 Agent',
            description: input.description,
            icon: input.icon || '🤖',
            color: input.color || '#6366f1',
            systemPrompt: input.systemPrompt,
            profile: input.profile,
            tools: input.tools,
            createdAt: now,
            updatedAt: now,
        };
        this.agents.push(agent);
        this.save();
        log.info(`Created user agent: ${agent.id} (${agent.name})`);
        return agent;
    }

    /** Update Agent */
    update(id: string, updates: Partial<Omit<UserAgent, 'id' | 'createdAt'>>): UserAgent | null {
        const agent = this.agents.find(a => a.id === id);
        if (!agent) return null;

        if (updates.name !== undefined) agent.name = updates.name;
        if (updates.description !== undefined) agent.description = updates.description;
        if (updates.icon !== undefined) agent.icon = updates.icon;
        if (updates.color !== undefined) agent.color = updates.color;
        if (updates.systemPrompt !== undefined) agent.systemPrompt = updates.systemPrompt;
        if (updates.profile !== undefined) agent.profile = updates.profile;
        if (updates.tools !== undefined) agent.tools = updates.tools;
        agent.updatedAt = Date.now();

        this.save();
        log.info(`Updated user agent: ${id}`);
        return agent;
    }

    /** Update the name and system prompt of the default Agent (called when the initialization wizard is completed) */
    updateDefaultAgent(updates: { name?: string; systemPrompt?: string }): void {
        const defaultAgent = this.agents.find(a => a.default || a.id === 'main');
        if (!defaultAgent) return;

        if (updates.name) defaultAgent.name = updates.name;
        if (updates.systemPrompt !== undefined) defaultAgent.systemPrompt = updates.systemPrompt;
        defaultAgent.updatedAt = Date.now();

        this.save();
        log.info(`Default agent updated: name=${updates.name}`);
    }

    /** Delete Agent */
    delete(id: string): boolean {
        const idx = this.agents.findIndex(a => a.id === id);
        if (idx < 0) return false;

        const agent = this.agents[idx];
        if (agent.default) {
            log.warn('Cannot delete default agent');
            return false;
        }
        if (agent.locked) {
            log.warn(`Cannot delete locked built-in agent: ${id}`);
            return false;
        }

        this.agents.splice(idx, 1);
        // 记录删除墓碑：预设回填与启动时的 session 扫描都要尊重用户的删除操作
        this.deletedAgentIds.add(id);
        if (agent.presetId) this.deletedPresetIds.add(agent.presetId);
        this.save();
        log.info(`Deleted user agent: ${id}`);
        return true;
    }
}
