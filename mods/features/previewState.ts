// Every decision the inline-preview indicator makes, as pure functions.
//
// NO IMPORTS, deliberately. test/refresh.mjs copies this file verbatim and the
// harness runs it as-is, so the parts that would otherwise only be debuggable
// by staring at a television -- an indicator stranded on screen after playback
// ended, one cancelled by the focus move that caused it, one drawn off the edge
// of a right-to-left layout -- are assertions in Node instead of a bug report
// from someone's living room.

/** The app stops the preview itself. This only bounds the case where stop()
 *  never arrives: an indicator left up forever is the worst outcome here, since
 *  it would claim a still thumbnail is playing. */
export const WATCHDOG_SLACK_MS = 5000;

/** Starting a preview moves focus as a side effect, and that focus event must
 *  not retire the indicator it just caused. Anything later than this is a real
 *  D-pad move by the user. */
export const MOVE_GRACE_MS = 250;

/** Anchor to the tile only once focus has been still. This gates WHERE the
 *  indicator is drawn, never whether playback happens. */
export const ANCHOR_SETTLE_MS = 400;

/** A box larger than this fraction of the viewport is a shelf or a page
 *  container, not a tile. */
export const MAX_ANCHOR_FRACTION = 0.6;
/** ...and one smaller than this is a collapsed or hidden element. */
export const MIN_ANCHOR_PX = 40;

/** SMPTE title-safe: 5% of each dimension, applied per axis. One number for all
 *  four edges is 42px looser than the standard horizontally at 16:9. */
export const SAFE_FRACTION = 0.05;

/** How far inside the tile's own top-left corner the indicator sits. Top-left
 *  because YouTube's own tile overlays -- the duration badge and the resume
 *  progress bar -- live along the bottom edge. */
export const ANCHOR_INSET_PX = 12;

/** How long to wait for a requested preview to actually start producing frames
 *  before giving up on it. The app asks for playback and the network answers, or
 *  does not; a spinner that never resolves is worse than no spinner, because it
 *  says "any moment now" forever. */
export const LOADING_TIMEOUT_MS = 12000;

/** How long after playback starts to keep believing a video is silent.
 *  Chromium reports decoded audio bytes only once it has decoded some, so the
 *  counter is legitimately 0 for the first frames of a video that does have
 *  sound. Below this the answer is "not yet known", not "silent". */
export const AUDIO_SETTLE_MS = 1200;

export type Phase = 'idle' | 'loading' | 'playing' | 'stalled';

export interface PreviewState {
    phase: Phase;
    /** When the current preview was REQUESTED, in ms. Not when it began playing
     *  -- those are different moments, and the gap between them is the whole
     *  reason the loading phase exists. */
    startedAt: number;
    /** When the first frame actually played, or 0 while still loading. */
    playingAt: number;
    /** What the app was asked to play for. Kept so the deadline can be recomputed
     *  from the moment playback actually began. */
    durationMs: number;
    /** When the watchdog gives up on ever seeing stop(). */
    endsAt: number;
    anchored: boolean;
}

export const IDLE: PreviewState = {
    phase: 'idle',
    startedAt: 0,
    playingAt: 0,
    durationMs: 0,
    endsAt: 0,
    anchored: false,
};

export type PreviewEvent =
    | { type: 'start'; now: number; durationMs: number; anchored: boolean }
    | { type: 'stop' }
    | { type: 'route' }
    | { type: 'move'; now: number }
    | { type: 'stall' }
    | { type: 'resume'; now: number }
    | { type: 'tick'; now: number };

/**
 * The whole state machine. Total: every unrecognised or malformed event returns
 * the state unchanged rather than throwing, because this runs off YouTube's own
 * callbacks and a throw here would take the wrapper with it.
 */
