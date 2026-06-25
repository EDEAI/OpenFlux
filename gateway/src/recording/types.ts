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
