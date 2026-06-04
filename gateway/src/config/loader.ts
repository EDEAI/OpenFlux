/**
 * Configuration loader
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { OpenFluxConfig, OpenFluxConfigSchema } from './schema';
import { Logger } from '../utils/logger';

const logger = new Logger('Config');

/**
 * Determine whether it is a packaged Electron application
 */
const isPackaged = !(process as any).defaultApp && !!(process as any).resourcesPath;

/**
 * Get the directory where the executable file is located
 */
const exeDir = dirname(process.execPath);

/**
 * Build a list of configuration file search paths
 * After packaging, search the exe directory and user data directory first.
 */
function getConfigPaths(): string[] {
    const paths: string[] = [];

    if (isPackaged) {
        // After packaging: directory at the same level as exe (portable mode)
        paths.push(
            join(exeDir, 'openflux.yaml'),
            join(exeDir, 'openflux.yml'),
            join(exeDir, 'OpenFlux.yaml'),
            join(exeDir, 'OpenFlux.yml'),
            join(exeDir, 'OpenFlux.json'),
        );
    }

    // Development mode: current working directory (compatible with original behavior)
    const cwd = process.cwd();
    paths.push(
        join(cwd, 'openflux.yaml'),
        join(cwd, 'openflux.yml'),
        join(cwd, 'OpenFlux.yaml'),
        join(cwd, 'OpenFlux.yml'),
        join(cwd, 'OpenFlux.json'),
    );

    // Tauri sidecar mode: Backtrack to the project root directory based on the script file location
    // __dirname = gateway/src/config/ -> Backtrack 3 levels to the project root
    try {
        const scriptDir = typeof __dirname !== 'undefined'
            ? __dirname
            : dirname(fileURLToPath(import.meta.url));
        const projectRoot = resolve(scriptDir, '..', '..', '..');
        if (projectRoot !== cwd) {
            paths.push(
                join(projectRoot, 'openflux.yaml'),
                join(projectRoot, 'openflux.yml'),
                join(projectRoot, 'OpenFlux.yaml'),
            );
        }
    } catch { /* ignore */ }

    // User directory
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    if (userProfile) {
        paths.push(join(userProfile, '.openflux', 'config.yaml'));
        paths.push(join(userProfile, '.openflux', 'openflux.yaml'));
    }

    if (isPackaged) {
        // After packaging: Sample configuration in the resources directory (informal)
        paths.push(join((process as any).resourcesPath, 'openflux.example.yaml'));
    }

    return paths;
}

const CONFIG_PATHS = getConfigPaths();

/**
 * Load configuration file
 */
export async function loadConfig(): Promise<OpenFluxConfig> {
    // Find configuration file
    let configPath: string | null = null;
    for (const path of CONFIG_PATHS) {
        if (existsSync(path)) {
            configPath = path;
            break;
        }
    }

    if (!configPath) {
        logger.warn('No config file found, using defaults');
        return getDefaultConfig();
    }

    try {
        const content = await readFile(configPath, 'utf-8');
        let rawConfig: unknown;

        if (configPath.endsWith('.json')) {
            rawConfig = JSON.parse(content);
        } else {
            rawConfig = parseYaml(content);
        }

        const config = OpenFluxConfigSchema.parse(rawConfig);

        // Merge providers configuration into llm configuration
        if (config.providers) {
            const mergeProvider = (llmConfig: any) => {
                const providerConfig = config.providers?.[llmConfig.provider];
                if (providerConfig) {
                    if (!llmConfig.apiKey && providerConfig.apiKey) {
                        llmConfig.apiKey = providerConfig.apiKey;
                    }
                    if (!llmConfig.baseUrl && providerConfig.baseUrl) {
                        llmConfig.baseUrl = providerConfig.baseUrl;
                    }
                }
            };
            mergeProvider(config.llm.orchestration);
            mergeProvider(config.llm.execution);
            if (config.llm.fallback) {
                mergeProvider(config.llm.fallback);
            }
        }

        logger.info(`Loaded config from ${configPath}`);
        return config;
    } catch (error) {
        logger.error(`Failed to load config from ${configPath}`, error);
        throw error;
    }
}

/**
 * Default configuration
 */
function getDefaultConfig(): OpenFluxConfig {
    return {
        llm: {
            orchestration: {
                provider: 'anthropic',
                model: 'claude-3-opus-20240229',
            },
            execution: {
                provider: 'openai',
                model: 'gpt-4o',
            },
        },
        remote: {
            enabled: false,
            host: 'localhost',
            port: 18801,
        },
        permissions: {
            autoApproveLevel: 1,
        },
        browser: {
            enabled: true,
            headless: false,
        },
        opencode: {
            enabled: true,
            autoApprove: false,
        },
    };
}
