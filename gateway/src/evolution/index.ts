/**
 * Evolution Module - Evolution data layer unified export
 */

export { EvolutionDataManager } from './data-manager';
export type { EvolutionManifest, InstalledSkillMeta, CustomToolMeta, ForgedSkillMeta } from './data-manager';
export { runMigrations, CURRENT_SCHEMA_VERSION } from './migrator';
export { SkillForge } from './skill-forge';
export type { ForgeSuggestion, SkillForgeConfig } from './skill-forge';
