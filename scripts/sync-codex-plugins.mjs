#!/usr/bin/env node
/**
 * sync-codex-plugins.mjs — 把 openai/plugins（Codex 官方插件市场）里选定的插件镜像到 OpenFlux。
 *
 * Codex 插件是纯文件包：<plugin>/.codex-plugin/plugin.json + skills/ (+ .mcp.json / .app.json)。
 * 本脚本不依赖本机安装 codex，只用 git 做 sparse clone，然后：
 *   1. 解析每个插件的 plugin.json，扫描 skills 目录里的 SKILL.md（frontmatter name/description）
 *   2. 把插件目录整体复制到镜像目录 src-tauri/resources/plugin-hub/plugins/<id>/（随安装包打进 Tauri resources，
 *      gateway 通过 OPENFLUX_RESOURCE_DIR 找到它）
 *   3. 生成 src-tauri/resources/plugin-hub/index.json（客户端插件页和 gateway PluginHub 都读它）
 *   4. 可选 --dist <dir>：额外产出 <id>-<version>.tar.gz + sha256 + index.json，供上传 openflux.io/plugins/
 *
 * 用法：
 *   node scripts/sync-codex-plugins.mjs                       # 同步 DEFAULT_PLUGINS 到 src-tauri/resources/plugin-hub
 *   node scripts/sync-codex-plugins.mjs --plugins a,b --dist out/plugin-hub-dist
 *   node scripts/sync-codex-plugins.mjs --local-only            # 只刷新 scripts/plugin-hub-local/ 下我们自己的插件
 *   node scripts/sync-codex-plugins.mjs --repo <git url> --ref main --out <dir>
 *   node scripts/sync-codex-plugins.mjs --plugins <id> --allow-license <SPDX>   # 非白名单许可证需显式放行
 *   node scripts/sync-codex-plugins.mjs --local-only --remove figma           # 从镜像和索引里删掉一个插件
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const DEFAULT_REPO = 'https://github.com/openai/plugins.git';
const DEFAULT_REF = 'main';
const DEFAULT_MARKETPLACE = 'openai-curated';
/** 默认同步的插件（纯技能包，MIT / Apache-2.0，可再分发） */
const DEFAULT_PLUGINS = ['hyperframes', 'remotion'];
/** DEFAULT_PLUGINS 里非白名单许可证的插件：显式放行（等同 --allow-license） */
const DEFAULT_ALLOW_LICENSES = [];
/** 本仓库自己维护的插件（与 Codex 插件同一目录格式），随 --local-dir 一起镜像进插件中心 */
const DEFAULT_LOCAL_DIR = join(projectRoot, 'scripts', 'plugin-hub-local');
const LOCAL_MARKETPLACE = 'openflux';
/** 插件文案本地化（按 id → 语言 → 字段），随索引下发，客户端按界面语言覆盖英文原文 */
const HUB_I18N_FILE = join(projectRoot, 'scripts', 'plugin-hub-i18n.json');
function loadHubI18n() {
    if (!existsSync(HUB_I18N_FILE)) return {};
    const raw = JSON.parse(readFileSync(HUB_I18N_FILE, 'utf-8'));
    delete raw._comment;
    return raw;
}
const HUB_I18N = loadHubI18n();
/** 允许镜像再分发的许可证白名单；不在名单内的插件只写索引条目、不复制文件 */
const REDISTRIBUTABLE_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'CC0-1.0', 'Unlicense']);
/** 单个文件超过此大小不镜像（避免把示例视频/大图打进安装包） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 文本类参考文件（如大型 .d.ts）允许更大，技能靠 grep 按需读 */
const MAX_TEXT_FILE_BYTES = 12 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.ts', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.html', '.css', '.csv', '.xml', '.svg', '.sh', '.ps1', '.py']);
/** 复制时跳过的目录/文件 */
const SKIP_NAMES = new Set(['.git', '.gitignore', '.DS_Store', 'node_modules', '.app.json', '__pycache__']);

function parseArgs(argv) {
    const args = { repo: DEFAULT_REPO, ref: DEFAULT_REF, plugins: DEFAULT_PLUGINS, out: join(projectRoot, 'src-tauri', 'resources', 'plugin-hub'), dist: null, marketplace: DEFAULT_MARKETPLACE, keep: false, allowLicenses: new Set(), localDir: DEFAULT_LOCAL_DIR, localOnly: false, remove: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--repo') args.repo = next();
        else if (a === '--ref') args.ref = next();
        else if (a === '--plugins') args.plugins = next().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--out') args.out = resolve(next());
        else if (a === '--dist') args.dist = resolve(next());
        else if (a === '--local-dir') args.localDir = resolve(next());
        else if (a === '--local-only') args.localOnly = true;   // 只镜像本地插件，不 clone GitHub
        else if (a === '--remove') args.remove = next().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--marketplace') args.marketplace = next();
        else if (a === '--keep') args.keep = true;
        else if (a === '--allow-license') for (const l of next().split(',')) args.allowLicenses.add(l.trim());
        else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0]); process.exit(0); }
        else throw new Error(`unknown argument: ${a}`);
    }
    for (const l of DEFAULT_ALLOW_LICENSES) args.allowLicenses.add(l);
    return args;
}

