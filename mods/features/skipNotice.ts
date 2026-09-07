// When the skip notice appears, and for how long.
//
// SponsorBlock used to announce its skips through YouTube's own
// overlayToastRenderer -- a two-line banner in the bottom corner reading
// "SponsorBlock" over "Skipping Sponsor". That is the app's chrome, not this
// mod's, and it says the obvious thing twice: the user knows what SponsorBlock
// is, and the interesting word is the category.
//
// NO IMPORTS, deliberately: test/refresh.mjs lifts this file verbatim, so the
// timing decisions are asserted in Node rather than by watching a television and
// counting. The DOM shell is in ui/skipNotice.ts.

/** How long a notice stays up. Long enough to read a two-word phrase at three
 *  metres, short enough that it is gone before it becomes furniture. */
export const NOTICE_DURATION_MS = 2600;

/** Chained segments fire in quick succession -- a sponsor followed by an
 *  interaction reminder is one continuous skip to the viewer. Within this
 *  window the same text does not restack; anything else replaces immediately,
 *  because the newer skip is the one that just happened. */
export const COALESCE_WINDOW_MS = 3000;

export interface NoticeState {
    /** What is on screen, or '' for nothing. */
    text: string;
    /** When it went up. */
    shownAt: number;
}

export const NONE: NoticeState = { text: '', shownAt: 0 };

/**
 * Whether this notice should be drawn.
 *
 * The coalescing is per-TEXT rather than global. A blanket "one notice per three
 * seconds" was the shape the old toast helper used, and applied here it would
 * swallow the second of two DIFFERENT skips -- which is the one case where the
 * user genuinely learns something from the second message.
 */
export function shouldShow(state: NoticeState, text: string, now: number): boolean {
    if (typeof text !== 'string' || text === '') return false;
    if (!state || !state.text) return true;
    if (!Number.isFinite(now)) return true;
    if (state.text !== text) return true;
    return now - state.shownAt >= COALESCE_WINDOW_MS;
}

/** When a notice shown at `shownAt` should come down. */
export function hidesAt(shownAt: number): number {
    return (Number.isFinite(shownAt) ? shownAt : 0) + NOTICE_DURATION_MS;
}

/**
 * How long from `now` until it should come down, never negative.
 *
 * Returned rather than computed at the call site because a re-shown notice has
 * to RESTART its timer from the new moment, and getting that subtraction the
 * wrong way round leaves a notice on screen for the rest of the video.
 */
export function remainingMs(shownAt: number, now: number): number {
    if (!Number.isFinite(now)) return NOTICE_DURATION_MS;
    const left = hidesAt(shownAt) - now;
    return left > 0 ? left : 0;
}
