import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../../utils/logger';
import { LLMProvider } from '../../llm/provider';
import { MemoryConfig, MemoryEntry, MemorySearchResult, MemorySearchOptions } from './types';
import { MEMORY_SCHEMA } from './schema';

const DEFAULT_VECTOR_DIM = 1536; // OpenAI text-embedding-3-small
const CORE_PROFILE_HEADER = '## 核心档案';

export class MemoryManager extends EventEmitter {
    private db: Database.Database;
    private logger = new Logger('MemoryManager');

    constructor(
        private config: MemoryConfig,
        private llm: LLMProvider
    ) {
        super();
        fs.ensureDirSync(path.dirname(config.dbPath));
        this.db = new Database(config.dbPath);
        this.initialize();
    }

    /**
     * 初始化数据库
     */
    private initialize() {
        // 1. 检查维度或模型是否变化 (如果存在旧数据)
        if (this.checkNeedsRebuild()) {
            this.rebuildDatabase();
        }

        try {
            // 加载 sqlite-vec 扩展
            const extensionPath = sqliteVec.getLoadablePath();
            this.db.loadExtension(extensionPath);
            this.logger.info('sqlite-vec extension loaded', { extensionPath });

            // 执行 Schema
            this.db.exec(MEMORY_SCHEMA);

            // 写入/更新当前维度和模型名到 meta 表
            const dim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
            this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('vector_dim', dim.toString());
            if (this.config.embeddingModel) {
                this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('embedding_model', this.config.embeddingModel);
            }

            // 创建向量表 (如果不存在)
            // sqlite-vec 的表无法用 IF NOT EXISTS 创建，需要检查
            const vecTableExists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'"
            ).get();

            if (!vecTableExists) {
                const dim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
                this.db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`);
                this.logger.info(`Vector table created with dimension ${dim}`);
            }

            this.logger.info('Memory database initialized');
        } catch (error) {
            this.logger.error('Failed to initialize memory database', { error });
            throw error;
        }
    }

    /**
     * 添加记忆
     */
    async add(content: string, metadata: { sourceFile?: string; lineNumber?: number; tags?: string[] } = {}): Promise<MemoryEntry> {
        const hash = createHash('sha256').update(content).digest('hex');

        // 检查是否存在
        const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(hash) as { id: string } | undefined;
        if (existing) {
            this.logger.debug('Memory already exists', { hash });
            return this.get(existing.id)!;
        }

        // 生成向量
        let embedding: number[];
        try {
            embedding = await this.llm.embed(content);
        } catch (error) {
            this.logger.error('Failed to generate embedding', { error });
            throw error;
        }

        const entry: MemoryEntry = {
            id: uuidv4(),
            content,
            sourceFile: metadata.sourceFile,
            lineNumber: metadata.lineNumber,
            createdAt: new Date().toISOString(),
            hash,
            tags: metadata.tags
        };

        // 事务写入
        const insertTx = this.db.transaction(() => {
            // 写入元数据
            this.db.prepare(`
                INSERT INTO memories (id, content, source_file, line_number, created_at, hash, tags)
                VALUES (@id, @content, @sourceFile, @lineNumber, @createdAt, @hash, @tags)
            `).run({
                ...entry,
                tags: entry.tags ? JSON.stringify(entry.tags) : null
            });

            // 写入向量 (rowid 必须与 memories 表一致，但这里我们无法直接控制 rowid 对应关系，
            // 通常做法是专门维护 mapping 或直接用 rowid。
            // 更好的做法是获刚才插入的 rowid)
            const rowid = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number | bigint };

            //写入向量表
            const stmt = this.db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)');
            stmt.run(BigInt(rowid.id), new Float32Array(embedding));
        });

        insertTx();
        this.logger.info(`Memory saved: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`, { id: entry.id });

        // 发射事件供蒸馏系统监听 (fire-and-forget)
        this.emit('memoryAdded', { id: entry.id, content });

        return entry;
    }

    /**
     * 获取单个记忆
     */
    get(id: string): MemoryEntry | undefined {
        const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return {
            ...row,
            tags: row.tags ? JSON.parse(row.tags) : undefined
        };
    }

    /**
     * 混合搜索
     */
    async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
        const limit = options.limit || 5;
        const minScore = options.minScore || 0.05;

        const scores = new Map<number | bigint, { score: number; type: 'vector' | 'keyword' | 'hybrid' }>();

        // 1. 向量搜索（try/catch 隔离，嵌入失败不影响关键词搜索）
        try {
            const queryEmbedding = await this.llm.embed(query);
            const vectorResults = this.db.prepare(`
                SELECT rowid, distance
                FROM memories_vec
                WHERE embedding MATCH ?
                ORDER BY distance
                LIMIT ?
            `).all(new Float32Array(queryEmbedding), limit * 2) as { rowid: number; distance: number }[];

            this.logger.info('Vector search results', { count: vectorResults.length, results: vectorResults.map(r => ({ rowid: r.rowid, distance: r.distance, score: 1 - r.distance })) });
            for (const res of vectorResults) {
                const score = 1 - res.distance;
                if (score >= minScore) {
                    scores.set(res.rowid, { score, type: 'vector' });
                }
            }
            this.logger.info('Vector search passed threshold', { minScore, passedCount: scores.size });
        } catch (e) {
            this.logger.warn('Vector search failed, using keyword search only', { error: String(e) });
        }

        // 2. 关键词搜索 (FTS5 trigram)
        try {
            const ftsQuery = `"${query.replace(/"/g, '""')}"`;
            const keywordResults = this.db.prepare(`
                SELECT rowid, rank
                FROM memories_fts
                WHERE memories_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `).all(ftsQuery, limit * 2) as { rowid: number; rank: number }[];

