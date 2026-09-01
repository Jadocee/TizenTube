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

export type Phase = 'idle' | 'playing' | 'stalled';

export interface PreviewState {
    phase: Phase;
    /** When the current preview started, in ms. */
    startedAt: number;
    /** When the watchdog gives up on ever seeing stop(). */
    endsAt: number;
    anchored: boolean;
}

export const IDLE: PreviewState = { phase: 'idle', startedAt: 0, endsAt: 0, anchored: false };

export type PreviewEvent =
    | { type: 'start'; now: number; durationMs: number; anchored: boolean }
    | { type: 'stop' }
    | { type: 'route' }
    | { type: 'move'; now: number }
    | { type: 'stall' }
    | { type: 'resume' }
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
                phase: 'playing',
                startedAt: now,
                endsAt: now + duration + WATCHDOG_SLACK_MS,
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
            return state.phase === 'playing' ? { ...state, phase: 'stalled' } : state;

        case 'resume':
            return state.phase === 'stalled' ? { ...state, phase: 'playing' } : state;

        case 'tick':
            return state.phase !== 'idle' && Number.isFinite(event.now) && event.now >= state.endsAt
                ? IDLE
                : state;

        default:
            return state;
    }
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
