/**
 * design_canvas 工具
 *
 * 让「设计师」Agent 与独立的画布窗口协作：
 * - status：查询画布窗口是否已打开
 * - get_selection：读取用户在画布上选中的图片/区域/槽位（用于二次编辑或定向生成的参考）
 * - list_images：列出画布上的图片节点 + AI 图片槽位
 * - add_holder：添加一个 AI 图片槽位（按比例预设占位，供后续按尺寸生成图片填充）
 * - insert_image：把一张图片（本地路径或 URL）插入画布，可填充槽位 / 锚点旁避让放置
 * - add_text：在画布上添加文字便签
 * - read_canvas：离线读取画布快照文件（画布窗口未打开时仍可查看历史节点）
 *
 * 工具本身不直接操作画布，而是通过网关把命令下发给已连接的画布窗口（role=canvas），
 * 并等待窗口回包。命令的实际执行在 canvas.html 窗口内完成。
 */

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'fs';
import { extname } from 'node:path';
import type { AnyTool, ToolResult, ToolExecutionContext } from '../types';
import { readStringParam, readNumberParam, validateAction, jsonResult, errorResult } from '../common';

const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

/** 读取本地图片并转成 data URL（画布窗口无法直接访问本地文件，故由网关侧内联） */
async function fileToDataUrl(path: string): Promise<string> {
    const buf = await readFile(path);
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] || 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
}

const ACTIONS = ['status', 'get_selection', 'list_images', 'add_holder', 'insert_image', 'add_text', 'read_canvas'] as const;

/** 可用的比例预设（与画布窗口保持一致） */
const ASPECTS = ['1-1', '3-2', '2-3', '4-3', '3-4', '16-9', '9-16'];

