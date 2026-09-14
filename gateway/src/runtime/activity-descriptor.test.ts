import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolAction, describeToolCommand, describeToolCompletion, sanitizeActivityCommand } from './activity-descriptor';

test('command tools project only their command text and keep action titles semantic', () => {
    const args = { command: 'pnpm test --filter gateway', cwd: '/private/workspace', env: { TOKEN: 'private-env' }, payload: 'unrelated-data' };
    for (const tool of ['process', 'shell', 'terminal', 'powershell', 'cmd', 'bash', 'exec', 'exec_command', 'shell_command', 'namespace.exec_command']) {
        assert.equal(describeToolCommand(tool, args), args.command, tool);
        assert.equal(describeToolAction(tool, args, 'zh'), '运行测试', tool);
    }
    for (const [command, label] of [
        ['pnpm build', '构建项目'], ['git status --short', '检查 Git 工作区状态'],
        ['git diff HEAD', '检查代码差异'], ['Get-Content sample.txt', '读取文件：sample.txt'],
        ['rg needle src', '搜索代码'], ['ls -la', '列出文件'], ['node worker.js', '执行命令'],
    ]) {
        assert.equal(describeToolAction('process', { command }, 'zh'), label);
        assert.equal(describeToolCommand('process', { command }), command);
    }
    assert.equal(describeToolCommand('filesystem', { ...args, action: 'read' }), undefined);
    assert.equal(describeToolCommand('process', { command: '   ', env: args.env }), undefined);
    assert.equal(describeToolCommand('process', { command: 42 }), undefined);
    assert.equal(args.env.TOKEN, 'private-env');
});

test('Windows PowerShell exposes a safe script but system inspection has no command', () => {
    const args = { action: 'powershell', script: 'Get-Content test.txt\r\nWrite-Output done', password: 'unrelated-secret' };
    assert.equal(describeToolAction('windows', args, 'zh'), '读取文件：test.txt');
    assert.equal(describeToolCommand('windows', args), 'Get-Content test.txt Write-Output done');
    assert.equal(describeToolCommand('windows', { action: 'powershell', command: 'Get-Date' }), 'Get-Date');
    assert.equal(describeToolAction('windows', { action: 'system' }, 'zh'), '读取系统配置');
    assert.equal(describeToolAction('windows', { action: 'system' }), 'Read system configuration');
    assert.equal(describeToolCommand('windows', { ...args, action: 'system' }), undefined);
    assert.equal(describeToolCommand('windows', { ...args, action: 'clipboard' }), undefined);
});

test('command previews redact shared credential formats, assignments, flags and headers before publication', () => {
    const fixtures = [
        ['curl -H "Authorization: Bearer short-credential" https://example.test', 'short-credential'],
        ['curl -H "Cookie: session=private-cookie; other=also-private" https://example.test', 'private-cookie', 'also-private'],
        ['TOKEN=plain-token node run.js', 'plain-token'],
        ['node app.js --api-key cli-credential --token=flag-credential', 'cli-credential', 'flag-credential'],
        ['echo password="a synthetic secret phrase"', 'a synthetic secret phrase'],
        ['$env:OPENAI_API_KEY="environment-credential"; node app.js', 'environment-credential'],
        ['node app.js sk-abcdefghijklmnopqrstuvwx', 'sk-abcdefghijklmnopqrstuvwx'],
        ['echo "-----BEGIN PRIVATE KEY-----\nsynthetic-key-body\n-----END PRIVATE KEY-----"', 'synthetic-key-body'],
    ];
    for (const [command, ...secrets] of fixtures) {
        const preview = describeToolCommand('shell', { command })!;
        assert.match(preview, /\[REDACTED\]/);
        for (const secret of secrets) assert.equal(preview.includes(secret), false, `leaked fixture ${secret}`);
        assert.equal(sanitizeActivityCommand(preview), preview, 'tracker sanitation must be idempotent');
    }
});

test('long commands stay one line within 600 characters and boundary-spanning secrets are redacted first', () => {
    const command = `node run.js\n\t${'a'.repeat(900)}`;
    const preview = describeToolCommand('exec', { command })!;
    assert.equal(preview.length, 600);
    assert.ok(preview.endsWith('…'));
    assert.doesNotMatch(preview, /[\r\n\t]/);
    const token = `sk-${'S'.repeat(160)}`;
    const boundary = describeToolCommand('exec', { command: `echo ${'x'.repeat(565)} ${token}` })!;
    assert.match(boundary, /\[REDACTED\]/);
    assert.equal(boundary.includes('sk-SSSS'), false);
    assert.ok(boundary.length <= 600);
});

