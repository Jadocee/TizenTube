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
//                 "fullscreen", and the hash is the app's own statement of where
//                 it is. It cannot silently stop arriving, because hashchange is
//                 how every other route-aware part of this mod already works.
//                 KNOWN GAP: a Short is also a full-screen video, and the app
//                 writes no hash for it -- the reel player runs under "#/", the
//                 home route -- so the clock does not appear over Shorts. There
//                 is no route to test; telling a Short from the home page needs
//                 the player's own getVideoStats() reporting "shortspage", which
//                 is what preferredVideoQuality.ts does, and that is a poll
//                 rather than a signal. Left out deliberately rather than
//                 missed.
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
 * between them -- but it touches only `playing`. It used to clear `previewing`
 * too, as insurance against that flag latching, and that was wrong in the one
 * place it mattered: a preview loads into the SAME element, so its own source
 * swap fires `emptied` on the way in, after the synchronous previewStart. The
 * insurance therefore cancelled the suppression it was insuring, and the clock
 * came back over the preview -- the exact bug this file exists to prevent.
 *
 * `previewing` is instead cleared by the ROUTE, below, which is both the real
 * end of a preview and a signal that cannot go missing.
 *
 * Returns the same object when nothing changed, so callers can skip the DOM
 * write on the signals that are merely repeats -- and media events repeat a lot.
 */
export function reduce(state: PlaybackState, signal: PlaybackSignal): PlaybackState {
    switch (signal) {
        case 'play':
            return state.playing ? state : { ...state, playing: true };
        case 'stop':
            return state.playing ? { ...state, playing: false } : state;
        case 'previewStart':
            return state.previewing ? state : { ...state, previewing: true };
        case 'previewStop':
            return state.previewing ? { ...state, previewing: false } : state;
        // A route change ends any preview. This is not tidiness either: it is
        // how a preview that BECOMES the video actually ends. previewIndicator.ts
        // has the same line for the same reason -- "a preview that becomes a
        // full-screen watch changes the route without ever calling the teardown"
        // -- and previewState.ts maps its own `route` event straight to IDLE.
        // Without it, pressing OK on a tile that is previewing (the ordinary way
        // to start a video from the home page) arrives at the watch route with
        // `previewing` still true and nothing left that can clear it: the
        // teardown was never called, and a video playing straight through fires
        // no pause. The clock would be missing for the whole video.
        //
        // The `&& !state.previewing` conjunct is load-bearing. clock.ts skips the
        // DOM write when this returns the same object, so without it a
        // watch-to-watch hashchange would swallow the clear.
        case 'enterWatch':
            return state.watching && !state.previewing
                ? state
                : { ...state, watching: true, previewing: false };
        case 'leaveWatch':
            return !state.watching && !state.previewing
                ? state
                : { ...state, watching: false, previewing: false };
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
 * THE PATH FIRST, the parameter only as a fallback. Matching `v=` alone was the
 * obvious reading -- sponsorblock.ts pulls the id out of `location.hash` that
 * way and captionRuntime.ts uses the same pattern -- but those two want the
 * VIDEO ID, and this wants the PAGE. They come apart on a mix or a playlist,
 * where the app navigates to `/watch?list=RD...&index=0` with no `v` at all:
 * a full-screen watch page, playing, that the parameter test calls home. The
 * clock would have been missing for an entire playlist.
 *
 * Testing the path segment before the query is what keeps this from
 * false-positiving. The app's non-watch routes put their ids in the QUERY --
 * `#?c=FEwatch_later` is a browse page whose path is empty -- so a bare
 * `hash.includes('/watch')` would call the Watch Later shelf a video and the
 * split does not.
 */
export function isWatchRoute(rawHash: string | null | undefined): boolean {
    if (typeof rawHash !== 'string') return false;
    const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    if (hash.split('?')[0].includes('/watch')) return true;
    // The older bare-query form, kept because the app has shipped both.
    return /[?&]v=[^&]/.test(hash);
}
