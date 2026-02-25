/**
 * 配置加载器
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
 * 判断是否为打包后的 Electron 应用
 */
const isPackaged = !(process as any).defaultApp && !!(process as any).resourcesPath;

/**
 * 获取可执行文件所在目录
 */
const exeDir = dirname(process.execPath);

/**
 * 构建配置文件搜索路径列表
 * 打包后优先查找 exe 目录和用户数据目录
 */
function getConfigPaths(): string[] {
    const paths: string[] = [];

    if (isPackaged) {
        // 打包后: exe 同级目录（便携模式）
        paths.push(
            join(exeDir, 'openflux.yaml'),
            join(exeDir, 'openflux.yml'),
            join(exeDir, 'OpenFlux.yaml'),
            join(exeDir, 'OpenFlux.yml'),
            join(exeDir, 'OpenFlux.json'),
        );
    }

    // 开发模式: 当前工作目录（兼容原有行为）
    const cwd = process.cwd();
    paths.push(
        join(cwd, 'openflux.yaml'),
        join(cwd, 'openflux.yml'),
        join(cwd, 'OpenFlux.yaml'),
        join(cwd, 'OpenFlux.yml'),
        join(cwd, 'OpenFlux.json'),
    );

    // Tauri sidecar 模式: 基于脚本文件位置回溯到项目根目录
    // __dirname = gateway/src/config/ -> 回溯 3 级到项目根
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

    // 用户目录
    const userProfile = process.env.USERPROFILE || process.env.HOME || '';
    if (userProfile) {
        paths.push(join(userProfile, '.openflux', 'config.yaml'));
        paths.push(join(userProfile, '.openflux', 'openflux.yaml'));
    }

    if (isPackaged) {
        // 打包后: resources 目录下的示例配置（兜底）
        paths.push(join((process as any).resourcesPath, 'openflux.example.yaml'));
    }

    return paths;
}

const CONFIG_PATHS = getConfigPaths();

/**
 * 加载配置文件
 */
export async function loadConfig(): Promise<OpenFluxConfig> {
    // 查找配置文件
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

        // 合并 providers 配置到 llm 配置
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
 * 默认配置
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
