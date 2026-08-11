import { readFileSync } from 'node:fs';
import type { AgentRuntimeEvent } from '../runtime/events';
import { isAgentRuntimeEvent } from '../runtime/events';

export interface ReplayIssue {
    code: 'invalid_event' | 'sequence_gap' | 'event_after_terminal' | 'duplicate_terminal' | 'invalid_item_transition';
    message: string;
    line?: number;
    turnId?: string;
    eventId?: string;
}

export interface ReplayValidation {
    valid: boolean;
    events: AgentRuntimeEvent[];
    issues: ReplayIssue[];
}

/**
 * Load an activity JSONL file for deterministic regression/eval replay.
 * Invalid lines are reported instead of aborting the whole replay.
 */
export function loadRuntimeReplay(path: string): ReplayValidation {
    const events: AgentRuntimeEvent[] = [];
    const issues: ReplayIssue[] = [];
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
        if (!line.trim()) return;
        try {
            const value: unknown = JSON.parse(line);
            if (!isAgentRuntimeEvent(value)) throw new Error('schema mismatch');
            events.push(value);
        } catch {
            issues.push({
                code: 'invalid_event',
                message: `Line ${index + 1} is not a valid runtime event`,
                line: index + 1,
            });
        }
    });
    return validateRuntimeReplay(events, issues);
}

export function validateRuntimeReplay(
    events: AgentRuntimeEvent[],
    initialIssues: ReplayIssue[] = [],
): ReplayValidation {
    const issues = [...initialIssues];
    const turns = new Map<string, {
        nextSeq: number;
        terminal?: AgentRuntimeEvent['type'];
        items: Map<string, AgentRuntimeEvent['type']>;
    }>();

    for (const event of events) {
        const key = `${event.sessionId}:${event.turnId}`;
        const state = turns.get(key) || { nextSeq: 1, items: new Map<string, AgentRuntimeEvent['type']>() };

        if (event.seq !== state.nextSeq) {
            issues.push({
                code: 'sequence_gap',
                message: `Expected seq ${state.nextSeq}, received ${event.seq}`,
                turnId: event.turnId,
                eventId: event.eventId,
            });
            state.nextSeq = event.seq + 1;
        } else {
            state.nextSeq += 1;
        }

        if (state.terminal) {
            issues.push({
                code: event.type.startsWith('turn.') ? 'duplicate_terminal' : 'event_after_terminal',
                message: `Event ${event.type} appears after ${state.terminal}`,
                turnId: event.turnId,
                eventId: event.eventId,
            });
        }

        if (event.item) {
            const previous = state.items.get(event.item.id);
            const starts = event.type === 'item.started';
            const updates = event.type === 'item.updated';
            const finishes = event.type === 'item.completed' || event.type === 'item.failed';
            const invalid = (starts && previous !== undefined)
                || (updates && previous !== 'item.started' && previous !== 'item.updated')
                || (finishes && previous === 'item.completed')
                || (finishes && previous === 'item.failed');
            if (invalid) {
                issues.push({
                    code: 'invalid_item_transition',
                    message: `Invalid ${previous || 'empty'} -> ${event.type} transition for ${event.item.id}`,
                    turnId: event.turnId,
                    eventId: event.eventId,
                });
            }
            state.items.set(event.item.id, event.type);
        }

        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted') {
            state.terminal = event.type;
        }
        turns.set(key, state);
    }

    return { valid: issues.length === 0, events, issues };
}
