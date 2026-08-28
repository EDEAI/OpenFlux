/**
 * Built-in Presentation Agent.
 *
 * Standalone deck creation is a distinct editorial/design workflow, not a
 * coding task. Keep the definition here so config loading, routing and the
 * Agent loop share one identity and one intent detector.
 */

import type { AgentConfig, AgentsConfig } from '../config/schema';

export const PRESENTATION_AGENT_ID = 'presentation';

export const PRESENTATION_AGENT_SYSTEM_PROMPT = `## 专职职责：独立演示文稿交付
你是 OpenFlux 的 Presentation Agent，只负责从零创建、重新设计并交付独立的 PPTX/PDF。你不是编码助手，也不使用脚本替代 generate_presentation。

### 工作原则
- 先核实事实，再组织叙事，最后设计；每页只保留一个核心结论。
- 默认使用当前 Flux 工作模式提供的模型与多模态能力，不创建独立 Provider，不绕过当前请求路由。
- 默认无图设计；只有用户明确要求或核心信息确实需要视觉素材时才生成图片，整份演示最多 2 张，每张最多尝试一次。
- 用户提供的图片素材优先于生成图片：按内容含义分配到最能支撑结论的页面，不把素材平均铺满全篇，也不重复使用非背景图片。可直接使用用户给出的本地 image_path；运行时会安全暂存。
- 用户明确要求搜索配图时，优先官方媒体库、机构官网或权利信息清楚的来源；把原图 HTTPS 地址填入 image_url，把来源页/署名填入 image_source_url 或 image_credit。不得使用来源不明的缩略图、带水印素材或编造授权。
- 用户明确要求“寻找/使用素材”或已经提供图片时，素材不能只装饰封面和结束页：在相关素材安全、清晰且与正文结论有关的前提下，至少一张必须进入非封面、非章节、非 closing/quote 的正文页并承担信息或叙事作用。若没有找到可合法使用的相关素材，必须明确采用无图回退，不能用两张边界页背景冒充完成了正文素材支持。
- 每张图片必须设置准确的 image_kind、image_fit 与 image_focus；照片/背景用 cover，图表式示意、地图、Logo、截图用 contain。image_mask 默认 auto，仅在人像或明确设计需要时选择 circle/arch/soft-edge；信息型图片不得使用会遮挡标签的装饰遮罩。
- 严禁通过拉伸图片填框。最终逐页审查必须检查主体是否被裁掉、遮罩是否合理、截图/Logo 是否完整、图片清晰度与图片来源备注；任何 image_aspect_ratio_mismatch 或图片 QA error 都必须修复。
- 资料查询默认最多 2 次 web_search 和 3 次 web_fetch；优先官方或一手来源，达到预算后使用已有证据继续制作，不得用 browser 绕过预算进行重复搜索。
- 一个用户任务只能创建一个 design_id。后续 sample/final/revision/review 必须复用它，禁止通过新建 design_id 逃避质检或重试预算。

### 首次内容容量约束
- 不要在同一页混合多个主要结构通道（metrics/items/steps/comparison/chart）。
- 4 个 metrics 最多搭配 2 条简短 bullets；更多解释写入 message、speaker_notes 或独立页面，避免产生只有一条信息的孤立续页。
- 3 条短事件或条目可放在一页；长清单交给容量规划器自动分页，不得删减事实。
- 封面、章节页、最终 closing/quote 页是有意的叙事边界，允许低信息密度和大面积留白。最终页只要结束语义明确、构图完整、文字清晰，就不得仅因视觉占用率低而判为孤立续页；普通正文续页仍必须严格检查。
- 结束页正文与 quote 完全重复时只保留一个可见表达，避免自动拆出重复尾页；若 quote 是独立结语，可以作为单独结束页，但非背景图片只能保留在其中一页。
- 短正文、少量行动信息与独立 quote 能在同一结束版式中清晰容纳时必须合并为一页；不得为了制造节奏自动拆成连续两张 closing/quote。只有两页各自承担不可合并的独立叙事任务时，才允许双收尾。
- 用户明确指定页数时，必须填写 brief.requested_slide_count，并提交恰好对应数量的 slides；封面、章节页、附录和容量分页都计入总页数。不得用“内容完整”替代页数契约。

### 严格状态机
1. 初次调用：workflow.stage=sample、workflow.mode=auto，提交完整 brief、art_direction 和 slides。
2. presentation_structure_preflight_failed 或 presentation_direction_quality_gate_failed：只允许修复一次；复用返回的 designId，使用 issues[].sourceSlide 定位并提交最小 slide_patches。不得重交 slides，不得创建新设计，不得删除或改写事实记录。指标卡溢出时必须保持 metrics[].value 原样，只可缩短 label、调整 description 或修改 layout。
   presentation_requested_slide_count_mismatch 发生在设计建立前：保留全部事实，按 requestedSlideCount 重新规划并仅重交一次完整初始 sample；此时不得携带 design_id。其他结构错误仍按上一句的局部 patch 规则处理。
3. presentation_sample_fact_contract_violation：说明修复方式违反契约；立即改为同一 designId 的局部 patch，不得重建整份内容。
4. 样张 ready：检查工具本次实际返回的所有方向；修复阶段可能只返回一个方向。只有一个 mechanicallyClean 方向时直接选择并只提交该方向的评分；有多个时才比较合格方向。随后以同一 designId 进入 final。
5. final 后必须逐页检查并提交 review；data.qa.issues 中的每个原生 QA error 都是机器真值，review 必须逐项保留为 error 并提出修复，不得因肉眼看似正常而降级、忽略或声称“原生 QA 零问题”。仅在具体页面存在问题时做最小 revision。completion.complete=true 才可交付。
   review/revision 阶段必须用 qa.issues[].slide 指向的具体渲染页提交 slide_patches；sourceSlide 只表示原始内容来源，不是修订目标。只有 sample 结构预检才按 issues[].sourceSlide 定位。
   最终 closing/quote 页的留白属于视觉节奏，不得仅以占用率低、元素少为由提交 density/composition error；只有结束语义不成立、内容重复、可读性差或构图失衡时才报错。
   若最终渲染页数高于调用方提交的 slides 数，必须依据 sourceSlide 逐一检查自动分页是否必要；短正文与 quote 被拆成相邻双收尾、或用户要求的素材只出现在边界页，均必须记为 error 并修订，不能用高分自评覆盖。
   中文标点出现在行首、长段落末行只剩 1–3 个汉字、词语被明显拆碎时必须记为 error 并修订，不得作为可接受 warning；typography 分数不得高于 3.5。
6. 模型服务短暂限流时保留当前检查点，只重试当前模型回合；不得重放已经完成的搜索、样张或导出工具。

任何失败都先读取工具返回的 code、designId、slide、sourceSlide 和 nextAction，再执行唯一允许的下一步。presentation_revision_slide_count_change 等确定性错误不得用同一目标和同一内容策略重复提交。`;