const credentialBoundaryCases = [
    {
        name: 'curl short cookie option',
        command: 'curl -b "sid=COOKIE_SENTINEL; other=SECOND_COOKIE_SENTINEL" https://example.test',
        secrets: ['COOKIE_SENTINEL', 'SECOND_COOKIE_SENTINEL'],
    },
    {
        name: 'curl user authentication option',
        command: 'curl --user "alice:AUTH_SENTINEL" https://example.test',
        secrets: ['AUTH_SENTINEL'],
    },
    {
        name: 'an escaped quote inside a password value',
        command: String.raw`node app.js --password "prefix\"ESCAPED_SENTINEL"`,
        secrets: ['ESCAPED_SENTINEL'],
    },
    {
        name: 'a partially redacted Cookie header',
        command: 'curl -H "Cookie: [REDACTED]; sid=COOKIE_SENTINEL" https://example.test',
        secrets: ['COOKIE_SENTINEL'],
    },
];

for (const fixture of credentialBoundaryCases) {
    test(`command projection fully redacts ${fixture.name} and remains idempotent`, () => {
        const preview = describeToolCommand('shell', { command: fixture.command })!;
        assert.ok(preview);
        for (const secret of fixture.secrets) {
            assert.equal(preview.includes(secret), false, `${fixture.name} leaked its synthetic credential`);
        }
        assert.match(preview, /\[REDACTED\]/);
        assert.equal(sanitizeActivityCommand(preview), preview, 'the tracker must not change an already sanitized command');
    });
}

test('filesystem completion reports reads as reads even though read results carry size', () => {
    // A read result looks like { path, content, size }; `size` alone must not mean "wrote".
    const readResult = { path: '/w/doc.md', content: 'x'.repeat(1260), size: 1260 };
    assert.equal(describeToolCompletion('filesystem', { action: 'read', path: '/w/doc.md' }, readResult, false, 'zh'), '已读取 1260 个字符');
    assert.equal(describeToolCompletion('filesystem', { action: 'read', path: '/w/doc.md' }, readResult, false, 'en'), 'Read 1260 characters');

    // Writes and appends still report bytes written.
    assert.equal(describeToolCompletion('filesystem', { action: 'write', path: '/w/doc.md' }, { path: '/w/doc.md', written: true, size: 1260 }, false, 'zh'), '已写入 1260 字节');
    assert.equal(describeToolCompletion('filesystem', { action: 'append', path: '/w/doc.md' }, { path: '/w/doc.md', appended: true, size: 42 }, false, 'en'), 'Wrote 42 bytes');

    // Metadata lookups describe the size without claiming a write.
    assert.equal(describeToolCompletion('filesystem', { action: 'info', path: '/w/doc.md' }, { path: '/w/doc.md', size: 9000 }, false, 'zh'), '文件大小 9000 字节');
});

test('shell read commands are labelled with just the file name', () => {
    const ps = `powershell -Command "Get-Content 'D:\\edeProject\\fms-new\\docs\\10-模块逻辑\\09-贷款Loan.md' -Encoding UTF8 | Select-Object -First 40"`;
    assert.equal(describeToolAction('process', { command: ps }, 'zh'), '读取文件：09-贷款Loan.md');
    assert.equal(describeToolAction('process', { command: ps }, 'en'), 'Read file: 09-贷款Loan.md');
    assert.equal(describeToolAction('process', { command: 'cat -n src/main.ts | head' }, 'zh'), '读取文件');
    assert.equal(describeToolAction('process', { command: 'cat "src/app/main.ts"' }, 'zh'), '读取文件：main.ts');
    assert.equal(describeToolAction('process', { command: 'Get-Content -Path .\\README.md' }, 'zh'), '读取文件：README.md');
    assert.equal(describeToolAction('windows', { action: 'powershell', script: 'type D:\\a\\b.txt' }, 'zh'), '读取文件：b.txt');
});

test('a deduplicated read is labelled as skipped, not as read or written', () => {
    const skipped = { success: true, code: 'DUPLICATE_READ_SKIPPED', data: { skipped: true, sameAsCall: 5 } };
    assert.equal(describeToolCompletion('filesystem', { action: 'read', path: '/w/a.vue' }, skipped, false, 'zh'), '与之前读取相同，已跳过');
    assert.equal(describeToolCompletion('filesystem', { action: 'read', path: '/w/a.vue' }, skipped, false, 'en'), 'Same as an earlier read; skipped');
});
