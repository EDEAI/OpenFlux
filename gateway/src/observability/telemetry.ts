import { randomUUID } from 'node:crypto';

export type TelemetryAttribute = string | number | boolean | undefined;

export interface SpanRecord {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    status: 'ok' | 'error';
    attributes: Record<string, TelemetryAttribute>;
    error?: string;
}

export type SpanSink = (record: SpanRecord) => void;

const SENSITIVE_ATTRIBUTE = /(?:authorization|cookie|credential|secret|token|password|api[-_]?key|prompt|input|output|arguments?|result|content)/i;

/**
 * Lightweight structured tracing seam. It is a no-op until a sink is supplied,
 * so an OpenTelemetry exporter can be connected without coupling the runtime to
 * a particular SDK. Potentially sensitive payload fields are dropped here.
 */
export class Telemetry {
    constructor(private sink?: SpanSink) {}

    setSink(sink?: SpanSink): void {
        this.sink = sink;
    }

    async trace<T>(
        name: string,
        context: { traceId?: string; parentSpanId?: string } = {},
        attributes: Record<string, TelemetryAttribute> = {},
        operation: () => Promise<T>,
    ): Promise<T> {
        const startedAt = Date.now();
        const traceId = context.traceId || randomUUID();
        const spanId = randomUUID();
        try {
            const value = await operation();
            this.publish({
                traceId,
                spanId,
                parentSpanId: context.parentSpanId,
                name,
                startedAt,
                finishedAt: Date.now(),
                status: 'ok',
                attributes: this.safeAttributes(attributes),
            });
            return value;
        } catch (error) {
            this.publish({
                traceId,
                spanId,
                parentSpanId: context.parentSpanId,
                name,
                startedAt,
                finishedAt: Date.now(),
                status: 'error',
                attributes: this.safeAttributes(attributes),
                error: error instanceof Error ? error.name : 'Error',
            });
            throw error;
        }
    }

    private safeAttributes(attributes: Record<string, TelemetryAttribute>): Record<string, TelemetryAttribute> {
        return Object.fromEntries(Object.entries(attributes).filter(([key]) => !SENSITIVE_ATTRIBUTE.test(key)));
    }

    private publish(record: Omit<SpanRecord, 'durationMs'>): void {
        if (!this.sink) return;
        this.sink({ ...record, durationMs: Math.max(0, record.finishedAt - record.startedAt) });
    }
}

export const telemetry = new Telemetry();
