/**
 * 卡片升级引擎
 * 实现 MemAtlas 的三种升级策略:
 *   1. 会话密度合并: 同主题下 Micro 卡片数达到阈值时合并为 Mini
 *   2. 语义相似度合并: 跨主题发现高相似 Micro 卡片合并为 Mini
 *   3. 定时聚合: 按日/周维度将 Mini 聚合为 Macro
 */
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../utils/logger';
import { LLMProvider } from '../../llm/provider';
import { CardLayer, MemoryCard, DistillationConfig } from './types';
import { CardManager } from './card-manager';

export class CardUpgrader extends EventEmitter {
    private logger = new Logger('CardUpgrader');

    constructor(
        private db: Database.Database,
        private chatLLM: LLMProvider,       // chat 能力 (合并摘要)
        private embeddingLLM: LLMProvider,   // embed 能力 (向量索引)
        private cardManager: CardManager,
        private config: DistillationConfig
    ) {
        super();
    }

    /** 更新配置 */
    updateConfig(config: DistillationConfig) {
        this.config = config;
    }

    /** 更新 chat LLM */
    updateChatLLM(newLLM: LLMProvider) {
        this.chatLLM = newLLM;
    }

    /** 更新 embedding LLM */
    updateEmbeddingLLM(newLLM: LLMProvider) {
        this.embeddingLLM = newLLM;
    }

    /**
     * 执行完整蒸馏流程 (在蒸馏时段调用)
     */
    async runDistillation(): Promise<{
        sessionDensity: number;
        semanticMerge: number;
        timedAggregation: number;
    }> {
        const logId = this.createDistillationLog('full');

        try {
            this.logger.info('🌙 开始蒸馏流程...');

            const r1 = await this.sessionDensityMerge();
            const r2 = await this.semanticSimilarityMerge();
            const r3 = await this.timedAggregation();

            const result = {
                sessionDensity: r1,
                semanticMerge: r2,
                timedAggregation: r3,
            };

            this.completeDistillationLog(logId, r1 + r2 + r3, 'completed');
            this.logger.info('🌙 蒸馏完成', result);
            this.emit('distillationCompleted', result);
            return result;

        } catch (error) {
            this.completeDistillationLog(logId, 0, 'failed');
            this.logger.error('蒸馏失败', { error: String(error) });
            throw error;
        }
    }

    // ========================
    // 策略 1: 会话密度合并 (Micro → Mini)
    // ========================

    /**
     * 按主题检查 Micro 卡片累积量，达到阈值则合并为 Mini
     */
    async sessionDensityMerge(): Promise<number> {
        const threshold = this.config.sessionDensityThreshold;

        // 查找卡片数超过阈值的主题
        const topics = this.db.prepare(`
            SELECT topic_id, COUNT(*) as cnt
            FROM memory_cards
            WHERE layer = 'Micro'
            GROUP BY topic_id
            HAVING cnt >= ?
        `).all(threshold) as { topic_id: string; cnt: number }[];

        let mergedCount = 0;

        for (const topic of topics) {
            try {
                // 获取该主题下的 Micro 卡片
                const micros = this.db.prepare(`
                    SELECT * FROM memory_cards
                    WHERE topic_id = ? AND layer = 'Micro'
                    ORDER BY created_at ASC
                    LIMIT ?
                `).all(topic.topic_id, threshold) as any[];

                if (micros.length < threshold) continue;

                // LLM 合并摘要
                const summaries = micros.map((m: any) => m.summary);
                const mergedSummary = await this.llmMergeSummaries(summaries, 'Mini');
                if (!mergedSummary) continue;

                // 计算平均质量分
                const avgQuality = micros.reduce((sum: number, m: any) => sum + (m.quality_score || 0), 0) / micros.length;

                // 计算时间跨度
                const span = `${micros[0].created_at.split('T')[0]} ~ ${micros[micros.length - 1].created_at.split('T')[0]}`;

                // 创建 Mini 卡片
                const miniCard = this.insertUpgradedCard({
                    topicId: topic.topic_id,
                    layer: 'Mini',
                    summary: mergedSummary,
                    span,
                    qualityScore: Math.min(100, avgQuality * 1.1), // 合并后略微加分
                    tags: this.mergeTags(micros),
                });

                // 建立 DERIVED_FROM 关系
                for (const micro of micros) {
                    this.cardManager.addRelation(miniCard.cardId, micro.card_id, 'DERIVED_FROM');
                }

                // 索引向量
                await this.indexCardVector(miniCard);

                mergedCount++;
                this.logger.info(`📦 会话密度合并: ${micros.length} Micro → 1 Mini (主题: ${topic.topic_id})`);

            } catch (error) {
                this.logger.error(`主题 ${topic.topic_id} 合并失败`, { error: String(error) });
            }
        }

        return mergedCount;
    }

