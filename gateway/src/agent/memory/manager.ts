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
     * Initialize database
     */
    private initialize() {
        // 1. Check whether dimensions or models have changed (if old data exists)
        if (this.checkNeedsRebuild()) {
            this.rebuildDatabase();
        }

        try {
            // Load sqlite-vec extension
            const extensionPath = sqliteVec.getLoadablePath();
            this.db.loadExtension(extensionPath);
            this.logger.info('sqlite-vec extension loaded', { extensionPath });

            // Execute Schema
            this.db.exec(MEMORY_SCHEMA);

            // Write/update the current dimension and model name to the meta table
            const dim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
            this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('vector_dim', dim.toString());
            if (this.config.embeddingModel) {
                this.db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run('embedding_model', this.config.embeddingModel);
            }

            // Create vector table if it does not exist
            // The sqlite-vec table cannot be created with IF NOT EXISTS and needs to be checked
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
     * add memory
     */
    async add(content: string, metadata: { sourceFile?: string; lineNumber?: number; tags?: string[] } = {}): Promise<MemoryEntry> {
        const hash = createHash('sha256').update(content).digest('hex');

        // Check if exists
        const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(hash) as { id: string } | undefined;
        if (existing) {
            this.logger.debug('Memory already exists', { hash });
            return this.get(existing.id)!;
        }

        // Generate vector
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

        // transaction write
        const insertTx = this.db.transaction(() => {
            // Write metadata
            this.db.prepare(`
                INSERT INTO memories (id, content, source_file, line_number, created_at, hash, tags)
                VALUES (@id, @content, @sourceFile, @lineNumber, @createdAt, @hash, @tags)
            `).run({
                ...entry,
                tags: entry.tags ? JSON.stringify(entry.tags) : null
            });

            // Write vector (rowid must be consistent with the memories table, but here we cannot directly control the rowid correspondence,
            // The usual approach is to maintain mapping specifically or use rowid directly.
            // A better approach is to get the rowid just inserted)
            const rowid = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number | bigint };

            //Write to vector table
            const stmt = this.db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)');
            stmt.run(BigInt(rowid.id), new Float32Array(embedding));
        });

        insertTx();
        this.logger.info(`Memory saved: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`, { id: entry.id });

        // Emit events for the distillation system to listen for (fire-and-forget)
        this.emit('memoryAdded', { id: entry.id, content });

        return entry;
    }

    /**
     * Get a single memory
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
     * hybrid search
     */
    async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
        const limit = options.limit || 5;
        const minScore = options.minScore || 0.05;

        const scores = new Map<number | bigint, { score: number; type: 'vector' | 'keyword' | 'hybrid' }>();

        // 1. Vector search (try/catch isolation, embedding failure does not affect keyword search)
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

        // 2. Keyword search (FTS5 trigram)
        try {
            // Sanitize: truncate long queries and strip FTS5 special characters to prevent "unterminated string" errors
            const safeQuery = query
                .substring(0, 100)                        // FTS5 phrase queries must be short
                .replace(/["*^:()\-]/g, ' ')              // strip FTS5 operators
                .replace(/\s+/g, ' ')
                .trim();
            if (!safeQuery) throw new Error('empty query after sanitize');
            const ftsQuery = `"${safeQuery}"`;
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

        // 3. Back to the bottom: If vector + FTS has no results, use LIKE fuzzy search
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

        // 4. Final answer: when all searches have no results but the database is not empty, return to the most recent memory
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

        // 4. Get full content
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
     * Get pinned memory (from MEMORY.md)
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
     * Retrieve context (for injecting Prompt)
     */
    async retrieveContext(query: string): Promise<string> {
        // 1. Get the pinned memory
        const pinned = await this.getPinnedMemories();

        // 2. Search for relevant memories
        const searchResults = await this.search(query, { limit: 5 });

        // 3. Format output
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

        // Logging debugging information (Transparency)
        if (searchResults.length > 0) {
            this.logger.info(`Retrieved ${searchResults.length} relevant memories (Query: "${query}")`);
        } else {
            // When there are no search results, check whether the database has memory and prompt LLM. You can use list to view it.
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

        // 4. Add hierarchical card context (distillation system, independent of original memory)
        try {
            const cardManager = (this as any)._cardManager;
            if (cardManager && typeof cardManager.retrieveLayeredContext === 'function') {
                const layeredContext = await cardManager.retrieveLayeredContext(query);
                if (layeredContext) {
                    context += layeredContext;
                }
            }
        } catch {
            // Distillation system anomalies do not affect basic memory retrieval
        }

        return context;
    }

    /**
     * List memories in pages
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
     * Delete a single memory
     */
    delete(id: string): boolean {
        const deleteTx = this.db.transaction(() => {
            // Get rowid
            const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
            if (!row) return false;

            // delete vector
            this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(row.rowid);
            // Delete the main table (trigger will automatically delete FTS)
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
     * Clear all memories
     */
    clear(): void {
        const clearTx = this.db.transaction(() => {
            this.db.prepare('DELETE FROM memories_vec').run();
            this.db.prepare('DELETE FROM memories').run();
            // Rebuilding the FTS index
            this.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
        });
        clearTx();
        this.logger.info('All memories cleared');
    }

    /**
     * Get statistics
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
     * Close database
     */
    close() {
        this.db.close();
    }

    /**
     * Check whether the vector table needs to be rebuilt (dimensional change or model change)
     */
    private checkNeedsRebuild(): boolean {
        try {
            // Check if meta table exists
            const metaTableExists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_meta'"
            ).get();

            const currentDim = this.config.vectorDim || DEFAULT_VECTOR_DIM;
            const currentModel = this.config.embeddingModel || '';

            if (metaTableExists) {
                // Check for dimension changes
                const dimRow = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'vector_dim'").get() as { value: string } | undefined;
                if (dimRow) {
                    const storedDim = parseInt(dimRow.value, 10);
                    if (storedDim !== currentDim) {
                        this.logger.warn(`Vector dimension mismatch: stored=${storedDim}, config=${currentDim}`);
                        return true;
                    }
                }

                // Check for model name changes (even if the dimensions are the same, the vector semantic spaces of different models are different)
                if (currentModel) {
                    const modelRow = this.db.prepare("SELECT value FROM memory_meta WHERE key = 'embedding_model'").get() as { value: string } | undefined;
                    if (modelRow && modelRow.value && modelRow.value !== currentModel) {
                        this.logger.warn(`Embedding model changed: stored=${modelRow.value}, config=${currentModel}`);
                        return true;
                    }
                }
            } else {
                // If the meta table does not exist but memories_vec exists (old version database)
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
            return false; // For safety reasons, do not reset
        }
    }

    /**
     * Rebuild the database (back up old database -> create new database)
     */
    /**
     * Update configuration and check if rebuild is needed
     */
    public updateConfig(newConfig: MemoryConfig) {
        this.config = newConfig;
        if (this.checkNeedsRebuild()) {
            this.rebuildDatabase();
        }
    }

    /**
     * Update Embedding LLM (when configuration changes)
     */
    public updateLLM(newLLM: LLMProvider) {
        this.llm = newLLM;
    }

    /**
     * Rebuild the database (back up old database -> create new database)
     */
    private rebuildDatabase() {
        this.logger.warn('Rebuilding vector table due to dimension change...');
        this.emit('rebuildProgress', 0);

        try {
            const dim = this.config.vectorDim || DEFAULT_VECTOR_DIM;

            // 1. Load the sqlite-vec extension (it may not be loaded yet)
            try {
                const extensionPath = sqliteVec.getLoadablePath();
                this.db.loadExtension(extensionPath);
            } catch { /* may be loaded */ }

            this.emit('rebuildProgress', 20);

            // 2. Delete the old vector table
            try {
                this.db.exec('DROP TABLE IF EXISTS memories_vec');
                this.logger.info('Dropped old memories_vec table');
            } catch (e) {
                this.logger.warn('Failed to drop memories_vec', { error: String(e) });
            }

            this.emit('rebuildProgress', 50);

            // 3. Create a vector table of new dimensions
            this.db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`);
            this.logger.info(`Recreated memories_vec with dimension ${dim}`);

            // 4. Update dimension and model name records in the meta table
            this.db.exec(MEMORY_SCHEMA); // Make sure the meta table exists
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
