/**
 * The iteration budget is a safety net against runaway loops, not a limit the
 * user should ever feel. A turn that is still making progress when its budget
 * runs low quietly gets more; only a turn that has stopped progressing is
 * asked to wrap up, and even then the wording is "here is where things stand",
 * never "limit reached". At the hard ceiling a still-progressing turn hands
 * off to an automatic continuation turn instead of stopping.
 */

/** What one model iteration achieved, judged by its tool calls. */
export interface IterationProgressSample {
    /** Successful calls that changed state (wrote files, ran commands, drove a page). */
    mutations: number;
    /** Successful read-only calls whose (tool, args) had not been seen before this turn. */
    novel: number;
    /** Read-only calls skipped as exact repeats. */
    duplicates: number;
}

/** Added to the budget each time a progressing turn runs low. */
export const ITERATION_BUDGET_EXTENSION = 20;
/** Absolute cap per turn; beyond it a progressing turn continues in a new turn. */
export const DEFAULT_HARD_ITERATION_CEILING = 120;
/** How many recent iterations decide whether the turn is progressing. */
export const PROGRESS_WINDOW = 10;

/**
 * A turn is progressing when its recent iterations changed something, or
 * kept discovering new information rather than re-reading what it has.
 */
export function isProgressing(samples: IterationProgressSample[], window = PROGRESS_WINDOW): boolean {
    const recent = samples.slice(-window);
    if (recent.length === 0) return false;
    let mutations = 0;
    let novel = 0;
    let duplicates = 0;
    for (const s of recent) {
        mutations += s.mutations;
        novel += s.novel;
        duplicates += s.duplicates;
    }
    if (mutations >= 1) return true;
    return novel >= 3 && duplicates <= novel;
}

/**
 * The budget to use from here on. Extends only when the turn is about to be
 * asked to finalize (one iteration left), is progressing, and has room under
 * the ceiling; otherwise the current budget stands.
 */
export function extendedBudget(current: number, iterations: number, ceiling: number, progressing: boolean): number {
    if (!progressing || current >= ceiling) return current;
    if (current - iterations > 1) return current;
    return Math.min(ceiling, current + ITERATION_BUDGET_EXTENSION);
}
