/**
 * Memory system type definition
 */

/**
 * memory entry
 */
export interface MemoryEntry {
    /** Unique ID (UUID) */
    id: string;
    /** Memory content */
    content: string;
    /** Source file path (optional) */
    sourceFile?: string;
    /** Line number in source file (optional) */
    lineNumber?: number;
    /** Creation time (ISO string) */
    createdAt: string;
    /** Content hash (for change detection) */
    hash: string;
    /** label (optional) */
    tags?: string[];
}

/**
 * Search results
 */
export interface MemorySearchResult extends MemoryEntry {
    /** Relevance score (0-1) */
    score: number;
    /** Match type (vector | keyword | hybrid) */
    matchType: 'vector' | 'keyword' | 'hybrid';
}

/**
 * Search options
 */
export interface MemorySearchOptions {
    /** Maximum number of results returned (default 5) */
    limit?: number;
    /** Minimum correlation threshold (default 0.5, only for vector searches) */
    minScore?: number;
    /** Include specific source files (default true) */
    includeSource?: boolean;
}

/**
 * Memory manager configuration
 */
export interface MemoryConfig {
    /** Database path */
    dbPath: string;
    /** Vector dimension (OpenAI text-embedding-3-small = 1536) */
    vectorDim?: number;
    /** Current embedding model name (used to detect model switching) */
    embeddingModel?: string;
    /** MEMORY.md file path (used to read the sticky memory) */
    memoryMdPath?: string;
    /** Whether to enable debugging logs */
    debug?: boolean;
}

// ========================
// Card Layered Model (MemAtlas Distillation System)
// ========================

/** Card level */
export type CardLayer = 'Micro' | 'Mini' | 'Macro';

/** Card relationship type */
export type RelationType = 'DERIVED_FROM' | 'SUPPORTS' | 'CONFLICTS';

/**
 * memory card
 */
export interface MemoryCard {
    /** Card ID (UUID) */
    cardId: string;
    /** Attribution topic ID */
    topicId?: string;
    /** Card level */
    layer: CardLayer;
    /** Card summary */
    summary: string;
    /** Time span description */
    span?: string;
    /** Version number */
    version: number;
    /** Quality score (0-100) */
    qualityScore: number;
    /** Associated original memory ID */
    sourceEventId?: string;
    /** Label */
    tags?: string[];
    /** Creation time */
    createdAt: string;
    /** Update time */
    updatedAt: string;
}

/**
 * memory theme
 */
export interface MemoryTopic {
    /** Topic ID */
    topicId: string;
    /** Topic title */
    title: string;
    /** Creation time */
    createdAt: string;
    /** Update time */
    updatedAt: string;
}

/**
 * card relationship
 */
export interface CardRelation {
    /** Source card ID */
    sourceCardId: string;
    /** Target card ID */
    targetCardId: string;
    /** Relationship type */
    relationType: RelationType;
    /** Creation time */
    createdAt: string;
}

/**
 * Card search results
 */
export interface CardSearchResult extends MemoryCard {
    /** Relevance score (0-1) */
    score: number;
    /** Match type */
    matchType: 'vector' | 'keyword' | 'hybrid';
}

/**
 * Distillation configuration
 */
export interface DistillationConfig {
    /** Whether to enable distillation system */
    enabled: boolean;
    /** Distillation period - start time (HH:mm, 24-hour format, such as "02:00") */
    startTime: string;
    /** Distillation period - end time (HH:mm, 24-hour format, such as "06:00") */
    endTime: string;
    /** Micro card minimum quality score threshold (0-100, default 40) */
    qualityThreshold: number;
    /** Minimum number of Micro cards for session density to trigger merge (default 5) */
    sessionDensityThreshold: number;
    /** Similarity merging threshold (0-1, default 0.85) */
    similarityThreshold: number;
}