export function reduce(state: PreviewState, event: PreviewEvent | null | undefined): PreviewState {
    if (!state) return IDLE;
    if (!event || typeof (event as PreviewEvent).type !== 'string') return state;

    switch (event.type) {
        case 'start': {
            const now = Number.isFinite(event.now) ? event.now : 0;
            // A missing, zero or nonsense duration still has to produce a finite
            // deadline, or the watchdog never fires and the indicator is
            // permanent.
            const duration =
                Number.isFinite(event.durationMs) && event.durationMs > 0 ? event.durationMs : 0;
            return {
                // LOADING, not playing. start() is the app being ASKED to play;
                // frames arrive later, and on a television that gap is a real
                // wait rather than a formality. Claiming playback here is what
                // made a focused tile look identical whether the preview was
                // coming or had silently failed.
                phase: 'loading',
                startedAt: now,
                playingAt: 0,
                durationMs: duration,
                // Provisional, and covers the worst case: a load that takes the
                // full budget and then plays in full. It is REPLACED the moment
                // the first frame arrives -- see 'resume' -- because the app
                // counts its duration from the frames it gets, so leaving the
                // load budget in a deadline that starts at playback would let a
                // stranded mark outlive its preview by the whole 12 seconds.
                endsAt: now + LOADING_TIMEOUT_MS + duration + WATCHDOG_SLACK_MS,
                anchored: !!event.anchored,
            };
        }

        case 'move':
            // The focus change the app itself makes when it starts a preview
            // arrives immediately after start(). Retiring on that would mean the
            // indicator never survived its own first frame.
            if (
                state.phase !== 'idle' &&
                Number.isFinite(event.now) &&
                event.now - state.startedAt < MOVE_GRACE_MS
            ) {
                return state;
            }
            return IDLE;

        case 'stop':
        case 'route':
            return IDLE;

        case 'stall':
            // Only from playing. A stall while still loading is not new
            // information -- nothing has played yet, so the spinner is already
            // the right answer and swapping to a different one would flicker.
            return state.phase === 'playing' ? { ...state, phase: 'stalled' } : state;

        case 'resume': {
            if (state.phase === 'idle') return state;
            if (state.phase === 'playing') return state;
            const now = Number.isFinite(event.now) ? event.now : state.startedAt;
            // The first frame. This is the only transition out of loading, which
            // is what makes the spinner mean "waiting for video" rather than
            // "some time has passed".
            const playingAt = state.playingAt || now;
            return {
                ...state,
                phase: 'playing',
                playingAt,
                // Re-based on the first frame, dropping the load budget that has
                // now demonstrably not been needed. A preview that loaded
                // instantly kept a deadline 12s past the end of its own playback,
                // which is 12s of a mark claiming a still thumbnail is playing.
                endsAt: playingAt + state.durationMs + WATCHDOG_SLACK_MS,
            };
        }

        case 'tick': {
            if (state.phase === 'idle' || !Number.isFinite(event.now)) return state;
            // A preview that was asked for and never produced a frame. Without
            // this the spinner outlives the thing it describes, which is the one
            // outcome worse than showing nothing.
            if (state.phase === 'loading' && event.now - state.startedAt >= LOADING_TIMEOUT_MS) {
                return IDLE;
            }
            return event.now >= state.endsAt ? IDLE : state;
        }

        default:
            return state;
    }
}

/** What the mark should say about audio. */
export type SoundState = 'silent' | 'audible' | 'unknown';

export interface SoundInput {
    /** The media element's own muted flag. */
    muted?: boolean;
    /** ...and its volume, 0..1. */
    volume?: number;
    /** Chromium's decoded-audio byte counter, when the element exposes it.
     *  There is no standard "does this have an audio track", and this is the
     *  only honest signal M120 offers. */
    audioBytes?: number;
    /** ms since the first frame played. */
    playingForMs?: number;
}

/**
 * Whether a running preview is actually making a noise.
 *
 * Three answers, not two, and the third is the point. A speaker drawn on a
 * silent video is a worse error than no speaker at all -- it sends someone
 * hunting for audio that was never there -- so anything short of evidence
 * returns 'unknown' and the caller draws nothing.
 *
 * Muting is decided locally and is therefore certain: mutePreviews writes
 * `muted` into the app's own startInlinePlaybackCommand, and a muted or
 * zero-volume element is silent no matter what the file contains.
 *
 * The presence of an audio TRACK is not certain. Chromium counts decoded audio
 * bytes, but only once it has decoded some, so a zero counter in the first
 * moments of playback means "not yet" rather than "never" -- hence AUDIO_SETTLE_MS.
 * On a build that does not expose the counter at all, an unmuted element is
 * reported audible: the mod asked for sound and the element is not suppressing
 * it, which is the best claim available and the one that is right for the
 * overwhelming majority of videos.
 */
