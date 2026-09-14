// A JSON string is returned so WKWebView never tries to serialize undefined,
// bigint, cyclic objects, or an Objective-C-incompatible JavaScript value.
(thunk) => {
    try {
        // The host inserts the expression directly into the WK evaluation
        // script. Page CSP must never need unsafe-eval or Function permission.
        const value = thunk();
        if (value && typeof value.then === 'function') {
            throw new Error('Promise evaluation is not supported by the macOS embedded browser bridge');
        }
        const type = typeof value;
        const result = { type };
        if (value === null) {
            result.subtype = 'null';
            result.value = null;
        } else if (type === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
            result.unserializableValue = Object.is(value, -0) ? '-0' : String(value);
        } else if (type === 'bigint') {
            result.unserializableValue = `${value}n`;
        } else if (type === 'function' || type === 'symbol') {
            throw new Error(`Cannot return ${type} by value from the macOS embedded browser`);
        } else if (type !== 'undefined') {
            // Copies JSON data and fails explicitly for cyclic results.
            result.value = JSON.parse(JSON.stringify(value));
            if (Array.isArray(value)) result.subtype = 'array';
        }
        return JSON.stringify({ result });
    } catch (error) {
        const description = String(error?.stack || error?.message || error);
        const exception = { type: 'object', subtype: 'error', description };
        return JSON.stringify({ result: exception, exceptionDetails: { text: String(error?.message || error), exception } });
    }
}
