import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolCommandPreview } from '../../src/utils/tool-log';

test('legacy command previews extract only executable text and remain bounded to one line', () => {
    const fixtures: Array<[string, Record<string, unknown>, string]> = [
        ['process', { action: 'run', command: 'pnpm test --filter gateway', env: { TOKEN: 'excluded-env' } }, 'pnpm test --filter gateway'],
        ['process', { action: 'shell', name: 'node worker.js' }, 'node worker.js'],
        ['opencode', { action: 'run', command: 'npm run build' }, 'npm run build'],
        ['windows', { action: 'powershell', script: 'Get-Content test.txt\r\n\tWrite-Output done' }, 'Get-Content test.txt Write-Output done'],
        ['exec_command', { cmd: 'git status --short' }, 'git status --short'],
        ['bash', { script: 'printf example' }, 'printf example'],
    ];
    for (const [tool, args, expected] of fixtures) {
        const before = structuredClone(args);
        assert.equal(getToolCommandPreview(tool, args), expected, tool);
        assert.deepEqual(args, before, 'preview generation must not change the stored log');
    }
    const long = getToolCommandPreview('shell', { command: `echo\n${'x'.repeat(800)}` });
    assert.ok(long.length <= 600);
    assert.doesNotMatch(long, /[\r\n\t]/);
    assert.equal(getToolCommandPreview('shell'), '');
});

test('legacy command previews redact credential assignments, authorization and command-line flags', () => {
    const fixtures: Array<[string, string[]]> = [
        ['curl -H "Authorization: Bearer synthetic-bearer-token" https://example.test', ['synthetic-bearer-token']],
        ['API_KEY=synthetic-api-key TOKEN=synthetic-token node app.js', ['synthetic-api-key', 'synthetic-token']],
        ['node app.js --token synthetic-flag-secret', ['synthetic-flag-secret']],
        ['node app.js password="first distinctive-secret-tail"', ['first', 'distinctive-secret-tail']],
    ];
    for (const [command, secrets] of fixtures) {
        const preview = getToolCommandPreview('process', { action: 'run', command });
        assert.match(preview, /\[REDACTED\]/);
        for (const secret of secrets) assert.equal(preview.includes(secret), false, `credential remains visible: ${secret}`);
    }
});

test('Windows system inspection and unrelated operations do not invent a command preview', () => {
    const stray = { command: 'must-not-display', script: 'must-not-display', name: 'must-not-display' };
    assert.equal(getToolCommandPreview('windows', { ...stray, action: 'system' }), '');
    assert.equal(getToolCommandPreview('windows', { ...stray, action: 'clipboard' }), '');
    assert.equal(getToolCommandPreview('filesystem', { ...stray, action: 'read' }), '');
    assert.equal(getToolCommandPreview('process', { ...stray, action: 'list' }), '');
});