/**
 * When the app will stop this preview, or null when that cannot be said.
 *
 * THE BASE IS THE REQUEST, NOT THE FIRST FRAME, and an earlier version of this
 * file had that backwards. The shipped bundle arms the stop like this, inside
 * the preview service's own start():
 *
 *   Hlb=function(a,b,c,d,e,f){ ... _.E("deferInlineFadeOut",!1)
 *     ? a.wa=a.J.onStateChange(function(g){g===1&&( ... a.I=setTimeout(...,e) ...)})
 *     : (_.Ilb(a,c,b.fadeoutDurationMs,f), e&&e>0&&(a.I=setTimeout(function(){
 *         a.J.stop();a.I=0;_.gL(a)},e))) ... }
 *
 * Two branches. Only the first -- behind the server flag `deferInlineFadeOut`,
 * which defaults to false and is ABSENT from the EXPERIMENT_FLAGS blob tv.html
 * ships -- waits for playback state 1 before arming the timer. The branch this
 * device takes arms it immediately, so the preview dies `durationMs` after it
 * was ASKED for and the load latency comes out of the preview, not out of thin
 * air. Measuring from the frame that arrived therefore over-reported by exactly
 * the load time: the countdown read "0:02" at the moment the preview stopped.
 *
 * Under-promising is the safe direction for both readouts, which is why this
 * stays on the request base even though the flag could in principle be on: a
 * countdown that reaches zero a moment early is a much smaller lie than one that
 * is still promising time after the frames have gone.
 *
 * Null, not zero, when the answer is unknown: while loading nothing has started
 * so there is nothing to count, and a preview whose duration came through as 0
 * or nonsense (see `start`) has no length to count down. A readout that invents
 * a number is worse than one that is absent, which is why this file's own
 * stylesheet argued against a countdown at all -- the answer to that objection
 * is this function, not a guess.
 */
export function previewEndsAt(state: PreviewState): number | null {
    if (!state) return null;
    if (state.phase !== 'playing' && state.phase !== 'stalled') return null;
    // Finite, not positive. A preview requested at timestamp 0 is unreachable on
    // a television and perfectly reachable in a harness with a fake clock, and
    // the phase check above has already excluded IDLE -- which is the only thing
    // a `> 0` guard would have been protecting against. Duration is the opposite
    // case: zero there genuinely means "the app gave us no length", so it stays.
    if (!Number.isFinite(state.startedAt) || !(state.durationMs > 0)) return null;
    return state.startedAt + state.durationMs;
}

/**
 * Milliseconds of preview left, or null when there is nothing honest to say.
 *
 * NOT `endsAt - now`. endsAt is the WATCHDOG deadline and carries
 * WATCHDOG_SLACK_MS on top of the real end, so counting down to it would sit at
 * "5s" for five seconds after the preview had visibly stopped.
 */
export function remainingMs(state: PreviewState, now: number): number | null {
    const ends = previewEndsAt(state);
    if (ends === null || !Number.isFinite(now)) return null;
    const left = ends - now;
    return left > 0 ? left : 0;
}

export interface ProgressInput {
    /** The media element's position, in seconds. */
    currentTime?: number;
    /** Where this preview began, in seconds. The app takes it from the
     *  endpoint's startTimeSeconds; the mod samples it off the first frame,
     *  which is the same number and also survives `resumeVideo`. */
    startTime?: number;
    /** The window the app was asked to play, in ms. */
    durationMs?: number;
}