    // ========================
    // 策略 2: 语义相似度合并 (Micro → Mini)
    // ========================

    /**
     * 跨主题发现语义相近的 Micro 卡片，合并为 Mini
     */
    async semanticSimilarityMerge(): Promise<number> {
        const threshold = this.config.similarityThreshold;

        // 获取所有未合并的 Micro 卡片
        const micros = this.db.prepare(`
            SELECT mc.* FROM memory_cards mc
            WHERE mc.layer = 'Micro'
            AND mc.card_id NOT IN (
                SELECT DISTINCT cr.target_card_id
                FROM card_relations cr
                WHERE cr.relation_type = 'DERIVED_FROM'
            )
            ORDER BY mc.created_at DESC
            LIMIT 100
        `).all() as any[];

        if (micros.length < 2) return 0;

        // 聚类: 找相似组
        const clusters: any[][] = [];
        const used = new Set<string>();

        for (const card of micros) {
            if (used.has(card.card_id)) continue;

            const row = this.db.prepare(
                'SELECT rowid FROM memory_cards WHERE card_id = ?'
            ).get(card.card_id) as { rowid: number } | undefined;
            if (!row) continue;

            // 查找相似卡片
            let similarCards: any[];
            try {
                // 获取该卡片的向量
                const vecData = this.db.prepare(
                    'SELECT embedding FROM cards_vec WHERE rowid = ?'
                ).get(row.rowid) as any;
                if (!vecData) continue;

                const vecResults = this.db.prepare(`
                    SELECT rowid, distance FROM cards_vec
                    WHERE embedding MATCH ?
                    ORDER BY distance LIMIT 10
                `).all(vecData.embedding) as { rowid: number; distance: number }[];

                similarCards = vecResults
                    .filter(v => v.rowid !== row.rowid && (1 - v.distance) >= threshold)
                    .map(v => {
                        const c = this.db.prepare('SELECT * FROM memory_cards WHERE rowid = ?').get(v.rowid) as any;
                        return c ? { ...c, similarity: 1 - v.distance } : null;
                    })
                    .filter(c => c && c.layer === 'Micro' && !used.has(c.card_id));
            } catch {
                continue;
            }

            if (similarCards.length === 0) continue;

            const cluster = [card, ...similarCards];
            cluster.forEach(c => used.add(c.card_id));
            clusters.push(cluster);
        }

        // 合并每个聚类
        let mergedCount = 0;
        for (const cluster of clusters) {
            if (cluster.length < 2) continue;

            try {
                const summaries = cluster.map(c => c.summary);
                const mergedSummary = await this.llmMergeSummaries(summaries, 'Mini');
                if (!mergedSummary) continue;

                const avgQuality = cluster.reduce((sum: number, c: any) => sum + (c.quality_score || 0), 0) / cluster.length;
                const span = `${cluster[0].created_at.split('T')[0]} ~ ${cluster[cluster.length - 1].created_at.split('T')[0]}`;

                const miniCard = this.insertUpgradedCard({
                    topicId: cluster[0].topic_id, // 使用第一个卡片的主题
                    layer: 'Mini',
                    summary: mergedSummary,
                    span,
                    qualityScore: Math.min(100, avgQuality * 1.1),
                    tags: this.mergeTags(cluster),
                });

                for (const micro of cluster) {
                    this.cardManager.addRelation(miniCard.cardId, micro.card_id, 'DERIVED_FROM');
                }

                await this.indexCardVector(miniCard);
                mergedCount++;
                this.logger.info(`🔗 语义相似合并: ${cluster.length} Micro → 1 Mini`);

            } catch (error) {
                this.logger.error('语义合并失败', { error: String(error) });
            }
        }

        return mergedCount;
    }

    // ========================
    // 策略 3: 定时聚合 (Mini → Macro)
    // ========================