            for (const res of keywordResults) {
                const existing = scores.get(res.rowid);
                if (existing) {
                    existing.score = Math.min(1, existing.score * 1.2);
                    existing.type = 'hybrid';
                } else {
                    scores.set(res.rowid, { score: 0.7, type: 'keyword' });
                }
            }
        } catch (e) {
            this.logger.warn('FTS search failed', { error: String(e) });
        }

        // 3. 兜底：如果向量 + FTS 都没结果，用 LIKE 模糊搜索
        if (scores.size === 0) {
            try {
                const likeResults = this.db.prepare(`
                    SELECT rowid, * FROM memories
                    WHERE content LIKE ?
                    ORDER BY created_at DESC
                    LIMIT ?
                `).all(`%${query}%`, limit) as any[];

                for (const row of likeResults) {
                    scores.set(row.rowid, { score: 0.5, type: 'keyword' });
                }
            } catch (e) {
                this.logger.warn('LIKE search failed', { error: String(e) });
            }
        }

        // 4. 最终兜底：所有搜索都无结果但数据库非空时，返回最近的记忆
        if (scores.size === 0) {
            try {
                const recentResults = this.db.prepare(`
                    SELECT rowid, * FROM memories
                    ORDER BY created_at DESC
                    LIMIT ?
                `).all(limit) as any[];

                for (const row of recentResults) {
                    scores.set(row.rowid, { score: 0.1, type: 'keyword' });
                }
                if (recentResults.length > 0) {
                    this.logger.info(`[Search Fallback] No search matches, returning ${recentResults.length} most recent memories`);
                }
            } catch (e) {
                this.logger.warn('Recent memory fallback failed', { error: String(e) });
            }
        }

        if (scores.size === 0) return [];

        // 4. 获取完整内容
        const finalResults: MemorySearchResult[] = [];
        const sortedIds = Array.from(scores.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, limit);

        const stmt = this.db.prepare('SELECT * FROM memories WHERE rowid = ?');

        for (const [rowid, info] of sortedIds) {
            const row = stmt.get(rowid) as any;
            if (row) {
                finalResults.push({
                    ...row,
                    tags: row.tags ? JSON.parse(row.tags) : undefined,
                    score: info.score,
                    matchType: info.type
                });
            }
        }

        return finalResults;
    }

    /**
     * 获取置顶记忆 (从 MEMORY.md)
     */
    async getPinnedMemories(): Promise<string[]> {
        if (!this.config.memoryMdPath || !fs.existsSync(this.config.memoryMdPath)) {
            return [];
        }

        try {
            const content = await fs.readFile(this.config.memoryMdPath, 'utf-8');
            const lines = content.split('\n');
            const pinned: string[] = [];
            let recording = false;

            for (const line of lines) {
                if (line.trim() === CORE_PROFILE_HEADER) {
                    recording = true;
                    continue;
                }
                if (recording) {
                    if (line.startsWith('## ')) {
                        recording = false;
                        break;
                    }
                    if (line.trim()) {
                        pinned.push(line.trim());
                    }
                }
            }
            return pinned;
        } catch (error) {
            this.logger.warn('Failed to read pinned memories', { error });
            return [];
        }
    }

    /**
     * 检索上下文 (用于注入 Prompt)
     */
    async retrieveContext(query: string): Promise<string> {
        // 1. 获取置顶记忆
        const pinned = await this.getPinnedMemories();

        // 2. 搜索相关记忆
        const searchResults = await this.search(query, { limit: 5 });

        // 3. 格式化输出
        let context = '';

        if (pinned.length > 0) {
            context += `\n${CORE_PROFILE_HEADER}\n${pinned.join('\n')}\n`;
        }

        if (searchResults.length > 0) {
            context += '\n## 相关记忆\n';
            searchResults.forEach((res, index) => {
                const source = res.sourceFile ? `[${path.basename(res.sourceFile)}]` : '';
                context += `${index + 1}. ${source} ${res.content} (score: ${res.score.toFixed(2)})\n`;
            });
        }

        // 记录调试信息 (Transparency)
        if (searchResults.length > 0) {
            this.logger.info(`Retrieved ${searchResults.length} relevant memories (Query: "${query}")`);
        } else {
            // 无搜索结果时检查数据库是否有记忆，提示 LLM 可以用 list 查看
            try {
                const stats = this.getStats();
                if (stats.totalCount > 0) {
                    context += `\n## 记忆提示\n当前共有 ${stats.totalCount} 条长期记忆。搜索未直接匹配到结果，可使用 memory_tool(action="list") 查看所有已保存的记忆。\n`;
                    this.logger.info(`No search match but ${stats.totalCount} memories exist, hint injected`);
                } else {
                    this.logger.debug(`No relevant memories found (Query: "${query}")`);
                }
            } catch {
                this.logger.debug(`No relevant memories found (Query: "${query}")`);
            }
        }

        // 4. 追加分层卡片上下文 (蒸馏系统, 独立于原有记忆)
        try {
            const cardManager = (this as any)._cardManager;
            if (cardManager && typeof cardManager.retrieveLayeredContext === 'function') {
                const layeredContext = await cardManager.retrieveLayeredContext(query);
                if (layeredContext) {
                    context += layeredContext;
                }
            }
        } catch {
            // 蒸馏系统异常不影响基础记忆检索
        }

        return context;
    }

    /**
     * 分页列出记忆
     */
    list(page: number = 1, pageSize: number = 20): { items: MemoryEntry[]; total: number; page: number; pageSize: number } {
        const total = (this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
        const offset = (page - 1) * pageSize;
        const rows = this.db.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?')
            .all(pageSize, offset) as any[];

        const items = rows.map(row => ({
            ...row,
            tags: row.tags ? JSON.parse(row.tags) : undefined
        }));

        return { items, total, page, pageSize };
    }

    /**
     * 删除单条记忆
     */
    delete(id: string): boolean {
        const deleteTx = this.db.transaction(() => {
            // 获取 rowid
            const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
            if (!row) return false;

            // 删除向量
            this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(row.rowid);
            // 删除主表（触发器会自动删除 FTS）
            this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
            return true;
        });

        const result = deleteTx();
        if (result) {
            this.logger.info(`Memory deleted: ${id}`);
        }
        return result as boolean;
    }

    /**
     * 清空所有记忆
     */
    clear(): void {
        const clearTx = this.db.transaction(() => {
            this.db.prepare('DELETE FROM memories_vec').run();
            this.db.prepare('DELETE FROM memories').run();
            // 重建 FTS 索引
            this.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
        });
        clearTx();
        this.logger.info('All memories cleared');
    }

    /**
     * 获取统计信息
     */
    getStats(): { totalCount: number; dbSizeBytes: number; vectorDim: number; embeddingModel: string } {
        const totalCount = (this.db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

        let dbSizeBytes = 0;
        try {
            const stat = fs.statSync(this.config.dbPath);
            dbSizeBytes = stat.size;
        } catch { /* ignore */ }

        const vectorDim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
        const embeddingModel = (this.llm.getConfig?.() as any)?.model || 'unknown';

        return { totalCount, dbSizeBytes, vectorDim, embeddingModel };
    }

    /**
     * 关闭数据库
     */
    close() {
        this.db.close();
    }

    /**
     * 检查是否需要重建向量表（维度变化 或 模型变化）
     */
    private checkNeedsRebuild(): boolean {
        try {
            // 检查 meta 表是否存在
            const metaTableExists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_meta'"
            ).get();

            const currentDim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
            const currentModel = this.config.embeddingModel || '';

            if (metaTableExists) {
                // 检查维度变化
                const dimRow = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'vector_dim'").get() as { value: string } | undefined;
                if (dimRow) {
                    const storedDim = parseInt(dimRow.value, 10);
                    if (storedDim !== currentDim) {
                        this.logger.warn(`Vector dimension mismatch: stored=${storedDim}, config=${currentDim}`);
                        return true;
                    }
                }

                // 检查模型名变化（即使维度相同，不同模型的向量语义空间不同）
                if (currentModel) {
                    const modelRow = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'embedding_model'").get() as { value: string } | undefined;
                    if (modelRow && modelRow.value && modelRow.value !== currentModel) {
                        this.logger.warn(`Embedding model changed: stored=${modelRow.value}, config=${currentModel}`);
                        return true;
                    }
                }
            } else {
                // 如果 meta 表不存在，但 memories_vec 存在 (旧版本数据库)
                const vecTableExists = this.db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'"
                ).get();

                if (vecTableExists && currentDim !== 1536) {
                    this.logger.warn(`Legacy database detected (assumed 1536), but config is ${currentDim}`);
                    return true;
                }
            }
            return false;
        } catch (error) {
            this.logger.error('Failed to check rebuild necessity', { error });
            return false; // 安全起见，不重置
        }
    }

    /**
     * 重建数据库 (备份旧库 -> 创建新库)
     */
    /**
     * 更新配置并检查是否需要重建
     */
    public updateConfig(newConfig: MemoryConfig) {
        this.config = newConfig;
        if (this.checkNeedsRebuild()) {
            this.rebuildDatabase();
        }
    }

    /**
     * 更新 Embedding LLM (当配置变更时)
     */
    public updateLLM(newLLM: LLMProvider) {
        this.llm = newLLM;
    }

    /**
     * 重建数据库 (备份旧库 -> 创建新库)
     */
    private rebuildDatabase() {
        this.logger.warn('Rebuilding vector table due to dimension change...');
        this.emit('rebuildProgress', 0);

        try {
            const dim = this.config.vectorDim || DEFAULT_VECTOR_DIM;

            // 1. 加载 sqlite-vec 扩展（可能还没加载）
            try {
                const extensionPath = sqliteVec.getLoadablePath();
                this.db.loadExtension(extensionPath);
            } catch { /* 可能已加载 */ }

            this.emit('rebuildProgress', 20);

            // 2. 删除旧的向量表
            try {
                this.db.exec('DROP TABLE IF EXISTS memories_vec');
                this.logger.info('Dropped old memories_vec table');
            } catch (e) {
                this.logger.warn('Failed to drop memories_vec', { error: String(e) });
            }

            this.emit('rebuildProgress', 50);

            // 3. 创建新维度的向量表
            this.db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`);
            this.logger.info(`Recreated memories_vec with dimension ${dim}`);

            // 4. 更新 meta 表中的维度和模型名记录
            this.db.exec(MEMORY_SCHEMA); // 确保 meta 表存在
            this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('vector_dim', dim.toString());
            if (this.config.embeddingModel) {
                this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('embedding_model', this.config.embeddingModel);
            }

            this.emit('rebuildProgress', 100);
            this.logger.info('Vector table rebuild complete. Existing memories preserved, re-embedding needed for semantic search.');

        } catch (error) {
            this.logger.error('Failed to rebuild vector table', { error });
            this.emit('rebuildProgress', -1);
            throw error;
        }
    }
}