/**
 * How far through the preview the video has got, 0..1, or null.
 *
 * THIS IS THE APP'S OWN FORMULA, and it is transcribed rather than invented,
 * because the ask was for the bar the official client draws. The shipped bundle
 * has a progress-overlay-view-model whose onProgressChange handler reads:
 *
 *   c = (c = inlinePlaybackCommand?.durationMs) && c > 0 ? c/1E3
 *                                                       : Math.max(0, b.duration - e);
 *   b = c > 0 ? Math.min(100, Math.max(0, Math.max(0, b.current - e) / c * 100)) : 0
 *
 * where `e` is the endpoint's startTimeSeconds and `b.current` the player's
 * position. So the official bar is MEDIA TIME over the requested window, not
 * wall clock over it -- it stops when the picture stops, which is what a
 * progress bar means and what someone watching a stuttering preview expects to
 * see. That component is server-gated (it needs a progressOverlayViewModel in
 * the tile's thumbnailOverlays carrying PROGRESS_BAR_STYLE_PLAYER and
 * DURATION_SOURCE_PREVIEW_PLAYBACK_DURATION) and does not arrive on this
 * surface, which is why the mod draws the same bar itself.
 *
 * Null, not zero, when there is nothing to say: no reading off the element, or
 * no usable duration to divide by. A bar that sits at zero claims the preview
 * has not started; a bar that is absent claims nothing.
 */
export function progressFraction(input: ProgressInput | null | undefined): number | null {
    if (!input) return null;
    const current = input.currentTime;
    const span = input.durationMs;
    if (!Number.isFinite(current as number)) return null;
    if (!Number.isFinite(span as number) || !((span as number) > 0)) return null;
    const start = Number.isFinite(input.startTime as number) ? (input.startTime as number) : 0;
    // Math.max over the numerator, exactly as the app does it: a player that
    // reports a position before the origin -- a seek, a resumed video whose
    // first frame landed late -- must read as "not started", never as a
    // negative scale that flips the bar through its own origin.
    const done = Math.max(0, (current as number) - start) / ((span as number) / 1000);
    return done > 1 ? 1 : done;
}

/**
 * The countdown as it is drawn: m:ss.
 *
 * Ceil rather than round, so a preview with 200ms left reads "0:01" and reaches
 * "0:00" only when it is actually over -- a readout that hits zero while frames
 * are still arriving is the one error a countdown cannot afford.
 */
