// Release-time checks run with the exact Node binary shipped in the app.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, directory] = process.argv.slice(2);
assert(directory, 'Usage: verify-gateway-bundle.mjs --verify-lock|--onnx-root|--verify-bundle <directory>');
const root = realpathSync(directory);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const requireBundle = createRequire(path.join(root, 'package.json'));

function onnxRoot() {
    const requireTransformers = createRequire(requireBundle.resolve('@huggingface/transformers'));
    const resolved = realpathSync(path.dirname(requireTransformers.resolve('onnxruntime-node/package.json')));
    const relative = path.relative(root, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'ONNX resolved outside the production bundle');
    return resolved;
}

if (mode === '--verify-lock') {
    const pkg = readJson(path.join(root, 'package.json'));
    const lock = readJson(path.join(root, 'package-lock.json'));
    assert.equal(lock.lockfileVersion, 3, 'Gateway requires an npm v3 lockfile');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        assert.deepEqual(lock.packages[''][key] ?? {}, pkg[key] ?? {}, `package-lock.json ${key} is out of sync`);
    }
    assert(pkg.dependencies.tsx, 'tsx must be a locked production dependency');
    // A lock generated beside platform-specific node_modules can accidentally
    // omit the native optional packages required by the other release targets.
    const packages = [
        '@esbuild/win32-x64', '@esbuild/darwin-arm64', '@esbuild/darwin-x64',
        '@img/sharp-win32-x64', '@img/sharp-darwin-arm64', '@img/sharp-darwin-x64',
        '@img/sharp-libvips-darwin-arm64', '@img/sharp-libvips-darwin-x64',
        '@napi-rs/canvas-win32-x64-msvc', '@napi-rs/canvas-darwin-arm64', '@napi-rs/canvas-darwin-x64',
        'sqlite-vec-windows-x64', 'sqlite-vec-darwin-arm64', 'sqlite-vec-darwin-x64',
    ];
    for (const name of packages) {
        const entry = lock.packages[`node_modules/${name}`];
        assert(entry?.version && entry.integrity && entry.optional, `Missing locked native optional dependency: ${name}`);
    }
    console.log(`[verify-gateway] Lock matches package.json; ${packages.length} cross-platform native packages present.`);
} else if (mode === '--onnx-root') {
    console.log(onnxRoot());
} else if (mode === '--verify-bundle') {
    const Database = requireBundle('better-sqlite3');
    const db = new Database(':memory:');
    try {
        assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42);
        requireBundle('sqlite-vec').load(db);
        assert.equal(typeof db.prepare('SELECT vec_version() AS version').get().version, 'string');
    } finally {
        db.close();
    }
    const sharp = requireBundle('sharp');
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
    assert.equal((await sharp(png).metadata()).width, 2);
    const { createCanvas } = requireBundle('@napi-rs/canvas');
    assert(createCanvas(2, 2).toBuffer('image/png').length > 0);
    if (process.platform === 'win32') {
        assert.equal(typeof requireBundle('keysender').Hardware, 'function');
    }
    requireBundle.resolve('tsx/esm');
    requireBundle('esbuild').transformSync('const value: number = 1', { loader: 'ts' });
    const transformersEntry = path.join(path.dirname(requireBundle.resolve('@huggingface/transformers')), 'transformers.node.mjs');
    const { env, pipeline } = await import(pathToFileURL(transformersEntry).href);
    env.localModelPath = path.join(root, 'resources', 'models', 'transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = false;
    const extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { dtype: 'q8' });
    try {
        const embedding = await extractor('OpenFlux release verification', { pooling: 'mean', normalize: true });
        assert.equal(embedding.data.length, 384, 'Bundled embedding must produce 384 dimensions');
        assert(Array.from(embedding.data).every(Number.isFinite), 'Bundled embedding contains invalid values');
    } finally {
        await extractor.dispose();
    }
    const onnxVersion = readJson(path.join(onnxRoot(), 'package.json')).version;
    console.log(`[verify-gateway] OK Node ${process.version} ${process.platform}/${process.arch}; SQLite, sqlite-vec, sharp, canvas, tsx/esbuild, ONNX ${onnxVersion}, offline embedding=384.`);
} else {
    throw new Error(`Unknown verification mode: ${mode}`);
}