export interface DesignCanvasToolOptions {
    /**
     * 向画布窗口下发命令并等待结果。
     * 若画布窗口未打开应 reject。
     */
    command: (command: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
    /** 画布窗口当前是否已连接 */
    isOpen: () => boolean;
    /** 画布快照落盘文件路径（用于 read_canvas 离线读取） */
    snapshotPath?: string;
}

export function createDesignCanvasTool(options: DesignCanvasToolOptions): AnyTool {
    const { command, isOpen, snapshotPath } = options;

    return {
        name: 'design_canvas',
        description:
            '与 OpenFlux 设计画布（独立无限画布窗口）协作的工具。\n'
            + '能力：status(画布是否打开) / get_selection(读取用户选中的图片或槽位) / list_images(列出图片与槽位) / '
            + 'add_holder(添加 AI 图片槽位) / insert_image(插入或填充图片) / add_text(文字便签) / read_canvas(离线读取快照)。\n'
            + '\n推荐工作流：\n'
            + '1) 用户先在画布上添加「图片槽位」并选好比例，或你用 add_holder 创建；\n'
            + '2) 调 get_selection 读取该槽位的 targetWidth/targetHeight/aspect，作为生成尺寸的契约；\n'
            + '3) 用 generate_image 按该尺寸/比例生成图片；\n'
            + '4) insert_image 时传 holderId（或槽位处于选中态）把图片精确填充到槽位、并替换占位框。\n'
            + '   多个槽位时，必须按用户选中的槽位或明确的 holderId 填充，目标不清就先问用户。\n'
            + '\n改图工作流：用户在某张图上做标注后选中它，get_selection 返回 selection.path（原图路径）、'
            + 'selection.annotations（框选的归一化 0..1 区域 + label）、selection.arrows（箭头指向的归一化点 target{x,y} + label）'
            + '与 selection.notes（叠在该图上的文字便签内容，作为额外文字指令，需并入 prompt）。'
            + '改图必须走 image-to-image：调 generate_image 时把 reference_image 设为 selection.path，prompt 只描述要改/补的内容（含 notes 中的诉求），'
            + '不要不带参考图重画。生成后用 insert_image 传 anchorId=该图、placement="right" 在原图右侧避让放置新版本，便于前后对比。\n'
            + '\n多图合成工作流（换头 / 把某张图的人脸或物体融入另一张 / 风格迁移）：\n'
            + '- 这类任务需要多张参考图，关键是搞清「哪张是底图、哪张是素材、要做什么」。\n'
            + '- 【推荐】用户用箭头连接两张图来表达关联：箭头从「素材图」指向「底图」，箭头文字是操作说明。'
            + 'get_selection 与 list_images 都会返回 links 数组：每个 link = { from(素材图,箭头尾), to(底图/目标,箭头头), label(说明) }，各含 path/caption。'
            + '据此调用 generate_image：reference_images=[link.to.path(底图), link.from.path(素材图)]，prompt 用 link.label 说明保留什么、替换/融合什么。\n'
            + '- 若没有连接箭头，再退而用 get_selection(选中的底图) + list_images 推断，必要时直接问用户哪张是底图/素材。\n'
            + '- 例如换头：links=[{from:目标人像, to:带墨镜的猫, label:"把头换成这个"}] → reference_images=[猫(底图), 人像(素材)]，prompt「保留底图的墨镜与背景，将主体头部替换为第二张图中的人物头部」。\n'
            + '- 若某张图只有 dataUrl 没有 path（极少数落盘失败情形），提示用户重新拖入或告知无法读取，不要凭空编造。\n'
            + '\n所有图片优先用本地 path（generate_image 返回的文件）；画布会持久化到工作区，可用 read_canvas 离线查看。',
        priority: 45,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型：${ACTIONS.join(' / ')}`,
                required: true,
                enum: [...ACTIONS],
            },
            path: {
                type: 'string',
                description: 'insert_image：图片的本地绝对路径（generate_image 返回的 files 之一，优先使用）',
                required: false,
            },
            url: {
                type: 'string',
                description: 'insert_image：图片的 http(s) URL（与 path 二选一）',
                required: false,
            },
            caption: {
                type: 'string',
                description: 'insert_image：图片下方的说明文字（可选）',
                required: false,
            },
            text: {
                type: 'string',
                description: 'add_text：要添加的文字内容',
                required: false,
            },
            aspect: {
                type: 'string',
                description: `add_holder：图片槽位比例预设，可选 ${ASPECTS.join(' / ')}（缺省 3-4 竖图）`,
                required: false,
                enum: ASPECTS,
            },
            holderId: {
                type: 'string',
                description: 'insert_image：把图片填充到指定 AI 图片槽位的 id（来自 list_images.holders 或 get_selection）；填充后会用图片替换该占位框',
                required: false,
            },
            anchorId: {
                type: 'string',
                description: 'insert_image：参照节点 id；配合 placement 在该节点旁避让放置（用于前后对比，不指定 x/y 时生效）',
                required: false,
            },
            placement: {
                type: 'string',
                description: 'insert_image：相对 anchorId 的放置方向 right / left / below / above（默认 right）',
                required: false,
                enum: ['right', 'left', 'below', 'above'],
            },
            x: {
                type: 'number',
                description: '插入位置 X（画布坐标，可选，缺省自动排布）',
                required: false,
            },
            y: {
                type: 'number',
                description: '插入位置 Y（画布坐标，可选，缺省自动排布）',
                required: false,
            },
        },

        async execute(args: Record<string, unknown>, _context?: ToolExecutionContext): Promise<ToolResult> {
            try {
                const action = validateAction(args, ACTIONS);

                if (action === 'status') {
                    return jsonResult({ open: isOpen() });
                }

                // read_canvas 离线读取：即使画布窗口未打开也能查看历史快照
                if (action === 'read_canvas') {
                    if (!snapshotPath || !existsSync(snapshotPath)) {
                        return jsonResult({ exists: false, nodes: [] });
                    }
                    try {
                        const raw = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
                        const nodes = (raw?.snapshot?.nodes || []).map((n: any) => ({
                            id: n.id, type: n.type, caption: n.caption, text: n.text, aspect: n.aspect,
                            path: n.path, url: n.url,
                            bbox: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) },
                        }));
                        return jsonResult({ exists: true, savedAt: raw?.savedAt, nodes });
                    } catch (e) {
                        return errorResult(`读取画布快照失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                }

                if (!isOpen()) {
                    return errorResult('画布窗口未打开。请提示用户在 OpenFlux 中点击「打开设计画布」后再试。');
                }

                switch (action) {
                    case 'get_selection': {
                        const res = await command('get_selection', {});
                        return jsonResult(res ?? { selection: null });
                    }
                    case 'list_images': {
                        const res = await command('list_images', {});
                        return jsonResult(res ?? { images: [], holders: [] });
                    }
                    case 'add_holder': {
                        const res = await command('add_holder', {
                            aspect: readStringParam(args, 'aspect') || undefined,
                            x: readNumberParam(args, 'x'),
                            y: readNumberParam(args, 'y'),
                        });
                        return jsonResult(res ?? { inserted: true });
                    }
                    case 'insert_image': {
                        const path = readStringParam(args, 'path');
                        const url = readStringParam(args, 'url');
                        if (!path && !url) return errorResult('insert_image 需要 path 或 url');
                        // 本地路径：网关读文件转 data URL（画布窗口无法访问本地文件系统）
                        let dataUrl: string | undefined;
                        if (path) {
                            try {
                                dataUrl = await fileToDataUrl(path);
                            } catch (e) {
                                return errorResult(`读取图片失败：${e instanceof Error ? e.message : String(e)}`);
                            }
                        }
                        const res = await command('insert_image', {
                            path: path || undefined,      // 保留原始路径，供 get_selection 二次编辑使用
                            url: url || undefined,
                            dataUrl,                       // 用于画布显示
                            caption: readStringParam(args, 'caption') || undefined,
                            holderId: readStringParam(args, 'holderId') || undefined,
                            anchorId: readStringParam(args, 'anchorId') || undefined,
                            placement: readStringParam(args, 'placement') || undefined,
                            x: readNumberParam(args, 'x'),
                            y: readNumberParam(args, 'y'),
                        }, 30000);
                        return jsonResult(res ?? { inserted: true });
                    }
                    case 'add_text': {
                        const text = readStringParam(args, 'text');
                        if (!text) return errorResult('add_text 需要 text');
                        const res = await command('add_text', {
                            text,
                            x: readNumberParam(args, 'x'),
                            y: readNumberParam(args, 'y'),
                        });
                        return jsonResult(res ?? { inserted: true });
                    }
                }
                return errorResult(`未知操作：${action}`);
            } catch (err) {
                return errorResult(err instanceof Error ? err.message : String(err));
            }
        },
    };
}
