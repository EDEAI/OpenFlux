/**
 * 浏览器录制相关类型（Gateway 侧）
 * 与 openflux-plugin/chrome/src/types.ts 保持字段一致。
 */

export type StepType =
    | 'navigate'
    | 'click'
    | 'type'
    | 'submit'
    | 'pressKey'
    | 'select'
    | 'scroll'
    | 'wait';

export interface StepSelectors {
    css: string;
    text?: string;
    role?: string;
    ariaLabel?: string;
    xpath?: string;
}

/**
 * 步骤的环境上下文（录制时采集）。
 * 回放时页面可能已改版/内容已轮换，理解"这一步想干什么"靠录制此刻的语义线索。
 */
export interface StepContext {
    /** 页面标题（document.title） */
    pageTitle?: string;
    /** 点击目标所在链接的绝对地址——可作为点击失败后的机械兜底（直接导航） */
    href?: string;
    /** 输入框的语义标签（label / placeholder） */
    label?: string;
    /** input 的 type */
    inputType?: string;
    /** 元素所在语义区块（section/form/dialog）的标题 */
    heading?: string;
    /** 所在卡片/列表项的可见文本摘要 */
    nearbyText?: string;
}

export interface RecordedStep {
    id: string;
    ts: number;
    type: StepType;
    selectors?: StepSelectors;
    url?: string;
    text?: string;
    key?: string;
    value?: string;
    tagName?: string;
    frameUrl?: string;
    screenshot?: string;
    context?: StepContext;
}

export interface Recording {
    id: string;
    title: string;
    startUrl?: string;
    createdAt: number;
    updatedAt: number;
    steps: RecordedStep[];
}

export interface RecordingSummary {
    id: string;
    title: string;
    startUrl?: string;
    createdAt: number;
    updatedAt: number;
    stepCount: number;
}
