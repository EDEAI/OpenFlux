/**
 * Evolution Schema Migrator
 * Responsible for version migration of evolutionary data to ensure smooth data transition during upgrades
 */

import { Logger } from '../utils/logger';
import type { EvolutionDataManager, EvolutionManifest } from './data-manager';

const log = new Logger('EvolutionMigrator');

/** Migrate function signature */
type MigrationFn = (dataManager: EvolutionDataManager) => Promise<void>;

/** Migrate registry */
const migrations: Map<number, MigrationFn> = new Map();

/**
 * Register migration script
 * @param targetVersion target schema version
 * @param fn migration function
 */
export function registerMigration(targetVersion: number, fn: MigrationFn): void {
    migrations.set(targetVersion, fn);
}

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Execute migration
 * Execute sequentially from current schemaVersion to CURRENT_SCHEMA_VERSION
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

        // Backup before migration
        log.info(`Backing up before v${v} migration...`);
        dataManager.createBackup(v - 1);

        try {
            log.info(`Running migration v${v - 1} → v${v}...`);
            await migrationFn(dataManager);

            // Update schemaVersion
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
// Future migration scripts register here
// ========================
// Example:
// registerMigration(2, async (dm) => {
//     // Migration logic of v1 -> v2
//     // Such as: rename directory, update field structure, etc.
// });
