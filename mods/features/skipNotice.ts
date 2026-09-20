// When a notice appears, and for how long.
//
// SponsorBlock used to announce its skips through YouTube's own
// overlayToastRenderer -- a dark card pinned to the TOP-RIGHT of the screen
// reading "SponsorBlock" over "Skipping Sponsor". (This comment used to call it
// a two-line banner in the bottom corner. main.css's `.ItllHd{z-index:98;
// position:absolute;right:0;top:0}` is the toast stage, so it is the top-right
// corner; corrected here rather than left to mislead the next reader.) That is
// the app's chrome, not this mod's, and it says the obvious thing twice: the
// user knows what SponsorBlock is, and the interesting word is the category.
//
// It is the mod's only on-screen message now, so the welcome goes through it
// too -- which is why the durations below are plural.
//
// NO IMPORTS, deliberately: test/refresh.mjs lifts this file verbatim, so the
// timing decisions are asserted in Node rather than by watching a television and
// counting. The DOM shell is in ui/skipNotice.ts.

/** How long a notice stays up. Long enough to read a two-word phrase at three
 *  metres, short enough that it is gone before it becomes furniture. */
export const NOTICE_DURATION_MS = 2600;

/**
 * How long the welcome stays up.
 *
 * Longer than a skip notice, because it is longer to read and it is the one
 * message that arrives with no event to explain it: a skip notice names
 * something the viewer just watched happen, while the welcome has to be read
 * cold. Sized against what it replaces rather than chosen -- YouTube's toast
 * gives its own 3000ms hint, and the app wraps that in a 400ms fade in and a
 * 700ms fade out WHEN its animation experiment is on, so the message it
 * replaces was on screen for roughly 3.2 to 4.1 seconds depending on a flag
 * this mod does not control. 5200ms sits above the top of that range, which is
 * the only way to be sure the message has not got shorter.
 *
 * A separate constant rather than a bigger NOTICE_DURATION_MS: test.mjs bounds
 * that one to 2000..4000 and requires COALESCE_WINDOW_MS to exceed it, and both
 * of those are about chained skips rather than about this.
 */
export const WELCOME_DURATION_MS = 5200;

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

/**
 * When a notice shown at `shownAt` should come down.
 *
 * The duration is DEFAULTED rather than required, so every existing two-argument
 * call -- and every assertion about them -- answers exactly as it did before a
 * second kind of notice existed.
 */
export function hidesAt(shownAt: number, durationMs: number = NOTICE_DURATION_MS): number {
    const span = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : NOTICE_DURATION_MS;
    return (Number.isFinite(shownAt) ? shownAt : 0) + span;
}

/**
 * How long from `now` until it should come down, never negative.
 *
 * Returned rather than computed at the call site because a re-shown notice has
 * to RESTART its timer from the new moment, and getting that subtraction the
 * wrong way round leaves a notice on screen for the rest of the video.
 */
export function remainingMs(
    shownAt: number,
    now: number,
    durationMs: number = NOTICE_DURATION_MS,
): number {
    const span = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : NOTICE_DURATION_MS;
    if (!Number.isFinite(now)) return span;
    const left = hidesAt(shownAt, span) - now;
    return left > 0 ? left : 0;
}
