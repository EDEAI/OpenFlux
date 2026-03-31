/**
 * 卡片管理器
 * 基于 MemAtlas 机制实现记忆卡片的分层蒸馏
 * 
 * 独立于原有 MemoryManager，不影响其正常工作
 */
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { Logger } from '../../utils/logger';
import { LLMProvider } from '../../llm/provider';
import {
    CardLayer, MemoryCard, MemoryTopic, CardRelation,
    CardSearchResult, DistillationConfig, RelationType
} from './types';

/** 默认蒸馏配置 */
const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
    enabled: false,
    startTime: '02:00',
    endTime: '06:00',
    qualityThreshold: 40,
    sessionDensityThreshold: 5,
    similarityThreshold: 0.85,
};

/**
 * LLM 统一提取结果
 */
interface CardExtractionResult {
    quality: {
        informationDensity: number;
        actionability: number;
        longTermValue: number;
        uniqueness: number;
    };
    topics: string[];
    summary: string;
}

export class CardManager extends EventEmitter {
    private logger = new Logger('CardManager');
    private distillationConfig: DistillationConfig;

    constructor(
        private db: Database.Database,
        private chatLLM: LLMProvider,      // chat 能力 (摘要提取)
        private embeddingLLM: LLMProvider,  // embed 能力 (向量索引/搜索)
        config?: Partial<DistillationConfig>
    ) {
        super();
        this.distillationConfig = { ...DEFAULT_DISTILLATION_CONFIG, ...config };

        // 确保卡片向量表存在
        this.ensureCardVecTable();
        this.logger.info('CardManager initialized', {
            enabled: this.distillationConfig.enabled,
            schedule: `${this.distillationConfig.startTime} - ${this.distillationConfig.endTime}`
        });
    }

    // ========================
    // 配置管理
    // ========================

    /** 获取蒸馏配置 */
    getConfig(): DistillationConfig {
        return { ...this.distillationConfig };
    }

    /** 更新蒸馏配置 */
    updateConfig(config: Partial<DistillationConfig>) {
        this.distillationConfig = { ...this.distillationConfig, ...config };
        this.emit('configUpdated', this.distillationConfig);
        this.logger.info('Distillation config updated', config);
    }

    /** 更新 chat LLM */
    updateChatLLM(newLLM: LLMProvider) {
        this.chatLLM = newLLM;
    }

    /** 更新 embedding LLM */
    updateEmbeddingLLM(newLLM: LLMProvider) {
        this.embeddingLLM = newLLM;
    }

    // ========================
    // 卡片 CRUD
    // ========================

    /**
     * 从原始记忆内容生成 Micro 卡片
     * 
     * @param content 记忆内容 (来自 MemoryManager.add)
     * @param memoryId 原始记忆 ID (关联用)
     */
    async generateMicroCard(content: string, memoryId: string): Promise<MemoryCard | null> {
        if (!this.distillationConfig.enabled) return null;

        try {
            // 1. LLM 统一提取：质量、主题、摘要
            const extraction = await this.extractCardInfo(content);
            if (!extraction) {
                this.logger.debug('LLM extraction failed, skipping card generation');
                return null;
            }

            // 2. 质量门控
            const qualityScore = (
                extraction.quality.informationDensity +
                extraction.quality.actionability +
                extraction.quality.longTermValue +
                extraction.quality.uniqueness
            ) / 4;

            if (qualityScore < this.distillationConfig.qualityThreshold) {
                this.logger.debug(`Quality insufficient, skipping (${qualityScore.toFixed(1)} < ${this.distillationConfig.qualityThreshold})`);
                return null;
            }

            // 3. 语义去重检查
            const isDuplicate = await this.checkDuplicate(extraction.summary, 'Micro');
            if (isDuplicate) {
                this.logger.debug('Duplicate card detected, skipping');
                return null;
            }

            // 4. 获取/创建主题
            const primaryTopic = extraction.topics[0] || 'Uncategorized';
            const topicId = await this.getOrCreateTopic(primaryTopic);

            // 5. 创建卡片
            const card = this.insertCard({
                topicId,
                layer: 'Micro',
                summary: extraction.summary,
                span: new Date().toISOString().split('T')[0],
                qualityScore,
                sourceEventId: memoryId,
                tags: extraction.topics,
            });

            // 6. 生成卡片摘要的向量索引
            await this.indexCardVector(card);

            // 7. 为其他主题建立关系
            for (let i = 1; i < extraction.topics.length; i++) {
                const secTopicId = await this.getOrCreateTopic(extraction.topics[i]);
                // 通过 tag 标记关联即可（轻量实现）
            }

            this.logger.info(`✅ Micro card generated: "${extraction.summary.substring(0, 50)}..."`, {
                cardId: card.cardId,
                quality: qualityScore.toFixed(1),
                topic: primaryTopic
            });

            this.emit('cardCreated', card);
            return card;

        } catch (error) {
            this.logger.error('Failed to generate Micro card', { error: String(error) });
            return null;
        }
    }