    /**
     * 将同主题下积累的 Mini 卡片聚合为 Macro
     */
    async timedAggregation(): Promise<number> {
        // 查找有 3+ Mini 卡片的主题
        const topics = this.db.prepare(`
            SELECT topic_id, COUNT(*) as cnt
            FROM memory_cards
            WHERE layer = 'Mini'
            GROUP BY topic_id
            HAVING cnt >= 3
        `).all() as { topic_id: string; cnt: number }[];

        let mergedCount = 0;

        for (const topic of topics) {
            try {
                const minis = this.db.prepare(`
                    SELECT * FROM memory_cards
                    WHERE topic_id = ? AND layer = 'Mini'
                    ORDER BY created_at ASC
                `).all(topic.topic_id) as any[];

                if (minis.length < 3) continue;

                const summaries = minis.map(m => m.summary);
                const macroSummary = await this.llmMergeSummaries(summaries, 'Macro');
                if (!macroSummary) continue;

                const avgQuality = minis.reduce((sum: number, m: any) => sum + (m.quality_score || 0), 0) / minis.length;
                const span = `${minis[0].created_at.split('T')[0]} ~ ${minis[minis.length - 1].created_at.split('T')[0]}`;

                // 获取主题标题
                const topicRow = this.db.prepare(
                    'SELECT title FROM memory_topics WHERE topic_id = ?'
                ).get(topic.topic_id) as { title: string } | undefined;

                const macroCard = this.insertUpgradedCard({
                    topicId: topic.topic_id,
                    layer: 'Macro',
                    summary: macroSummary,
                    span,
                    qualityScore: Math.min(100, avgQuality * 1.15),
                    tags: [topicRow?.title || '未知主题'],
                });

                for (const mini of minis) {
                    this.cardManager.addRelation(macroCard.cardId, mini.card_id, 'DERIVED_FROM');
                }

                await this.indexCardVector(macroCard);
                mergedCount++;
                this.logger.info(`🏔️ 定时聚合: ${minis.length} Mini → 1 Macro (主题: ${topicRow?.title})`);

            } catch (error) {
                this.logger.error(`主题 ${topic.topic_id} 聚合失败`, { error: String(error) });
            }
        }

        return mergedCount;
    }

    // ========================
    // 内部方法
    // ========================

    /**
     * LLM 合并多个摘要为更高层级的总结
     */
    private async llmMergeSummaries(summaries: string[], targetLayer: 'Mini' | 'Macro'): Promise<string | null> {
        const layerDesc = targetLayer === 'Mini' ? '中期记忆摘要' : '长期记忆概要';
        const prompt = `你是一个记忆蒸馏专家。将以下 ${summaries.length} 条记忆碎片合并为一条${layerDesc}。

要求:
- 保留核心事实和关键细节
- 去除重复信息
- 用简洁自然的语言组织
- ${targetLayer === 'Macro' ? '着重提炼用户的长期特征、偏好和重要决策' : '保持信息的具体性'}

记忆碎片:
${summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}

直接输出合并后的摘要，不要额外说明:`;

        try {
            const response = await this.chatLLM.chat([
                { role: 'user', content: prompt }
            ]);

            const text = typeof response === 'string' ? response : (response as any)?.content || '';
            return text.trim() || null;
        } catch (error) {
            this.logger.error('LLM 合并摘要失败', { error: String(error) });
            return null;
        }
    }

    /**
     * 插入升级后的卡片
     */
    private insertUpgradedCard(data: {
        topicId: string;
        layer: CardLayer;
        summary: string;
        span: string;
        qualityScore: number;
        tags: string[];
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
            tags: data.tags,
            createdAt: now,
            updatedAt: now,
        };

        this.db.prepare(`
            INSERT INTO memory_cards (card_id, topic_id, layer, summary, span, version, quality_score, tags, created_at, updated_at)
            VALUES (@cardId, @topicId, @layer, @summary, @span, @version, @qualityScore, @tags, @createdAt, @updatedAt)
        `).run({
            ...card,
            tags: card.tags ? JSON.stringify(card.tags) : null,
        });

        return card;
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
            this.logger.warn('卡片向量索引失败', { cardId: card.cardId, error: String(error) });
        }
    }

    /**
     * 合并标签
     */
    private mergeTags(cards: any[]): string[] {
        const tagSet = new Set<string>();
        for (const card of cards) {
            const tags = card.tags ? (typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags) : [];
            tags.forEach((t: string) => tagSet.add(t));
        }
        return Array.from(tagSet);
    }

    /**
     * 创建蒸馏日志
     */
    private createDistillationLog(runType: string): number {
        const result = this.db.prepare(`
            INSERT INTO distillation_logs (run_type, started_at, status)
            VALUES (?, ?, 'running')
        `).run(runType, new Date().toISOString());
        return Number(result.lastInsertRowid);
    }

    /**
     * 完成蒸馏日志
     */
    private completeDistillationLog(logId: number, cardsCreated: number, status: string) {
        this.db.prepare(`
            UPDATE distillation_logs SET cards_created = ?, finished_at = ?, status = ?
            WHERE id = ?
        `).run(cardsCreated, new Date().toISOString(), status, logId);
    }
}
