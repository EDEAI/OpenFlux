import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_SIZE = 118_308_126;
const EXPECTED_SHA256 = '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(
      scriptDir,
      '..',
      'src-tauri',
      'resources',
      'models',
      'transformers',
      'Xenova',
      'paraphrase-multilingual-MiniLM-L12-v2',
      'onnx',
      'model_quantized.onnx',
    );

function fail(message) {
  console.error(`[release-resources] ERROR: ${message}`);
  console.error('[release-resources] Restore Git LFS objects before building: git lfs install && git lfs pull');
  process.exit(1);
}

let stat;
try {
  stat = statSync(modelPath);
} catch (error) {
  fail(`Embedding model is missing: ${modelPath} (${error.message})`);
}

if (!stat.isFile()) {
  fail(`Embedding model is not a regular file: ${modelPath}`);
}

if (stat.size < 1024) {
  const prefix = readFileSync(modelPath, { encoding: 'utf8' }).slice(0, 200);
  if (prefix.startsWith('version https://git-lfs.github.com/spec/v1')) {
    fail(`Embedding model is an unresolved Git LFS pointer (${stat.size} bytes): ${modelPath}`);
  }
}

if (stat.size !== EXPECTED_SIZE) {
  fail(`Embedding model size mismatch: expected ${EXPECTED_SIZE}, got ${stat.size}: ${modelPath}`);
}

const hash = createHash('sha256');
await new Promise((resolvePromise, rejectPromise) => {
  const stream = createReadStream(modelPath);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', rejectPromise);
  stream.on('end', resolvePromise);
});

const actualSha256 = hash.digest('hex');
if (actualSha256 !== EXPECTED_SHA256) {
  fail(`Embedding model SHA256 mismatch: expected ${EXPECTED_SHA256}, got ${actualSha256}`);
}

console.log(`[release-resources] Embedding model verified (${stat.size} bytes, sha256=${actualSha256})`);
