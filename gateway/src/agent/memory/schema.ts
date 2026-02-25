/**
 * 记忆系统数据库 Schema
 */

export const MEMORY_SCHEMA = `
-- 启用外键约束
PRAGMA foreign_keys = ON;

-- 原始记忆表
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source_file TEXT,
    line_number INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    hash TEXT,
    tags TEXT -- JSON array string
);

-- 元数据表 (用于存储配置信息，如向量维度)
CREATE TABLE IF NOT EXISTS memory_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_memories_source_file ON memories(source_file);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);

-- 全文索引表 (FTS5)
-- 使用 trigram 分词器以支持中英文混合搜索
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories', -- External Content Table 模式，减少存储冗余
    content_rowid='rowid',
    tokenize='trigram'
);

-- 触发器：同步更新 FTS 表
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 向量索引表 (sqlite-vec)
-- 注意：sqlite-vec 表结构由 createVirtualTable 动态创建，因为维度可能变化
-- CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
--    embedding float[1536]
-- );

-- ========================
-- 卡片蒸馏系统 (MemAtlas)
-- ========================

-- 记忆卡片表 (三层: Micro / Mini / Macro)
CREATE TABLE IF NOT EXISTS memory_cards (
    card_id TEXT PRIMARY KEY,
    topic_id TEXT,
    layer TEXT NOT NULL DEFAULT 'Micro',
    summary TEXT NOT NULL,
    span TEXT,
    version INTEGER DEFAULT 1,
    quality_score REAL DEFAULT 0,
    source_event_id TEXT,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 主题表
CREATE TABLE IF NOT EXISTS memory_topics (
    topic_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 卡片关系表 (模拟图数据库边)
CREATE TABLE IF NOT EXISTS card_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_card_id TEXT NOT NULL,
    target_card_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_card_id) REFERENCES memory_cards(card_id),
    FOREIGN KEY (target_card_id) REFERENCES memory_cards(card_id)
);

-- 蒸馏执行日志
CREATE TABLE IF NOT EXISTS distillation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,
    cards_processed INTEGER DEFAULT 0,
    cards_created INTEGER DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    status TEXT DEFAULT 'running'
);

-- 卡片索引
CREATE INDEX IF NOT EXISTS idx_cards_topic ON memory_cards(topic_id);
CREATE INDEX IF NOT EXISTS idx_cards_layer ON memory_cards(layer);
CREATE INDEX IF NOT EXISTS idx_cards_quality ON memory_cards(quality_score);
CREATE INDEX IF NOT EXISTS idx_cards_source ON memory_cards(source_event_id);
CREATE INDEX IF NOT EXISTS idx_relations_source ON card_relations(source_card_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON card_relations(target_card_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON card_relations(relation_type);

-- 卡片全文搜索
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
    summary,
    content='memory_cards',
    content_rowid='rowid',
    tokenize='trigram'
);

-- 卡片 FTS 触发器
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON memory_cards BEGIN
  INSERT INTO cards_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON memory_cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, summary) VALUES('delete', old.rowid, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON memory_cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, summary) VALUES('delete', old.rowid, old.summary);
  INSERT INTO cards_fts(rowid, summary) VALUES (new.rowid, new.summary);
END;
`;
