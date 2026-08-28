// A breadcrumb for startup failures. There is no console on a TV, so without
// this a startup that throws is invisible: the user sees a symptom and nobody
// can tell which statement produced it. Written on failure, cleared on a clean
// start, and surfaced as a row in the settings menu while it is present.

const STARTUP_ERROR_KEY = 'tizentube.startupError';

/** What the mod stores about a startup failure. */
export interface StartupError {
    message: string;
    count: number;
    at: string;
}

export function recordStartupError(error: unknown): void {
    try {
        let previous: Partial<StartupError> = {};
        try {
            previous = JSON.parse(localStorage[STARTUP_ERROR_KEY]) || {};
        } catch (e) { }

        localStorage[STARTUP_ERROR_KEY] = JSON.stringify({
            message: String((error && (error as { stack?: unknown }).stack) || error).slice(0, 700),
            count: (previous.count || 0) + 1,
            at: new Date().toString()
        });
    } catch (e) {
        // Never let the reporting path become a second failure.
    }
}

export function clearStartupError(): void {
    try {
        delete localStorage[STARTUP_ERROR_KEY];
    } catch (e) { }
}

export function readStartupError(): StartupError | null {
    try {
        const stored: StartupError | null = JSON.parse(localStorage[STARTUP_ERROR_KEY]);
        return stored && stored.message ? stored : null;
    } catch (e) {
        return null;
    }
}
