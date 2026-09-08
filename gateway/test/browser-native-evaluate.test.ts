import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const bridge = readFileSync(new URL('../../src-tauri/src/commands/browser_view/evaluate.js', import.meta.url), 'utf8');

/** Match the native bridge's invocation; JSON text must survive WKWebView's return boundary. */
function evaluate(expression: string, globals: Record<string, unknown> = {}) {
    const context = createContext(globals, { codeGeneration: { strings: false, wasm: false } });
    // The expression is compiled directly by the host, exactly like WKWebView
    // evaluation. The page never calls eval or Function to compile it again.
    const raw = runInContext(`(${bridge})(() => (\n${expression}\n))`, context, { timeout: 1000 });
    assert.equal(typeof raw, 'string', 'the callback boundary must always receive a JSON string');
    const wkCallback = JSON.stringify(raw);
    return JSON.parse(JSON.parse(wkCallback));
}

function failed(expression: string, expected: RegExp) {
    const result = evaluate(expression);
    assert.ok(result.exceptionDetails, 'a failed evaluation must never masquerade as successful undefined');
    assert.equal(result.result.subtype, 'error');
    assert.equal(result.exceptionDetails.exception.subtype, 'error');
    assert.match(result.exceptionDetails.text, expected);
    assert.equal(Object.hasOwn(result.result, 'value'), false);
    return result;
}

test('native evaluation returns Unicode, quotes and line breaks without encoding loss', () => {
    const text = '中文输入 🦊 "quotes" \\ path\nnew line\u2028separator';
    assert.deepEqual(evaluate(JSON.stringify(text)), { result: { type: 'string', value: text } });
});

test('native evaluation preserves structured values, booleans, arrays and null', () => {
    assert.deepEqual(evaluate('({ title: "页面", values: [1, true, null], nested: { ok: false } })'), {
        result: { type: 'object', value: { title: '页面', values: [1, true, null], nested: { ok: false } } },
    });
    assert.deepEqual(evaluate('[1, "two"]'), { result: { type: 'object', subtype: 'array', value: [1, 'two'] } });
    assert.deepEqual(evaluate('null'), { result: { type: 'object', subtype: 'null', value: null } });
    assert.deepEqual(evaluate('false'), { result: { type: 'boolean', value: false } });
});

test('successful undefined is distinguishable from an exception or JSON null', () => {
    const result = evaluate('void 0');
    assert.deepEqual(result, { result: { type: 'undefined' } });
    assert.equal(Object.hasOwn(result, 'exceptionDetails'), false);
    assert.equal(Object.hasOwn(result.result, 'value'), false);
});

test('special numeric and bigint values use the CDP unserializableValue contract', () => {
    for (const expression of ['NaN', 'Infinity', '-Infinity', '-0']) {
        assert.deepEqual(evaluate(expression), { result: { type: 'number', unserializableValue: expression } });
    }
    assert.deepEqual(evaluate('9007199254740993n'), { result: { type: 'bigint', unserializableValue: '9007199254740993n' } });
});

test('evaluation executes in page globals without exposing the bridge parameter closure', () => {
    const globals = { fixtureValue: 17 };
    assert.deepEqual(evaluate('fixtureValue + 1', globals), { result: { type: 'number', value: 18 } });
    assert.deepEqual(evaluate('typeof params'), { result: { type: 'string', value: 'undefined' } });
});

test('runtime exceptions remain explicit errors across the callback boundary', () => {
    failed('(() => { throw new Error("页面执行失败") })()', /页面执行失败/);
    failed('(() => { throw "string failure" })()', /string failure/);
    failed('missingFixtureVariable + 1', /missingFixtureVariable/);
});

test('invalid syntax and bare statements fail host compilation before any success envelope', () => {
    assert.throws(() => evaluate('const = broken'), /Unexpected token|Unexpected reserved word/);
    assert.throws(() => evaluate('throw new Error("bare statement")'), /Unexpected token/);
    assert.throws(() => evaluate('1; 2'), /Unexpected token/);
});

test('CSP-like disabled eval and Function still allow ordinary expressions and synchronous IIFEs', () => {
    assert.deepEqual(evaluate('6 * 7'), { result: { type: 'number', value: 42 } });
    assert.deepEqual(evaluate('(() => { const text = "CSP 安全"; return { text, count: 2 }; })()'), {
        result: { type: 'object', value: { text: 'CSP 安全', count: 2 } },
    });
    // Verify the fixture actually prohibits both dynamic compilation paths.
    failed('eval("1 + 1")', /Code generation from strings disallowed/);
    failed('Function("return 2")()', /Code generation from strings disallowed/);
});

test('cyclic results and nested bigint serialization errors never become successful empty objects', () => {
    failed('(() => { const value = {}; value.self = value; return value; })()', /circular|cyclic/i);
    failed('({ unsupported: 1n })', /BigInt/i);
});

test('function and symbol results are rejected with an actionable error', () => {
    failed('(() => 1)', /Cannot return function by value/);
    failed('Symbol("fixture")', /Cannot return symbol by value/);
});

test('Promise and thenable results are explicitly unsupported rather than reported completed', () => {
    failed('Promise.resolve({ ready: true })', /Promise evaluation is not supported/);
    failed('({ then() {} })', /Promise evaluation is not supported/);
});

test('failing result serializers remain errors instead of a successful evaluation envelope', () => {
    failed('({ toJSON() { throw new Error("serialization failed") } })', /serialization failed/);
    failed('({ toJSON() { return undefined } })', /JSON|Unexpected token|undefined/);
});
