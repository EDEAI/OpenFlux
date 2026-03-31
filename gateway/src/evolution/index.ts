/**
 * Evolution Module - 进化数据层统一出口
 */

export { EvolutionDataManager } from './data-manager';
export type { EvolutionManifest, InstalledSkillMeta, CustomToolMeta, ForgedSkillMeta } from './data-manager';
export { runMigrations, CURRENT_SCHEMA_VERSION } from './migrator';
export { SkillForge } from './skill-forge';
export type { ForgeSuggestion, SkillForgeConfig } from './skill-forge';
