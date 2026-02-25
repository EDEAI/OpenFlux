/**
 * 记忆系统类型定义
 */

/**
 * 记忆条目
 */
export interface MemoryEntry {
    /** 唯一 ID (UUID) */
    id: string;
    /** 记忆内容 */
    content: string;
    /** 来源文件路径 (可选) */
    sourceFile?: string;
    /** 在源文件中的行号 (可选) */
    lineNumber?: number;
    /** 创建时间 (ISO string) */
    createdAt: string;
    /** 内容哈希 (用于变更检测) */
    hash: string;
    /** 标签 (可选) */
    tags?: string[];
}

/**
 * 搜索结果
 */
export interface MemorySearchResult extends MemoryEntry {
    /** 相关度分数 (0-1) */
    score: number;
    /** 匹配类型 (vector | keyword | hybrid) */
    matchType: 'vector' | 'keyword' | 'hybrid';
}

/**
 * 搜索选项
 */
export interface MemorySearchOptions {
    /** 最大返回结果数 (默认 5) */
    limit?: number;
    /** 最小相关度阈值 (默认 0.5, 仅针对向量搜索) */
    minScore?: number;
    /** 包含具体的源文件 (默认 true) */
    includeSource?: boolean;
}

/**
 * 记忆管理器配置
 */
export interface MemoryConfig {
    /** 数据库路径 */
    dbPath: string;
    /** 向量维度 (OpenAI text-embedding-3-small = 1536) */
    vectorDim?: number;
    /** 当前 embedding 模型名 (用于检测模型切换) */
    embeddingModel?: string;
    /** MEMORY.md 文件路径 (用于读取置顶记忆) */
    memoryMdPath?: string;
    /** 是否启用调试日志 */
    debug?: boolean;
}

// ========================
// 卡片分层模型 (MemAtlas 蒸馏系统)
// ========================

/** 卡片层级 */
export type CardLayer = 'Micro' | 'Mini' | 'Macro';

/** 卡片关系类型 */
export type RelationType = 'DERIVED_FROM' | 'SUPPORTS' | 'CONFLICTS';

/**
 * 记忆卡片
 */
export interface MemoryCard {
    /** 卡片 ID (UUID) */
    cardId: string;
    /** 归属主题 ID */
    topicId?: string;
    /** 卡片层级 */
    layer: CardLayer;
    /** 卡片摘要 */
    summary: string;
    /** 时间跨度描述 */
    span?: string;
    /** 版本号 */
    version: number;
    /** 质量分数 (0-100) */
    qualityScore: number;
    /** 关联的原始记忆 ID */
    sourceEventId?: string;
    /** 标签 */
    tags?: string[];
    /** 创建时间 */
    createdAt: string;
    /** 更新时间 */
    updatedAt: string;
}

/**
 * 记忆主题
 */
export interface MemoryTopic {
    /** 主题 ID */
    topicId: string;
    /** 主题标题 */
    title: string;
    /** 创建时间 */
    createdAt: string;
    /** 更新时间 */
    updatedAt: string;
}

/**
 * 卡片关系
 */
export interface CardRelation {
    /** 源卡片 ID */
    sourceCardId: string;
    /** 目标卡片 ID */
    targetCardId: string;
    /** 关系类型 */
    relationType: RelationType;
    /** 创建时间 */
    createdAt: string;
}

/**
 * 卡片搜索结果
 */
export interface CardSearchResult extends MemoryCard {
    /** 相关度分数 (0-1) */
    score: number;
    /** 匹配类型 */
    matchType: 'vector' | 'keyword' | 'hybrid';
}

/**
 * 蒸馏配置
 */
export interface DistillationConfig {
    /** 是否启用蒸馏系统 */
    enabled: boolean;
    /** 蒸馏时段 - 开始时间 (HH:mm, 24小时制, 如 "02:00") */
    startTime: string;
    /** 蒸馏时段 - 结束时间 (HH:mm, 24小时制, 如 "06:00") */
    endTime: string;
    /** Micro 卡片最小质量分阈值 (0-100, 默认 40) */
    qualityThreshold: number;
    /** 会话密度触发合并的最小 Micro 卡片数 (默认 5) */
    sessionDensityThreshold: number;
    /** 相似度合并阈值 (0-1, 默认 0.85) */
    similarityThreshold: number;
}