    /**
     * 插入卡片到数据库
     */
    private insertCard(data: {
        topicId: string;
        layer: CardLayer;
        summary: string;
        span?: string;
        qualityScore: number;
        sourceEventId?: string;
        tags?: string[];
    }): MemoryCard {
        const now = new Date().toISOString();
        const card: MemoryCard = {
            cardId: uuidv4(),
            topicId: data.topicId,
            layer: data.layer,
            summary: data.summary,
            span: data.span,
            version: 1,
            qualityScore: data.qualityScore,
            sourceEventId: data.sourceEventId,
            tags: data.tags,
            createdAt: now,
            updatedAt: now,
        };

        this.db.prepare(`
            INSERT INTO memory_cards (card_id, topic_id, layer, summary, span, version, quality_score, source_event_id, tags, created_at, updated_at)
            VALUES (@cardId, @topicId, @layer, @summary, @span, @version, @qualityScore, @sourceEventId, @tags, @createdAt, @updatedAt)
        `).run({
            ...card,
            tags: card.tags ? JSON.stringify(card.tags) : null,
        });

        return card;
    }

    /**
     * 获取单个卡片
     */
    getCard(cardId: string): MemoryCard | undefined {
        const row = this.db.prepare('SELECT * FROM memory_cards WHERE card_id = ?').get(cardId) as any;
        if (!row) return undefined;
        return this.rowToCard(row);
    }

