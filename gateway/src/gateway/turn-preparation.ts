/** End the native turn promptly even when an upstream preparation ignores abort. */
export async function prepareTurnInput<T>(prepare: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason || new DOMException('Stopped by user', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([prepare(signal), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
