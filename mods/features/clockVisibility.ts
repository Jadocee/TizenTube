// When the clock is allowed on screen.
//
// It used to be "whenever the setting is on", which put it over the home page,
// the search results and the guide -- everywhere, permanently. It now shows only
// while a video is playing in the fullscreen watch player.
//
// THREE SIGNALS, BECAUSE "PLAYING" ALONE IS NOT "FULLSCREEN". A tile preview is
// also a video playing, through the same element, so playback on its own would
// put the clock back over the home page the moment focus rested on a tile.
//
//   watching   -- the route is a watch page. This is the one that means
//                 "fullscreen": leanback has no other full-screen player, and
//                 the hash is the app's own statement of where it is. It is the
//                 signal that cannot silently stop arriving, because hashchange
//                 is how every other route-aware part of this mod already works.
//   playing    -- the <video> reports playback rather than a paused or torn-down
//                 player.
//   previewing -- a tile preview is running, so whatever is playing is not the
//                 thing being watched. Belt and braces over the route: the watch
//                 page's own related shelf can preview too.
//
// Kept separate from clock.ts, and pure, because the interesting part is the
// state machine and the interesting failures are orderings: a preview that
// starts before the video reports playing, a stop that arrives after the player
// has already gone, a route change that beats both. Those are cheap to test here
// and expensive to test through the DOM.

/** Everything the clock knows about what the app is doing. */
export interface PlaybackState {
    /** The current route is a watch page -- the fullscreen player. */
    watching: boolean;
    /** The player reports a video playing rather than paused or empty. */
    playing: boolean;
    /** A tile preview is running, so whatever is playing is not fullscreen. */
    previewing: boolean;
}

export const HIDDEN: PlaybackState = { watching: false, playing: false, previewing: false };

export type PlaybackSignal =
    | 'play'
    | 'stop'
    | 'previewStart'
    | 'previewStop'
    | 'enterWatch'
    | 'leaveWatch';

/**
 * Folds one signal into the state.
 *
 * `stop` covers pause, end and teardown alike -- the clock does not distinguish
 * between them -- and it clears `previewing` as well as `playing`. That second
 * part is not tidiness, it is the failure mode: playbackPreview can only report
 * a preview ENDING when the shipped service still has a teardown to wrap (see
 * previewStopHooked()), and if it ever does not, a single preview would latch
 * `previewing` true and the clock would never be seen again. A player that has
 * stopped is not previewing by definition, so every pause re-floors the state
 * and the next video recovers on its own.
 *
 * Returns the same object when nothing changed, so callers can skip the DOM
 * write on the signals that are merely repeats -- and media events repeat a lot.
 */
export function reduce(state: PlaybackState, signal: PlaybackSignal): PlaybackState {
    switch (signal) {
        case 'play':
            return state.playing ? state : { ...state, playing: true };
        case 'stop':
            return state.playing || state.previewing
                ? { ...state, playing: false, previewing: false }
                : state;
        case 'previewStart':
            return state.previewing ? state : { ...state, previewing: true };
        case 'previewStop':
            return state.previewing ? { ...state, previewing: false } : state;
        case 'enterWatch':
            return state.watching ? state : { ...state, watching: true };
        case 'leaveWatch':
            return state.watching ? { ...state, watching: false } : state;
        default:
            return state;
    }
}

/**
 * Whether the clock should be on screen.
 *
 * A preview wins over playback rather than the other way round: the cost of
 * being wrong is a clock sitting over a thumbnail, which is the thing being
 * fixed, against a clock briefly missing from a video, which corrects itself on
 * the next signal.
 */
export function clockVisible(state: PlaybackState): boolean {
    return state.watching && state.playing && !state.previewing;
}

/**
 * Whether a location hash names a watch page.
 *
 * Matched on the `v=` parameter rather than on a `/watch` path, which is what
 * the rest of this mod already does -- sponsorblock.ts pulls the id out of
 * `location.hash` the same way, and captionRuntime.ts uses this exact pattern to
 * decide whether it is on a video at all. The app has shipped `#/watch?v=...`
 * and `#?v=...` at different times; the parameter has been there throughout.
 */
export function isWatchRoute(rawHash: string | null | undefined): boolean {
    if (typeof rawHash !== 'string') return false;
    return /[?&]v=[^&]/.test(rawHash);
}