    /**
     * 按层级查询卡片
     */
    getCardsByLayer(layer: CardLayer, limit = 50): MemoryCard[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_cards WHERE layer = ? ORDER BY created_at DESC LIMIT ?'
        ).all(layer, limit) as any[];
        return rows.map(r => this.rowToCard(r));
    }

    /**
     * 按主题查询卡片
     */
    getCardsByTopic(topicId: string, limit = 50): MemoryCard[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_cards WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(topicId, limit) as any[];
        return rows.map(r => this.rowToCard(r));
    }

    /**
     * 删除卡片
     */
    deleteCard(cardId: string): boolean {
        const tx = this.db.transaction(() => {
            const row = this.db.prepare('SELECT rowid FROM memory_cards WHERE card_id = ?').get(cardId) as any;
            if (!row) return false;

            // 删除向量
            try { this.db.prepare('DELETE FROM cards_vec WHERE rowid = ?').run(row.rowid); } catch { /* 可能不存在 */ }
            // 删除关系
            this.db.prepare('DELETE FROM card_relations WHERE source_card_id = ? OR target_card_id = ?').run(cardId, cardId);
            // 删除卡片
            this.db.prepare('DELETE FROM memory_cards WHERE card_id = ?').run(cardId);
            return true;
        });
        return tx() as boolean;
    }

    // ========================
    // 主题管理
    // ========================

    /**
     * 获取或创建主题
     */
    async getOrCreateTopic(title: string): Promise<string> {
        // 先精确匹配
        const existing = this.db.prepare(
            'SELECT topic_id FROM memory_topics WHERE title = ?'
        ).get(title) as { topic_id: string } | undefined;

        if (existing) return existing.topic_id;

        // 语义相似匹配（通过向量搜索 topic title）
        // 简化实现：直接创建新主题
        const topicId = createHash('md5').update(title).digest('hex').substring(0, 16);

        this.db.prepare(`
            INSERT OR IGNORE INTO memory_topics (topic_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?)
        `).run(topicId, title, new Date().toISOString(), new Date().toISOString());

        return topicId;
    }

    /**
     * 列出所有主题
     */
    listTopics(): MemoryTopic[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_topics ORDER BY updated_at DESC'
        ).all() as any[];
        return rows.map(r => ({
            topicId: r.topic_id,
            title: r.title,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    // ========================
    // 关系管理
    // ========================

    /**
     * 创建卡片关系
     */
    addRelation(sourceId: string, targetId: string, type: RelationType) {
        this.db.prepare(`
            INSERT INTO card_relations (source_card_id, target_card_id, relation_type)
            VALUES (?, ?, ?)
        `).run(sourceId, targetId, type);
    }

    /**
     * 获取派生自某卡片的所有子卡片
     */
    getDerivedCards(cardId: string): MemoryCard[] {
        const rows = this.db.prepare(`
            SELECT mc.* FROM memory_cards mc
            JOIN card_relations cr ON mc.card_id = cr.source_card_id
            WHERE cr.target_card_id = ? AND cr.relation_type = 'DERIVED_FROM'
            ORDER BY mc.created_at DESC
        `).all(cardId) as any[];
        return rows.map(r => this.rowToCard(r));
    }

    // ========================
    // 向量搜索
    // ========================

    /**
     * 语义搜索卡片
     */
    async searchCards(query: string, options: {
        limit?: number;
        minScore?: number;
        layer?: CardLayer;
    } = {}): Promise<CardSearchResult[]> {
        const limit = options.limit || 10;
        const minScore = options.minScore || 0.3;

        const scores = new Map<number | bigint, { score: number; type: 'vector' | 'keyword' | 'hybrid' }>();

        // 1. 向量搜索
        try {
            const queryEmbedding = await this.embeddingLLM.embed(query);
            const vecResults = this.db.prepare(`
                SELECT rowid, distance FROM cards_vec
                WHERE embedding MATCH ?
                ORDER BY distance LIMIT ?
            `).all(new Float32Array(queryEmbedding), limit * 2) as { rowid: number; distance: number }[];

            for (const res of vecResults) {
                const score = 1 - res.distance;
                if (score >= minScore) {
                    scores.set(res.rowid, { score, type: 'vector' });
                }
            }
        } catch (e) {
            this.logger.warn('Card vector search failed, using keyword search', { error: String(e) });
        }

        // 2. FTS 搜索
        try {
            const ftsQuery = `"${query.replace(/"/g, '""')}"`;
            const ftsResults = this.db.prepare(`
                SELECT rowid, rank FROM cards_fts
                WHERE cards_fts MATCH ? ORDER BY rank LIMIT ?
            `).all(ftsQuery, limit * 2) as { rowid: number; rank: number }[];

            for (const res of ftsResults) {
                const existing = scores.get(res.rowid);
                if (existing) {
                    existing.score = Math.min(1, existing.score * 1.2);
                    existing.type = 'hybrid';
                } else {
                    scores.set(res.rowid, { score: 0.7, type: 'keyword' });
                }
            }
        } catch (e) {
            this.logger.warn('Card FTS search failed', { error: String(e) });
        }

        if (scores.size === 0) return [];

        // 3. 按层级加权
        const results: CardSearchResult[] = [];
        const sorted = Array.from(scores.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, limit);

        const stmt = this.db.prepare('SELECT * FROM memory_cards WHERE rowid = ?');
        for (const [rowid, info] of sorted) {
            const row = stmt.get(rowid) as any;
            if (!row) continue;

            // 层级加权: Macro > Mini > Micro
            let layerBoost = 1.0;
            if (row.layer === 'Macro') layerBoost = 1.15;
            else if (row.layer === 'Mini') layerBoost = 1.08;

            // 应用层级过滤
            if (options.layer && row.layer !== options.layer) continue;

            results.push({
                ...this.rowToCard(row),
                score: Math.min(1, info.score * layerBoost),
                matchType: info.type,
            });
        }

        return results.sort((a, b) => b.score - a.score);
    }

    /**
     * 检索分层上下文 (用于注入 Agent Prompt)
     * 
     * 检索策略: Macro 概要 → 相关 Mini → 细节 Micro
     */
    async retrieveLayeredContext(query: string): Promise<string> {
        if (!this.distillationConfig.enabled) return '';

        const results = await this.searchCards(query, { limit: 15 });
        if (results.length === 0) return '';

        // 按层级分组
        const macros = results.filter(r => r.layer === 'Macro');
        const minis = results.filter(r => r.layer === 'Mini');
        const micros = results.filter(r => r.layer === 'Micro');

        let context = '';

        if (macros.length > 0) {
            context += '\n## Long-term Memory Overview\n';
            macros.forEach((c, i) => {
                context += `${i + 1}. ${c.summary} (relevance: ${c.score.toFixed(2)})\n`;
            });
        }

        if (minis.length > 0) {
            context += '\n## Recent Memories\n';
            minis.slice(0, 5).forEach((c, i) => {
                context += `${i + 1}. ${c.summary} (relevance: ${c.score.toFixed(2)})\n`;
            });
        }

        if (micros.length > 0 && macros.length === 0 && minis.length === 0) {
            // 仅当没有高层卡片时才展示 Micro
            context += '\n## Memory Fragments\n';
            micros.slice(0, 5).forEach((c, i) => {
                context += `${i + 1}. ${c.summary} (relevance: ${c.score.toFixed(2)})\n`;
            });
        }

        if (context) {
            this.logger.info(`Hierarchical retrieval: ${macros.length} Macro + ${minis.length} Mini + ${micros.length} Micro`);
        }

        return context;
    }

    // ========================
    // 统计
    // ========================

    getStats(): {
        totalCards: number;
        microCount: number;
        miniCount: number;
        macroCount: number;
        topicCount: number;
        relationCount: number;
    } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM memory_cards').get() as any).c;
        const micro = (this.db.prepare("SELECT COUNT(*) as c FROM memory_cards WHERE layer='Micro'").get() as any).c;
        const mini = (this.db.prepare("SELECT COUNT(*) as c FROM memory_cards WHERE layer='Mini'").get() as any).c;
        const macro = (this.db.prepare("SELECT COUNT(*) as c FROM memory_cards WHERE layer='Macro'").get() as any).c;
        const topics = (this.db.prepare('SELECT COUNT(*) as c FROM memory_topics').get() as any).c;
        const relations = (this.db.prepare('SELECT COUNT(*) as c FROM card_relations').get() as any).c;

        return {
            totalCards: total, microCount: micro, miniCount: mini,
            macroCount: macro, topicCount: topics, relationCount: relations
        };
    }

    // ========================
    // 会话自动沉淀 (P1)
    // ========================

    /**
     * 对话历史自动沉淀为 Micro 卡片
     * 将即将被滑窗丢弃的对话消息压缩为卡片，实现永久记忆
     * 
     * @param messages 即将被丢弃的消息数组
     * @param sessionId 来源会话 ID（标记用）
     */
    async distillConversation(
        messages: Array<{ role: string; content: string }>,
        sessionId?: string
    ): Promise<MemoryCard | null> {
        if (messages.length === 0) return null;

        try {
            // 合并消息为一段对话文本
            const conversationText = messages
                .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
                .join('\n');

            // 截断避免过长
            const truncated = conversationText.length > 3000
                ? conversationText.slice(0, 3000) + '\n...(truncated)'
                : conversationText;

            // 用现有 LLM 提取管道
            const extraction = await this.extractCardInfo(truncated);
            if (!extraction) {
                this.logger.debug('Conversation distillation: LLM extraction returned null');
                return null;
            }

            // 质量门控（对话沉淀用较低阈值，因为任何有效信息都值得保留）
            const qualityScore = (
                extraction.quality.informationDensity +
                extraction.quality.actionability +
                extraction.quality.longTermValue +
                extraction.quality.uniqueness
            ) / 4;

            if (qualityScore < Math.max(this.distillationConfig.qualityThreshold - 10, 20)) {
                this.logger.debug(`Conversation quality too low (${qualityScore.toFixed(1)}), skipping`);
                return null;
            }

            // 去重
            const isDuplicate = await this.checkDuplicate(extraction.summary, 'Micro');
            if (isDuplicate) {
                this.logger.debug('Duplicate conversation card detected, skipping');
                return null;
            }

            const primaryTopic = extraction.topics[0] || 'Conversation';
            const topicId = await this.getOrCreateTopic(primaryTopic);

            const tags = [...extraction.topics, 'auto_distill'];
            if (sessionId) tags.push(`session:${sessionId}`);

            const card = this.insertCard({
                topicId,
                layer: 'Micro',
                summary: extraction.summary,
                span: new Date().toISOString().split('T')[0],
                qualityScore,
                sourceEventId: sessionId,
                tags,
            });

            await this.indexCardVector(card);

            this.logger.info(`🧠 Conversation auto-distilled: "${extraction.summary.slice(0, 60)}..."`, {
                cardId: card.cardId,
                quality: qualityScore.toFixed(1),
                messageCount: messages.length,
            });

            this.emit('cardCreated', card);
            return card;

        } catch (error) {
            this.logger.error('Conversation distillation failed', { error: String(error) });
            return null;
        }
    }

    /**
     * 协作结果自动沉淀为 Micro 卡片（带 collaboration tag 实现记忆隔离）
     */
    async distillCollaboration(params: {
        agentId: string;
        task: string;
        output?: string;
        status: string;
        sessionId?: string;
    }): Promise<MemoryCard | null> {
        if (!params.output && params.status !== 'completed') return null;

        try {
            const content = `Agent "${params.agentId}" executed task: ${params.task}\nResult: ${params.output?.slice(0, 1000) || params.status}`;

            const extraction = await this.extractCardInfo(content);
            if (!extraction) return null;

            const qualityScore = (
                extraction.quality.informationDensity +
                extraction.quality.actionability +
                extraction.quality.longTermValue +
                extraction.quality.uniqueness
            ) / 4;

            if (qualityScore < 25) return null; // 协作结果用更低阈值

            const isDuplicate = await this.checkDuplicate(extraction.summary, 'Micro');
            if (isDuplicate) return null;

            const topicId = await this.getOrCreateTopic(extraction.topics[0] || 'Collaboration');

            const card = this.insertCard({
                topicId,
                layer: 'Micro',
                summary: extraction.summary,
                span: new Date().toISOString().split('T')[0],
                qualityScore,
                tags: ['collaboration', `agent:${params.agentId}`, ...extraction.topics],
            });

            await this.indexCardVector(card);

            this.logger.info(`🤝 Collaboration result distilled: "${extraction.summary.slice(0, 60)}..."`, {
                cardId: card.cardId, agentId: params.agentId,
            });

            this.emit('cardCreated', card);
            return card;

        } catch (error) {
            this.logger.error('Collaboration distillation failed', { error: String(error) });
            return null;
        }
    }

    // ========================
    // 内部方法
    // ========================

    /**
     * 确保卡片向量表存在
     */
    private ensureCardVecTable() {
        try {
            // 从 memory_meta 获取当前配置的维度
            let configDim = 1536;
            try {
                const meta = this.db.prepare("SELECT value FROM memory_meta WHERE key='vector_dim'").get() as any;
                if (meta) {
                    const d = parseInt(meta.value, 10);
                    if (!isNaN(d) && d > 0) configDim = d;
                }
            } catch { /* 忽略 */ }

            const exists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='cards_vec'"
            ).get();

            if (exists) {
                // 表已存在，检查维度是否匹配
                try {
                    // 用一个零向量测试当前表的维度
                    const testVec = new Float32Array(configDim);
                    this.db.prepare(
                        'SELECT rowid FROM cards_vec WHERE embedding MATCH ? LIMIT 1'
                    ).all(testVec);
                    // 查询成功说明维度匹配
                } catch (dimErr: any) {
                    if (String(dimErr).includes('Dimension mismatch')) {
                        this.logger.warn(`Card vector table dimension mismatch, rebuilding to ${configDim} dimensions`);
                        this.db.exec('DROP TABLE cards_vec');
                        this.db.exec(`CREATE VIRTUAL TABLE cards_vec USING vec0(embedding float[${configDim}] distance_metric=cosine)`);
                        this.logger.info(`Card vector table rebuilt (dimensions: ${configDim})`);
                    }
                }
                return;
            }

            // 表不存在，创建
            this.db.exec(`CREATE VIRTUAL TABLE cards_vec USING vec0(embedding float[${configDim}] distance_metric=cosine)`);
            this.logger.info(`Card vector table created (dimensions: ${configDim})`);
        } catch (error) {
            this.logger.error('Failed to create card vector table', { error: String(error) });
        }
    }

    /**
     * 索引卡片向量
     */
    private async indexCardVector(card: MemoryCard) {
        try {
            const embedding = await this.embeddingLLM.embed(card.summary);
            const rowid = this.db.prepare(
                'SELECT rowid FROM memory_cards WHERE card_id = ?'
            ).get(card.cardId) as { rowid: number } | undefined;

            if (rowid) {
                this.db.prepare('INSERT INTO cards_vec(rowid, embedding) VALUES (?, ?)')
                    .run(BigInt(rowid.rowid), new Float32Array(embedding));
            }
        } catch (error) {
            this.logger.warn('Card vector indexing failed', { cardId: card.cardId, error: String(error) });
        }
    }

    /**
     * 语义去重检查
     */
    private async checkDuplicate(summary: string, layer: CardLayer): Promise<boolean> {
        try {
            const embedding = await this.embeddingLLM.embed(summary);
            const results = this.db.prepare(`
                SELECT rowid, distance FROM cards_vec
                WHERE embedding MATCH ?
                ORDER BY distance LIMIT 3
            `).all(new Float32Array(embedding)) as { rowid: number; distance: number }[];

            for (const res of results) {
                const similarity = 1 - res.distance;
                if (similarity >= 0.95) {
                    // 检查是否同层
                    const card = this.db.prepare(
                        'SELECT layer FROM memory_cards WHERE rowid = ?'
                    ).get(res.rowid) as { layer: string } | undefined;
                    if (card && card.layer === layer) return true;
                }
            }
            return false;
        } catch {
            return false; // 查重失败不阻断
        }
    }

    /**
     * 使用 LLM 统一提取卡片信息
     */
    private async extractCardInfo(content: string): Promise<CardExtractionResult | null> {
        try {
            const prompt = `You are a memory analysis expert. Analyze the following conversation content and return the following information in JSON format:

1. Quality assessment (0-100 for each):
   - information_density: How much valuable facts, preferences, or decisions the content contains
   - actionability: Whether it can be used for personalization in future interactions
   - long_term_value: Whether it will still be useful a week from now
   - uniqueness: Whether it contains new user characteristic information

2. Topic list: 2-3 most relevant topic keywords

3. Summary: A one-sentence concise summary capturing the core information with key details

Conversation content:
"""
${content}
"""

Return JSON only, no extra text:
{
  "quality": {"information_density": 0, "actionability": 0, "long_term_value": 0, "uniqueness": 0},
  "topics": ["topic1", "topic2"],
  "summary": "one-sentence summary"
}`;

            const response = await this.chatLLM.chat([
                { role: 'user', content: prompt }
            ]);

            const text = typeof response === 'string' ? response : (response as any)?.content || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const parsed = JSON.parse(jsonMatch[0]);
            return {
                quality: {
                    informationDensity: parsed.quality?.information_density ?? 0,
                    actionability: parsed.quality?.actionability ?? 0,
                    longTermValue: parsed.quality?.long_term_value ?? 0,
                    uniqueness: parsed.quality?.uniqueness ?? 0,
                },
                topics: Array.isArray(parsed.topics) ? parsed.topics : [],
                summary: parsed.summary || content.substring(0, 200),
            };

        } catch (error) {
            this.logger.error('LLM extraction failed', { error: String(error) });
            return null;
        }
    }

    /**
     * 数据库行转 MemoryCard
     */
    private rowToCard(row: any): MemoryCard {
        return {
            cardId: row.card_id,
            topicId: row.topic_id,
            layer: row.layer as CardLayer,
            summary: row.summary,
            span: row.span,
            version: row.version,
            qualityScore: row.quality_score,
            sourceEventId: row.source_event_id,
            tags: row.tags ? JSON.parse(row.tags) : undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