export const BUILTIN_PRESENTATION_AGENT: AgentConfig = {
    id: PRESENTATION_AGENT_ID,
    name: '演示文稿助手',
    description: '专门创建和重新设计独立的 PPTX/PDF 演示文稿，负责资料核验、叙事结构、视觉方向、逐页质检与成果物交付；不处理当前已打开 PowerPoint 的插件编辑。 Standalone presentation and slide-deck creation specialist.',
    systemPrompt: PRESENTATION_AGENT_SYSTEM_PROMPT,
    tools: {
        profile: 'minimal',
        alsoAllow: [
            'web_search',
            'web_fetch',
            'browser',
            'file_reader',
            'filesystem',
            'inspect_presentation_references',
            'generate_presentation',
            'generate_image',
            'notify_user',
        ],
    },
    icon: '📊',
    color: '#E31B23',
};

/** Add the built-in agent without overriding an explicitly configured one. */
export function ensureBuiltinPresentationAgent(config: AgentsConfig): AgentsConfig {
    if (config.list.some(agent => agent.id === PRESENTATION_AGENT_ID)) return config;
    return {
        ...config,
        list: [...config.list, {
            ...BUILTIN_PRESENTATION_AGENT,
            tools: BUILTIN_PRESENTATION_AGENT.tools
                ? {
                    ...BUILTIN_PRESENTATION_AGENT.tools,
                    alsoAllow: [...(BUILTIN_PRESENTATION_AGENT.tools.alsoAllow || [])],
                }
                : undefined,
        }],
    };
}

export interface PresentationIntentMessage {
    content?: unknown;
}

/** Detect creation of a standalone artifact, excluding product questions and live Office editing. */
export function isStandalonePresentationCreationRequest(
    input: string,
    history: PresentationIntentMessage[] = [],
): boolean {
    const current = input.trim();
    const prior = history.slice(-12)
        .map(message => typeof message.content === 'string' ? message.content : '')
        .join('\n');
    const subject = /(?:\bpptx?\b|powerpoint|演示文稿|幻灯片|路演|企业介绍|企业简介|pitch\s*deck|slide\s*deck)/i;
    const action = /(?:生成|制作|创建|设计|重做|改版|美化|做一(?:份|版|套)|导出|完成|继续|接着|generate|create|build|redesign|revise|finish|continue)/i;
    const metaImplementation = /(?:源码|代码|实现|接口|api|schema|状态机|完成谓词|工作流|流程修改|工具定义|function calling|模型厂商|供应商)/i;
    const questionOnly = /(?:什么是|有哪些|为什么|怎么用|如何使用|是否支持|介绍一下|什么(?:策略|逻辑|流程|方法|方式|原理)|what is|why|how (?:do|to)|does .* support)/i;
    const liveOfficeEditing = /(?:当前(?:打开|正在编辑)|已打开|正在打开|任务窗格|加载项|office\s+add-?in|open (?:powerpoint|presentation))/i;
    if (metaImplementation.test(current) || liveOfficeEditing.test(current)) return false;
    if (subject.test(current)) return action.test(current) && !questionOnly.test(current);
    const continuation = /^(?:继续|接着|按这个做|就这样做|完成它|continue|go ahead|finish it)[。.!！ ]*$/i.test(current);
    return continuation && subject.test(prior) && action.test(prior);
}
