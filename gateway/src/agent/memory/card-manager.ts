/**
 * card manager
 * Implementing hierarchical distillation of memory cards based on MemAtlas mechanism
 * 
 * Independent of the original MemoryManager and does not affect its normal work
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

/**
 * 关键词兜底：判断摘要是否为"时效性操作/调试状态"（工具可用性、连接错误、编码绕路等）。
 * 仅作为 LLM transient 漏判时的保险，命中则把长期价值清零。
 */
function looksTransient(summary?: string): boolean {
    if (!summary) return false;
    const s = String(summary).toLowerCase();
    const patterns: RegExp[] = [
        /(没有|不存在|未注册|未连接|不可用|无法找到|找不到)[^，。\n]{0,12}(插件|加载项|工具|ppt|word|excel|powerpoint)/,
        /(插件|加载项|tool|plugin|add-?in)[^，。\n]{0,12}(不存在|未注册|未连接|不可用|not\s+registered|not\s+available|unavailable|missing)/i,
        /python[-_ ]?pptx|python[-_ ]?docx|openpyxl|win32com|pywin32/i,
        /(改用|fallback|fall back|workaround|绕过|替代方案)[^，。\n]{0,16}(python|com|powershell|脚本|代码)/i,
        /(连接|connection|websocket)[^，。\n]{0,12}(断开|失败|超时|错误|disconnect|failed|timeout|error)/i,
    ];
    return patterns.some(p => p.test(s));
}

/** Default distillation configuration */
const DEFAULT_DISTILLATION_CONFIG: DistillationConfig = {
    enabled: false,
    startTime: '02:00',
    endTime: '06:00',
    qualityThreshold: 40,
    sessionDensityThreshold: 5,
    similarityThreshold: 0.85,
};

