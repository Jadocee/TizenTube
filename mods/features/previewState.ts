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
    /** When the watchdog gives up on ever seeing stop(). */
    endsAt: number;
    anchored: boolean;
}

export const IDLE: PreviewState = {
    phase: 'idle',
    startedAt: 0,
    playingAt: 0,
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
                // The deadline covers the load as well as the playback, since
                // the app counts its duration from the frames it gets.
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
            return {
                ...state,
                phase: 'playing',
                playingAt: state.playingAt || now,
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
