/**
 * Evolution Schema Migrator
 * 负责进化数据的版本迁移，保障升级时数据平滑过渡
 */

import { Logger } from '../utils/logger';
import type { EvolutionDataManager, EvolutionManifest } from './data-manager';

const log = new Logger('EvolutionMigrator');

/** 迁移函数签名 */
type MigrationFn = (dataManager: EvolutionDataManager) => Promise<void>;

/** 迁移注册表 */
const migrations: Map<number, MigrationFn> = new Map();

/**
 * 注册迁移脚本
 * @param targetVersion 目标 schema 版本
 * @param fn 迁移函数
 */
export function registerMigration(targetVersion: number, fn: MigrationFn): void {
    migrations.set(targetVersion, fn);
}

/** 当前 schema 版本 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 执行迁移
 * 从当前 schemaVersion 按顺序执行到 CURRENT_SCHEMA_VERSION
 */
export async function runMigrations(dataManager: EvolutionDataManager): Promise<void> {
    const manifest = dataManager.readManifest();
    const fromVersion = manifest.schemaVersion;

    if (fromVersion >= CURRENT_SCHEMA_VERSION) {
        log.info(`Schema version ${fromVersion} is up to date, no migration needed`);
        return;
    }

    log.info(`Migrating evolution data: v${fromVersion} → v${CURRENT_SCHEMA_VERSION}`);

    for (let v = fromVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
        const migrationFn = migrations.get(v);
        if (!migrationFn) {
            log.info(`No migration script for v${v}, skipping`);
            continue;
        }

        // 迁移前备份
        log.info(`Backing up before v${v} migration...`);
        dataManager.createBackup(v - 1);

        try {
            log.info(`Running migration v${v - 1} → v${v}...`);
            await migrationFn(dataManager);

            // 更新 schemaVersion
            const updated = dataManager.readManifest();
            updated.schemaVersion = v;
            dataManager.writeManifest(updated);
            log.info(`Migration v${v} completed`);
        } catch (error) {
            log.error(`Migration v${v} failed: ${error}`);
            log.info(`Rolling back to v${v - 1}...`);

            const restored = dataManager.restoreFromBackup(v - 1);
            if (restored) {
                log.info('Rollback successful');
            } else {
                log.error('Rollback failed! Evolution data may be corrupted');
            }

            throw new Error(`Migration to v${v} failed: ${error}`);
        }
    }

    log.info('All migrations completed successfully');
}

// ========================
// 未来迁移脚本在这里注册
// ========================
// 示例：
// registerMigration(2, async (dm) => {
//     // v1 → v2 的迁移逻辑
//     // 如：重命名目录、更新字段结构等
// });