export function formatRemaining(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const total = Math.ceil(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function soundState(input: SoundInput | null | undefined): SoundState {
    if (!input) return 'unknown';
    if (input.muted === true) return 'silent';
    if (Number.isFinite(input.volume as number) && (input.volume as number) <= 0) return 'silent';
    // Not yet known to be unmuted either -- an element we could not read.
    if (input.muted !== false) return 'unknown';

    const bytes = input.audioBytes;
    if (!Number.isFinite(bytes as number)) return 'audible';
    if ((bytes as number) > 0) return 'audible';

    const playedFor = input.playingForMs;
    // Zero bytes, but too early to conclude anything from that.
    if (!Number.isFinite(playedFor as number) || (playedFor as number) < AUDIO_SETTLE_MS) {
        return 'unknown';
    }
    return 'silent';
}

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Size {
    width: number;
    height: number;
}

/**
 * Whether a measured box is plausibly the tile that is previewing.
 *
 * A rejection costs the title-safe corner instead of an anchored indicator. It
 * never costs a broken layout, and it never suppresses playback -- which is why
 * this can afford to be strict.
 */
export function anchorUsable(
    rect: Rect | null | undefined,
    viewport: Size | null | undefined,
): boolean {
    if (!rect || !viewport) return false;
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return false;
    if (!(viewport.width > 0) || !(viewport.height > 0)) return false;
    if (rect.width < MIN_ANCHOR_PX || rect.height < MIN_ANCHOR_PX) return false;
    if (rect.width > viewport.width * MAX_ANCHOR_FRACTION) return false;
    if (rect.height > viewport.height * MAX_ANCHOR_FRACTION) return false;
    return true;
}

/**
 * Where the indicator goes, in PHYSICAL viewport pixels.
 *
 * Physical, never logical. The element is appended to document.body and
 * inherits the app's direction, which is right-to-left whenever the account
 * language is Arabic -- so an inset-inline-start plus a positive offset lands it
 * off the opposite edge. clock.css records the same trap, found the same way.
 *
 * The result is always fully on screen: a tile at the extreme right edge still
 * yields a box inside the viewport rather than one hanging off it.
 */
export function chipOrigin(
    rect: Rect | null | undefined,
    viewport: Size,
    chip: Size,
): { x: number; y: number } {
    const width = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
    const height = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
    const chipW = chip && Number.isFinite(chip.width) ? chip.width : 0;
    const chipH = chip && Number.isFinite(chip.height) ? chip.height : 0;
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(v, Math.max(0, hi)));

    if (anchorUsable(rect, { width, height })) {
        return {
            x: clamp(Math.round(rect!.left + ANCHOR_INSET_PX), width - chipW),
            y: clamp(Math.round(rect!.top + ANCHOR_INSET_PX), height - chipH),
        };
    }

    // Bottom-right of the title-safe box, per axis.
    return {
        x: clamp(Math.round(width * (1 - SAFE_FRACTION) - chipW), width - chipW),
        y: clamp(Math.round(height * (1 - SAFE_FRACTION) - chipH), height - chipH),
    };
}

/**
 * Where the progress bar goes, given the box the preview is playing in.
 *
 * `y` is the bar's BOTTOM edge, not its top, so this function never has to know
 * how thick the bar is -- the stylesheet owns that, and a thickness duplicated
 * here would be a second place to change it and a second place to get it wrong.
 * previewIndicator.css lands the element on that edge with a translateY(-100%).
 *
 * Flush with the bottom of the box, because that is where the app pins its own
 * preview progress bar: `.Ubdfj{bottom:0;display:block;left:0;position:absolute;
 * right:0}`, the host of the progress-overlay-view-model this one copies. Its
 * WATCHED bar, `.y2FKY`, is pinned to the same edge -- that is the bar this one
 * is knowingly drawn over while a preview is playing, not the one it imitates.
 *
 * The box is CLIPPED to the viewport rather than merely clamped. A tile half off
 * the left edge of a shelf is an ordinary sight on this app, and a bar that kept
 * its full width would either hang off the screen or -- once the origin was
 * clamped to 0 -- run further right than the tile it describes, which is a
 * progress bar that lies about its own scale.
 *
 * Null when the box is not plausibly a tile. anchorUsable rejects the
 * full-screen player, which is the case that matters: a preview adopted into
 * the watch page has no tile to draw on, and a bar across the bottom of a
 * full-screen video would read as the video's own progress.
 */
export function barBox(
    rect: Rect | null | undefined,
    viewport: Size,
): { x: number; y: number; width: number } | null {
    const width = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
    const height = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
    if (!anchorUsable(rect, { width, height })) return null;

    const left = Math.max(0, rect!.left);
    const right = Math.min(width, rect!.left + rect!.width);
    const visible = right - left;
    // Entirely off one side. Clamping would put a full-width bar at x=0, which
    // is worse than no bar: it would describe a tile that is not there.
    if (!(visible > 0)) return null;

    return {
        x: Math.round(left),
        y: Math.round(Math.max(0, Math.min(rect!.top + rect!.height, height))),
        width: Math.round(visible),
    };
}

/**
 * Whether focus has been still long enough for its box to be worth measuring.
 *
 * A session in which no move has ever been seen (lastMoveAt 0) anchors: the
 * failure mode of never anchoring is worse than that of anchoring to a box that
 * turns out to be the wrong size, which anchorUsable catches anyway.
 */
export function shouldAnchor(lastMoveAt: number, now: number): boolean {
    if (!Number.isFinite(lastMoveAt) || lastMoveAt <= 0) return true;
    if (!Number.isFinite(now)) return true;
    // A clock that went backwards yields a negative difference; treat that as
    // "not settled" rather than as an enormous one.
    const since = now - lastMoveAt;
    return since >= ANCHOR_SETTLE_MS;
}