function run(cmd, cmdArgs, opts = {}) {
    const res = spawnSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', ...opts });
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${res.status}):\n${res.stderr}`);
    return res.stdout.trim();
}

/** sparse clone：只拉需要的插件目录 */
function cloneSparse(repo, ref, plugins) {
    const dir = mkdtempSync(join(tmpdir(), 'openflux-codex-plugins-'));
    console.log(`[sync] cloning ${repo}@${ref} (sparse) -> ${dir}`);
    run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', ref, repo, dir]);
    // remotion 插件里有很深的嵌套路径，Windows 默认 260 字符会失败
    run('git', ['config', 'core.longpaths', 'true'], { cwd: dir });
    run('git', ['sparse-checkout', 'set', ...plugins.map(p => `plugins/${p}`)], { cwd: dir });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return { dir, commit };
}

/** 极简 YAML frontmatter：只取顶层 `key: value` */
function parseFrontmatter(content) {
    const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    const fm = {};
    if (!m) return { fm, body: content };
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!kv) continue;
        let v = kv[2].trim();
        if (v === '|' || v === '>' || v === '|-' || v === '>-') {
            // 块标量：收集后续缩进行；`|` 保留换行，`>` 折叠成空格
            const block = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
            v = block.join(v.startsWith('|') ? '\n' : ' ').trim();
        } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        fm[kv[1]] = v;
    }
    return { fm, body: content.slice(m[0].length) };
}

/** 解析 <plugin>/.codex-plugin/plugin.json（同时兼容 .claude-plugin / .cursor-plugin） */
function readManifest(pluginRoot) {
    for (const rel of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json']) {
        const p = join(pluginRoot, rel);
        if (existsSync(p)) return { manifestPath: rel, manifest: JSON.parse(readFileSync(p, 'utf-8')) };
    }
    throw new Error(`no plugin manifest under ${pluginRoot}`);
}

/** 找出所有技能：skills 字段可以是目录（含若干 <skill>/SKILL.md）或数组 */
function collectSkills(pluginRoot, manifest) {
    const decl = manifest.skills;
    const roots = Array.isArray(decl) ? decl : decl ? [decl] : [];
    const skills = [];
    const seen = new Set();
    const addSkillDir = (dir) => {
        const skillMd = join(dir, 'SKILL.md');
        if (!existsSync(skillMd)) return;
        const rel = relative(pluginRoot, dir).split(sep).join('/');
        if (seen.has(rel)) return;
        seen.add(rel);
        const { fm } = parseFrontmatter(readFileSync(skillMd, 'utf-8'));
        skills.push({
            id: fm.name || basename(dir),
            name: fm.name || basename(dir),
            description: (fm.description || '').trim(),
            version: fm.version || undefined,
            path: rel,
        });
    };
    for (const r of roots) {
        const abs = resolve(pluginRoot, r);
        if (!existsSync(abs)) continue;
        if (existsSync(join(abs, 'SKILL.md'))) { addSkillDir(abs); continue; }
        // 只扫一层：skills/<name>/SKILL.md。remotion 的 router 技能内部还嵌套子技能目录，
        // 那些由 router SKILL.md 自己按需引用，不单独列出，否则提示词里会重复十几条。
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
            if (entry.isDirectory()) addSkillDir(join(abs, entry.name));
        }
    }
    return skills;
}

function readMcpServers(pluginRoot, manifest) {
    // 约定：manifest 没写 mcpServers 时，插件根目录的 .mcp.json 同样生效
    const decl = manifest.mcpServers ?? (existsSync(join(pluginRoot, '.mcp.json')) ? './.mcp.json' : undefined);
    if (!decl) return [];
    let obj = decl;
    if (typeof decl === 'string') {
        const p = resolve(pluginRoot, decl);
        if (!existsSync(p)) return [];
        obj = JSON.parse(readFileSync(p, 'utf-8'));
    }
    const servers = obj.mcpServers || obj;
    return Object.entries(servers).map(([name, cfg]) => ({
        name,
        transport: cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : 'unknown'),
        command: cfg.command, args: cfg.args, cwd: cfg.cwd, url: cfg.url,
        env: cfg.env, bearerTokenEnvVar: cfg.bearer_token_env_var, oauthResource: cfg.oauth_resource, headers: cfg.headers,
    }));
}

/** 递归复制，跳过大文件和 SKIP_NAMES */
function copyPlugin(src, dst) {
    let files = 0, bytes = 0, skipped = [];
    const walk = (from, to) => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
            if (SKIP_NAMES.has(entry.name)) continue;
            const f = join(from, entry.name), t = join(to, entry.name);
            if (entry.isDirectory()) { walk(f, t); continue; }
            if (!entry.isFile()) continue;
            const size = statSync(f).size;
            const limit = TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? MAX_TEXT_FILE_BYTES : MAX_FILE_BYTES;
            if (size > limit) { skipped.push(relative(src, f)); continue; }
            cpSync(f, t);
            files++; bytes += size;
        }
    };
    walk(src, dst);
    return { files, bytes, skipped };
}

/** Windows 上 PATH 里常常先找到 Git 的 GNU tar，它会把 `C:` 当远程主机；优先用系统自带的 bsdtar */
function tarCommand() {
    if (process.platform === 'win32') {
        const sys = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
        if (existsSync(sys)) return sys;
    }
    return 'tar';
}

function sha256File(p) {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function toIndexEntry({ id, marketplace, manifest, manifestPath, skills, mcpServers, hasApps, commit, files, bytes, syncedAt, mirrored, logo }) {
    const ui = manifest.interface || {};
    const compat = skills.length && !mcpServers.length ? 'full' : skills.length || mcpServers.length ? 'partial' : 'connector-only';
    return {
        id,
        marketplace,
        name: manifest.name || id,
        version: manifest.version || '0.0.0',
        displayName: ui.displayName || manifest.name || id,
        description: manifest.description || ui.shortDescription || '',
        shortDescription: ui.shortDescription || '',
        longDescription: ui.longDescription || '',
        developerName: ui.developerName || manifest.author?.name || '',
        category: ui.category || '',
        license: manifest.license || '',
        homepage: manifest.homepage || ui.websiteURL || '',
        repository: manifest.repository || '',
        keywords: manifest.keywords || [],
        defaultPrompt: ui.defaultPrompt || [],
        brandColor: ui.brandColor || '',
        logo,
        manifestPath,
        skills,
        mcpServers,
        hasApps,
        compat,
        mirrored,
        source: { repo: 'openai/plugins', commit, path: `plugins/${id}` },
        files, bytes, syncedAt,
        ...(HUB_I18N[id] ? { i18n: HUB_I18N[id] } : {}),
    };
}

/** 在镜像目录里挑一个可用的 logo（相对插件根） */
function pickLogo(pluginRoot, manifest) {
    const ui = manifest.interface || {};
    for (const rel of [ui.logo, ui.composerIcon, 'assets/logo.png', 'assets/icon.png']) {
        if (!rel) continue;
        const p = resolve(pluginRoot, rel);
        if (existsSync(p) && statSync(p).size <= MAX_FILE_BYTES) return relative(pluginRoot, p).split(sep).join('/');
    }
    return '';
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const syncedAt = new Date().toISOString();
    const { dir: cloneDir, commit } = args.localOnly ? { dir: null, commit: (existsSync(join(args.out, 'index.json')) ? (JSON.parse(readFileSync(join(args.out, 'index.json'), 'utf-8')).source?.commit || '') : '') } : cloneSparse(args.repo, args.ref, args.plugins);
    const outPlugins = join(args.out, 'plugins');
    mkdirSync(outPlugins, { recursive: true });
    if (args.dist) mkdirSync(args.dist, { recursive: true });

    // 保留索引里已有、但这次没同步的插件条目（增量同步）
    const indexPath = join(args.out, 'index.json');
    const previous = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : { plugins: [] };
    const entries = new Map((previous.plugins || []).map(p => [p.id, p]));
    for (const id of args.remove) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`bad plugin id: ${id}`);
        entries.delete(id);
        rmSync(join(outPlugins, id), { recursive: true, force: true });
        if (args.dist) for (const f of readdirSync(args.dist)) if (f.startsWith(`${id}-`)) rmSync(join(args.dist, f), { force: true });
        console.log(`[sync] removed ${id} from the mirror and index`);
    }

    for (const id of (args.localOnly ? [] : args.plugins)) {
        const src = join(cloneDir, 'plugins', id);
        if (!existsSync(src)) { console.warn(`[sync] plugin not found in repo: ${id}`); continue; }
        const { manifest, manifestPath } = readManifest(src);
        const skills = collectSkills(src, manifest);
        const mcpServers = readMcpServers(src, manifest);
        const hasApps = Boolean(manifest.apps);
        const license = manifest.license || '';
        const licenseAllowed = args.allowLicenses.has(license);
        const mirrored = REDISTRIBUTABLE_LICENSES.has(license) || licenseAllowed;
        let files = 0, bytes = 0;
        const dst = join(outPlugins, id);
        if (mirrored) {
            rmSync(dst, { recursive: true, force: true });
            const r = copyPlugin(src, dst);
            files = r.files; bytes = r.bytes;
            if (r.skipped.length) console.warn(`[sync] ${id}: skipped ${r.skipped.length} large file(s): ${r.skipped.slice(0, 5).join(', ')}${r.skipped.length > 5 ? ' …' : ''}`);
        } else {
            console.warn(`[sync] ${id}: license "${license || 'unknown'}" not in redistributable allowlist — index only, files not mirrored (pass --allow-license "${license}" to override)`);
        }
        const entry = toIndexEntry({ id, marketplace: args.marketplace, manifest, manifestPath, skills, mcpServers, hasApps, commit, files, bytes, syncedAt, mirrored, logo: mirrored ? pickLogo(dst, manifest) : '' });
        if (licenseAllowed) entry.licenseNote = `Mirrored under an explicit override; use is governed by the plugin's own license (${license}).`;

        if (args.dist && mirrored) {
            const archive = join(args.dist, `${id}-${entry.version}.tar.gz`);
            rmSync(archive, { force: true });
            // 归档根为 <id>/，与 Codex 的 bundle 布局一致；tar 在 Win10+/macOS/Linux 都自带
            run(tarCommand(), ['-czf', archive, '-C', outPlugins, id]);
            entry.archive = { file: basename(archive), sha256: sha256File(archive), bytes: statSync(archive).size };
        }
        entries.set(id, entry);
        console.log(`[sync] ${id}@${entry.version}: ${skills.length} skill(s), ${mcpServers.length} mcp, apps=${hasApps}, ${files} files / ${(bytes / 1024).toFixed(0)} KB, compat=${entry.compat}${mirrored ? '' : ' (not mirrored)'}`);
    }

    // 本地插件：scripts/plugin-hub-local/<id>/，许可证由我们自己决定，总是镜像
    if (args.localDir && existsSync(args.localDir)) {
        for (const entry of readdirSync(args.localDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const id = entry.name;
            const src = join(args.localDir, id);
            const { manifest, manifestPath } = readManifest(src);
            const skills = collectSkills(src, manifest);
            const mcpServers = readMcpServers(src, manifest);
            const dst = join(outPlugins, id);
            rmSync(dst, { recursive: true, force: true });
            const r = copyPlugin(src, dst);
            const e = toIndexEntry({ id, marketplace: LOCAL_MARKETPLACE, manifest, manifestPath, skills, mcpServers, hasApps: Boolean(manifest.apps), commit: '', files: r.files, bytes: r.bytes, syncedAt, mirrored: true, logo: pickLogo(dst, manifest) });
            e.source = { repo: 'openflux', commit: '', path: `scripts/plugin-hub-local/${id}` };
            if (args.dist) {
                const archive = join(args.dist, `${id}-${e.version}.tar.gz`);
                rmSync(archive, { force: true });
                run(tarCommand(), ['-czf', archive, '-C', outPlugins, id]);
                e.archive = { file: basename(archive), sha256: sha256File(archive), bytes: statSync(archive).size };
            }
            entries.set(id, e);
            console.log(`[sync] local ${id}@${e.version}: ${skills.length} skill(s), ${r.files} files / ${(r.bytes / 1024).toFixed(0)} KB`);
        }
    }

    // 文案本地化对所有条目生效（包括本次没重新同步、从旧索引沿用的条目）
    for (const e of entries.values()) { if (HUB_I18N[e.id]) e.i18n = HUB_I18N[e.id]; else delete e.i18n; }

    const index = {
        schemaVersion: 1,
        marketplace: args.marketplace,
        generatedAt: syncedAt,
        source: { repo: args.repo, ref: args.ref, commit },
        plugins: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
    console.log(`[sync] wrote ${indexPath} (${index.plugins.length} plugin(s))`);
    if (args.dist) {
        // dist 索引只带有归档的条目，archiveUrl 由上传方按 openflux.io/plugins/<file> 拼接
        const distIndex = { ...index, plugins: index.plugins.filter(p => p.archive) };
        writeFileSync(join(args.dist, 'index.json'), JSON.stringify(distIndex, null, 2) + '\n', 'utf-8');
        console.log(`[sync] wrote ${join(args.dist, 'index.json')}`);
    }
    if (cloneDir && !args.keep) rmSync(cloneDir, { recursive: true, force: true });
}

main();