/**
 * LLM unified extraction results
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
        private chatLLM: LLMProvider,      // chat capabilities (summary extraction)
        private embeddingLLM: LLMProvider,  // embed capabilities (vector indexing/searching)
        config?: Partial<DistillationConfig>
    ) {
        super();
        this.distillationConfig = { ...DEFAULT_DISTILLATION_CONFIG, ...config };

        // Make sure the card vector table exists
        this.ensureCardVecTable();
        this.logger.info('CardManager initialized', {
            enabled: this.distillationConfig.enabled,
            schedule: `${this.distillationConfig.startTime} - ${this.distillationConfig.endTime}`
        });
    }

    // ========================
    // Configuration management
    // ========================

    /** Get distillation configuration */
    getConfig(): DistillationConfig {
        return { ...this.distillationConfig };
    }

    /** Update distillation configuration */
    updateConfig(config: Partial<DistillationConfig>) {
        this.distillationConfig = { ...this.distillationConfig, ...config };
        this.emit('configUpdated', this.distillationConfig);
        this.logger.info('Distillation config updated', config);
    }

    /** Update chat LLM */
    updateChatLLM(newLLM: LLMProvider) {
        this.chatLLM = newLLM;
    }

    /** Updated embedding LLM */
    updateEmbeddingLLM(newLLM: LLMProvider) {
        this.embeddingLLM = newLLM;
    }

    // ========================
    // Card CRUD
    // ========================

    /**
     * Generate Micro Cards from original memory content
     * 
     * @param content memory content (from MemoryManager.add)
     * @param memoryId original memory ID (for association)
     */
    async generateMicroCard(content: string, memoryId: string): Promise<MemoryCard | null> {
        if (!this.distillationConfig.enabled) return null;

        try {
            // 1. LLM unified extraction: quality, topic, abstract
            const extraction = await this.extractCardInfo(content);
            if (!extraction) {
                this.logger.debug('LLM extraction failed, skipping card generation');
                return null;
            }

            // 2. Quality gating
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

            // 3. Semantic deduplication check
            const isDuplicate = await this.checkDuplicate(extraction.summary, 'Micro');
            if (isDuplicate) {
                this.logger.debug('Duplicate card detected, skipping');
                return null;
            }

            // 4. Get/create theme
            const primaryTopic = extraction.topics[0] || 'Uncategorized';
            const topicId = await this.getOrCreateTopic(primaryTopic);

            // 5. Create a card
            const card = this.insertCard({
                topicId,
                layer: 'Micro',
                summary: extraction.summary,
                span: new Date().toISOString().split('T')[0],
                qualityScore,
                sourceEventId: memoryId,
                tags: extraction.topics,
            });

            // 6. Generate vector index of card summary
            await this.indexCardVector(card);

            // 7. Build relationships for other topics
            for (let i = 1; i < extraction.topics.length; i++) {
                const secTopicId = await this.getOrCreateTopic(extraction.topics[i]);
                // Just use tag to mark the association (lightweight implementation)
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
     * Insert card into database
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
     * Get a single card
     */
    getCard(cardId: string): MemoryCard | undefined {
        const row = this.db.prepare('SELECT * FROM memory_cards WHERE card_id = ?').get(cardId) as any;
        if (!row) return undefined;
        return this.rowToCard(row);
    }

    /**
     * Query cards by level
     */
    getCardsByLayer(layer: CardLayer, limit = 50): MemoryCard[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_cards WHERE layer = ? ORDER BY created_at DESC LIMIT ?'
        ).all(layer, limit) as any[];
        return rows.map(r => this.rowToCard(r));
    }

    /**
     * Search cards by topic
     */
    getCardsByTopic(topicId: string, limit = 50): MemoryCard[] {
        const rows = this.db.prepare(
            'SELECT * FROM memory_cards WHERE topic_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(topicId, limit) as any[];
        return rows.map(r => this.rowToCard(r));
    }

    /**
     * Delete card
     */
    deleteCard(cardId: string): boolean {
        const tx = this.db.transaction(() => {
            const row = this.db.prepare('SELECT rowid FROM memory_cards WHERE card_id = ?').get(cardId) as any;
            if (!row) return false;

            // delete vector
            try { this.db.prepare('DELETE FROM cards_vec WHERE rowid = ?').run(row.rowid); } catch { /* may not exist */ }
            // Delete relationship
            this.db.prepare('DELETE FROM card_relations WHERE source_card_id = ? OR target_card_id = ?').run(cardId, cardId);
            // Delete card
            this.db.prepare('DELETE FROM memory_cards WHERE card_id = ?').run(cardId);
            return true;
        });
        return tx() as boolean;
    }

    // ========================
    // Topic management
    // ========================

    /**
     * Get or create a topic
     */
    async getOrCreateTopic(title: string): Promise<string> {
        // Exact match first
        const existing = this.db.prepare(
            'SELECT topic_id FROM memory_topics WHERE title = ?'
        ).get(title) as { topic_id: string } | undefined;

        if (existing) return existing.topic_id;

        // Semantic similarity matching (searching topic titles via vectors)
        // Simplified implementation: create new themes directly
        const topicId = createHash('md5').update(title).digest('hex').substring(0, 16);

        this.db.prepare(`
            INSERT OR IGNORE INTO memory_topics (topic_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?)
        `).run(topicId, title, new Date().toISOString(), new Date().toISOString());

        return topicId;
    }

    /**
     * List all topics
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
    // relationship management
    // ========================

    /**
     * Create card relationship
     */
    addRelation(sourceId: string, targetId: string, type: RelationType) {
        this.db.prepare(`
            INSERT INTO card_relations (source_card_id, target_card_id, relation_type)
            VALUES (?, ?, ?)
        `).run(sourceId, targetId, type);
    }

    /**
     * Get all subcards derived from a card
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
    // vector search
    // ========================

    /**
     * Semantic search cards
     */
    async searchCards(query: string, options: {
        limit?: number;
        minScore?: number;
        layer?: CardLayer;
    } = {}): Promise<CardSearchResult[]> {
        const limit = options.limit || 10;
        const minScore = options.minScore || 0.3;

        const scores = new Map<number | bigint, { score: number; type: 'vector' | 'keyword' | 'hybrid' }>();

        // 1. Vector search
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

        // 2. FTS Search
        try {
            const safeQuery = query
                .substring(0, 100)
                .replace(/["*^:()\-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!safeQuery) throw new Error('empty query after sanitize');
            const ftsQuery = `"${safeQuery}"`;
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

        // 3. Weight by level
        const results: CardSearchResult[] = [];
        const sorted = Array.from(scores.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, limit);

        const stmt = this.db.prepare('SELECT * FROM memory_cards WHERE rowid = ?');
        for (const [rowid, info] of sorted) {
            const row = stmt.get(rowid) as any;
            if (!row) continue;

            // Hierarchical weighting: Macro > Mini > Micro
            let layerBoost = 1.0;
            if (row.layer === 'Macro') layerBoost = 1.15;
            else if (row.layer === 'Mini') layerBoost = 1.08;

            // Apply level filtering
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
     * Retrieve hierarchical context (used for injecting Agent Prompt)
     * 
     * Search strategy: Macro Summary -> Related Mini -> Details Micro
     */
    async retrieveLayeredContext(query: string): Promise<string> {
        if (!this.distillationConfig.enabled) return '';

        const results = await this.searchCards(query, { limit: 15 });
        if (results.length === 0) return '';

        // Group by level
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
            // Show Micro only if there are no high-level cards
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
    // statistics
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
    // Session auto-precipitation (P1)
    // ========================

    /**
     * Conversation history is automatically deposited into Micro cards
     * Compress conversation messages that are about to be discarded by the sliding window into cards to achieve permanent memory
     * 
     * @param messages Array of messages to be discarded
     * @param sessionId source session ID (for tagging)
     */
    async distillConversation(
        messages: Array<{ role: string; content: string }>,
        sessionId?: string
    ): Promise<MemoryCard | null> {
        if (messages.length === 0) return null;

        try {
            // Merge messages into a conversation text
            const conversationText = messages
                .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
                .join('\n');

            // Truncate to avoid being too long
            const truncated = conversationText.length > 3000
                ? conversationText.slice(0, 3000) + '\n...(truncated)'
                : conversationText;

            // Extract pipeline with existing LLM
            const extraction = await this.extractCardInfo(truncated);
            if (!extraction) {
                this.logger.debug('Conversation distillation: LLM extraction returned null');
                return null;
            }

            // Quality gating (use a lower threshold for dialogue precipitation, since any valid information is worth retaining)
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

            // Remove duplicates
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
     * Collaboration results are automatically deposited into Micro cards (with collaboration tag to achieve memory isolation)
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

            if (qualityScore < 25) return null; // Collaboration results use a lower threshold

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
    // internal method
    // ========================

    /**
     * Make sure the card vector table exists
     */
    private ensureCardVecTable() {
        try {
            // Get the dimensions of the current configuration from memory_meta
            let configDim = 1536;
            try {
                const meta = this.db.prepare("SELECT value FROM memory_meta WHERE key='vector_dim'").get() as any;
                if (meta) {
                    const d = parseInt(meta.value, 10);
                    if (!isNaN(d) && d > 0) configDim = d;
                }
            } catch { /* neglect */ }

            const exists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='cards_vec'"
            ).get();

            if (exists) {
                // The table already exists, check if the dimensions match
                try {
                    // Test the dimensions of the current table with a zero vector
                    const testVec = new Float32Array(configDim);
                    this.db.prepare(
                        'SELECT rowid FROM cards_vec WHERE embedding MATCH ? LIMIT 1'
                    ).all(testVec);
                    // Query success indicates dimension matching
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

            // Table does not exist, create
            this.db.exec(`CREATE VIRTUAL TABLE cards_vec USING vec0(embedding float[${configDim}] distance_metric=cosine)`);
            this.logger.info(`Card vector table created (dimensions: ${configDim})`);
        } catch (error) {
            this.logger.error('Failed to create card vector table', { error: String(error) });
        }
    }

    /**
     * Index card vector
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
     * Semantic deduplication
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
                    // Check if they are on the same layer
                    const card = this.db.prepare(
                        'SELECT layer FROM memory_cards WHERE rowid = ?'
                    ).get(res.rowid) as { layer: string } | undefined;
                    if (card && card.layer === layer) return true;
                }
            }
            return false;
        } catch {
            return false; // No blocking if duplication check fails
        }
    }

    /**
     * Use LLM to uniformly extract card information
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

4. transient (boolean): Set TRUE if the content is predominantly a TIME-SENSITIVE OPERATIONAL/DEBUGGING state that will NOT be a durable fact, for example:
   - Tool/plugin/add-in availability at a moment ("no ppt tools", "PPT plugin not registered/connected", "tool X is unavailable")
   - Transient connection/runtime errors, retries, timeouts
   - Debugging/testing outcomes of a specific run, or temporary workarounds like "use python/python-pptx/win32com/COM/PowerShell instead because the plugin doesn't work"
   - Anything whose truth depends on the current session/connection state rather than a stable user characteristic.
   When transient is TRUE you MUST also set long_term_value to 0.
   Set transient FALSE for durable user facts (identity, preferences, credentials, long-term plans, project constraints).

Conversation content:
"""
${content}
"""

Return JSON only, no extra text:
{
  "quality": {"information_density": 0, "actionability": 0, "long_term_value": 0, "uniqueness": 0},
  "transient": false,
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

            // 时效性内容过滤：工具可用性/连接错误/调试-绕路结论等不是长期事实，直接丢弃不建卡，
            // 避免污染后续每轮上下文（曾导致 Agent 误以为"插件不存在、改用 python"）。
            if (parsed.transient === true) {
                this.logger.info('Skip transient distillation card (time-sensitive operational state)', {
                    summary: (parsed.summary || '').slice(0, 80),
                });
                return null;
            }

            return {
                quality: {
                    informationDensity: parsed.quality?.information_density ?? 0,
                    actionability: parsed.quality?.actionability ?? 0,
                    // 即使模型漏判 transient，命中关键词也把长期价值清零兜底
                    longTermValue: looksTransient(parsed.summary) ? 0 : (parsed.quality?.long_term_value ?? 0),
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
     * Convert database rows to MemoryCard
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
