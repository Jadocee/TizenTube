// A breadcrumb for startup failures. There is no console on a TV, so without
// this a startup that throws is invisible: the user sees a symptom and nobody
// can tell which statement produced it. Written on failure, cleared on a clean
// start, and surfaced as a row in the settings menu while it is present.

const STARTUP_ERROR_KEY = 'tizentube.startupError';

export function recordStartupError(error) {
    try {
        let previous = {};
        try {
            previous = JSON.parse(localStorage[STARTUP_ERROR_KEY]) || {};
        } catch (e) { }

        localStorage[STARTUP_ERROR_KEY] = JSON.stringify({
            message: String((error && error.stack) || error).slice(0, 700),
            count: (previous.count || 0) + 1,
            at: new Date().toString()
        });
    } catch (e) {
        // Never let the reporting path become a second failure.
    }
}

export function clearStartupError() {
    try {
        delete localStorage[STARTUP_ERROR_KEY];
    } catch (e) { }
}

export function readStartupError() {
    try {
        const stored = JSON.parse(localStorage[STARTUP_ERROR_KEY]);
        return stored && stored.message ? stored : null;
    } catch (e) {
        return null;
    }
}
